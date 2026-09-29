'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { fail, hash, id, secret } = require('./store');

const schema = 'antartalk_video';
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const millis = value => Number(value || 0);

class PostgresCallStore {
    constructor(databaseUrl, now = Date.now, options = {}) {
        this.now = now;
        this.pool = options.pool || new Pool({ connectionString: databaseUrl, max: 10 });
        this.ownsPool = !options.pool;
    }
    async initialize() {
        const migration = await readFile(path.resolve(__dirname, '../migrations/001_video_store.sql'), 'utf8');
        await this.pool.query(migration);
        // A process restart closes all signaling sockets. Stale live flags must never
        // be treated as current presence; completed intervals were persisted on leave.
        await this.pool.query(`UPDATE ${schema}.attendance SET connected = false, last_joined_at = NULL WHERE connected = true;
            UPDATE ${schema}.sessions SET overlap_started_at = NULL WHERE overlap_started_at IS NOT NULL;`);
        return this;
    }
    async transaction(work) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }
    normalizeSession(row) {
        return {
            id: row.id,
            appointmentId: row.appointment_id,
            doctorId: row.doctor_id,
            clientId: row.client_id,
            opensAt: new Date(row.opens_at),
            closesAt: new Date(row.closes_at),
            state: row.state,
            createdAt: new Date(row.created_at),
            endedAt: row.ended_at ? new Date(row.ended_at) : null,
            overlapStartedAt: row.overlap_started_at ? new Date(row.overlap_started_at) : null,
            overlapMs: millis(row.overlap_ms)
        };
    }
    async create(input) {
        const appointmentId = id(input?.appointmentId, 'appointmentId');
        const doctorId = id(input?.doctorId, 'doctorId');
        const clientId = id(input?.clientId, 'clientId');
        const opensAt = timestamp(input.opensAt);
        const closesAt = timestamp(input.closesAt);
        if (doctorId === clientId || !Number.isFinite(opensAt) || !Number.isFinite(closesAt) ||
            closesAt <= opensAt || closesAt - opensAt > 12 * 3600_000) {
            fail(400, 'INVALID_INPUT', 'Use distinct participants and an ISO date window of at most 12 hours.');
        }
        if (closesAt <= this.now()) fail(400, 'INVALID_INPUT', 'The joining window has already ended.');
        return this.transaction(async client => {
            const inserted = await client.query(`INSERT INTO ${schema}.sessions
                (id, appointment_id, doctor_id, client_id, opens_at, closes_at, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (appointment_id) DO NOTHING RETURNING *`,
            [randomUUID(), appointmentId, doctorId, clientId, new Date(opensAt), new Date(closesAt), new Date(this.now())]);
            if (inserted.rowCount) return { created: true, session: await this.describe(this.normalizeSession(inserted.rows[0]), client) };
            const existing = await client.query(`SELECT * FROM ${schema}.sessions WHERE appointment_id = $1 FOR UPDATE`, [appointmentId]);
            const session = this.normalizeSession(existing.rows[0]);
            if (session.doctorId !== doctorId || session.clientId !== clientId ||
                session.opensAt.getTime() !== opensAt || session.closesAt.getTime() !== closesAt) {
                fail(409, 'APPOINTMENT_CONFLICT', 'This appointment already has a different call configuration.');
            }
            return { created: false, session: await this.describe(session, client) };
        });
    }
    async row(sessionId, client = this.pool, lock = false) {
        const result = await client.query(`SELECT * FROM ${schema}.sessions WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id(sessionId, 'sessionId')]);
        if (!result.rowCount) fail(404, 'NOT_FOUND', 'Call session not found.');
        return this.normalizeSession(result.rows[0]);
    }
    async describe(session, client = this.pool) {
        const result = await client.query(`SELECT * FROM ${schema}.attendance WHERE session_id = $1`, [session.id]);
        const byRole = new Map(result.rows.map(row => [row.role, row]));
        const attendance = Object.fromEntries(['doctor', 'client'].map(role => {
            const row = byRole.get(role);
            const lastJoinedAt = row?.last_joined_at ? new Date(row.last_joined_at).getTime() : null;
            const liveMs = row?.connected && lastJoinedAt ? Math.max(0, this.now() - lastJoinedAt) : 0;
            return [role, {
                joined: Boolean(row?.first_joined_at),
                firstJoinedAt: row?.first_joined_at ? new Date(row.first_joined_at).toISOString() : null,
                lastLeftAt: row?.last_left_at ? new Date(row.last_left_at).toISOString() : null,
                connectedSeconds: Math.floor((millis(row?.total_connected_ms) + liveMs) / 1000),
                joinCount: Number(row?.join_count || 0),
                connected: Boolean(row?.connected)
            }];
        }));
        const liveOverlap = session.overlapStartedAt ? Math.max(0, this.now() - session.overlapStartedAt.getTime()) : 0;
        return {
            ...session,
            state: session.state !== 'open' ? session.state :
                this.now() >= session.closesAt.getTime() ? 'expired' : this.now() < session.opensAt.getTime() ? 'scheduled' : 'open',
            opensAt: session.opensAt.toISOString(),
            closesAt: session.closesAt.toISOString(),
            createdAt: session.createdAt.toISOString(),
            endedAt: session.endedAt ? session.endedAt.toISOString() : null,
            attendance: { ...attendance, overlapSeconds: Math.floor((session.overlapMs + liveOverlap) / 1000) }
        };
    }
    async get(sessionId) { return this.describe(await this.row(sessionId)); }
    assertOpen(session) {
        if (session.state !== 'open' || this.now() >= session.closesAt.getTime()) fail(410, 'SESSION_CLOSED', 'This call has ended.');
        if (this.now() < session.opensAt.getTime()) fail(403, 'TOO_EARLY', 'This call is not open yet.');
    }
    async ticket(sessionId, userId) {
        id(userId, 'userId');
        return this.transaction(async client => {
            const session = await this.row(sessionId, client, true);
            if (userId !== session.doctorId && userId !== session.clientId) fail(403, 'NOT_PARTICIPANT', 'User is not assigned to this call.');
            this.assertOpen(session);
            await client.query(`DELETE FROM ${schema}.credentials WHERE session_id = $1 AND user_id = $2 AND kind = 'ticket'`, [sessionId, userId]);
            await client.query(`DELETE FROM ${schema}.credentials WHERE expires_at <= $1`, [new Date(this.now())]);
            const ticket = secret();
            const expiresAt = Math.min(this.now() + 60_000, session.closesAt.getTime());
            await client.query(`INSERT INTO ${schema}.credentials (digest, session_id, user_id, kind, expires_at)
                VALUES ($1, $2, $3, 'ticket', $4)`, [hash(ticket), sessionId, userId, new Date(expiresAt)]);
            return { ticket, expiresAt: new Date(expiresAt).toISOString() };
        });
    }
    async credential(token, kind, client = this.pool, lock = false) {
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'INVALID_CREDENTIAL', 'Call access is invalid or expired.');
        const result = await client.query(`SELECT * FROM ${schema}.credentials WHERE digest = $1 AND kind = $2${lock ? ' FOR UPDATE' : ''}`, [hash(token), kind]);
        const credential = result.rows[0];
        if (!credential || new Date(credential.expires_at).getTime() <= this.now()) fail(401, 'INVALID_CREDENTIAL', 'Call access is invalid or expired.');
        const session = await this.row(credential.session_id, client, lock);
        this.assertOpen(session);
        return { digest: credential.digest, sessionId: credential.session_id, userId: credential.user_id,
            kind: credential.kind, expiresAt: new Date(credential.expires_at), session,
            role: credential.user_id === session.doctorId ? 'doctor' : 'client' };
    }
    async exchange(ticket) {
        return this.transaction(async client => {
            const claim = await this.credential(ticket, 'ticket', client, true);
            await client.query(`DELETE FROM ${schema}.credentials WHERE session_id = $1 AND user_id = $2`, [claim.sessionId, claim.userId]);
            const token = secret();
            await client.query(`INSERT INTO ${schema}.credentials (digest, session_id, user_id, kind, expires_at)
                VALUES ($1, $2, $3, 'connection', $4)`, [hash(token), claim.sessionId, claim.userId, claim.session.closesAt]);
            return { token, sessionId: claim.sessionId, role: claim.role, expiresAt: claim.session.closesAt.toISOString() };
        });
    }
    async presence(sessionId, role, connected) {
        if (!['doctor', 'client'].includes(role)) fail(400, 'INVALID_INPUT', 'Invalid participant role.');
        return this.transaction(async client => {
            const session = await this.row(sessionId, client, true);
            const now = new Date(this.now());
            await client.query(`INSERT INTO ${schema}.attendance (session_id, role) VALUES ($1, $2)
                ON CONFLICT (session_id, role) DO NOTHING`, [sessionId, role]);
            const selected = await client.query(`SELECT * FROM ${schema}.attendance WHERE session_id = $1 AND role = $2 FOR UPDATE`, [sessionId, role]);
            const row = selected.rows[0];
            if (connected && !row.connected) {
                await client.query(`UPDATE ${schema}.attendance SET connected = true,
                    first_joined_at = COALESCE(first_joined_at, $1), last_joined_at = $1, join_count = join_count + 1
                    WHERE session_id = $2 AND role = $3`, [now, sessionId, role]);
            } else if (!connected && row.connected) {
                const connectedMs = Math.max(0, now.getTime() - new Date(row.last_joined_at).getTime());
                await client.query(`UPDATE ${schema}.attendance SET connected = false, last_left_at = $1,
                    total_connected_ms = total_connected_ms + $2, last_joined_at = NULL
                    WHERE session_id = $3 AND role = $4`, [now, connectedMs, sessionId, role]);
            }
            const count = await client.query(`SELECT COUNT(*)::integer AS count FROM ${schema}.attendance WHERE session_id = $1 AND connected = true`, [sessionId]);
            if (count.rows[0].count === 2 && session.overlapStartedAt === null) {
                await client.query(`UPDATE ${schema}.sessions SET overlap_started_at = $1 WHERE id = $2`, [now, sessionId]);
            } else if (count.rows[0].count < 2 && session.overlapStartedAt !== null) {
                const overlapMs = Math.max(0, now.getTime() - session.overlapStartedAt.getTime());
                await client.query(`UPDATE ${schema}.sessions SET overlap_ms = overlap_ms + $1,
                    overlap_started_at = NULL WHERE id = $2`, [overlapMs, sessionId]);
            }
            return (await this.getWithClient(sessionId, client)).attendance;
        });
    }
    async getWithClient(sessionId, client) { return this.describe(await this.row(sessionId, client), client); }
    async end(sessionId, state) {
        if (!['ended', 'cancelled'].includes(state)) fail(400, 'INVALID_INPUT', 'State must be ended or cancelled.');
        return this.transaction(async client => {
            const session = await this.row(sessionId, client, true);
            const now = new Date(this.now());
            const connected = await client.query(`SELECT role, last_joined_at FROM ${schema}.attendance
                WHERE session_id = $1 AND connected = true FOR UPDATE`, [sessionId]);
            for (const row of connected.rows) {
                const connectedMs = row.last_joined_at ? Math.max(0, now.getTime() - new Date(row.last_joined_at).getTime()) : 0;
                await client.query(`UPDATE ${schema}.attendance SET connected = false, last_left_at = $1,
                    total_connected_ms = total_connected_ms + $2, last_joined_at = NULL
                    WHERE session_id = $3 AND role = $4`, [now, connectedMs, sessionId, row.role]);
            }
            if (session.overlapStartedAt !== null) {
                const overlapMs = Math.max(0, now.getTime() - session.overlapStartedAt.getTime());
                await client.query(`UPDATE ${schema}.sessions SET overlap_ms = overlap_ms + $1,
                    overlap_started_at = NULL WHERE id = $2`, [overlapMs, sessionId]);
            }
            await client.query(`UPDATE ${schema}.sessions SET state = $1, ended_at = $2 WHERE id = $3 AND state = 'open'`, [state, now, sessionId]);
            await client.query(`DELETE FROM ${schema}.credentials WHERE session_id = $1`, [sessionId]);
            return this.getWithClient(sessionId, client);
        });
    }
    async ping() { await this.pool.query('SELECT 1'); }
    async close() { if (this.ownsPool) await this.pool.end(); }
}

module.exports = { PostgresCallStore };
