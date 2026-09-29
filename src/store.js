'use strict';

const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

class CallError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
const fail = (status, code, message) => { throw new CallError(status, code, message); };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const id = (value, field) => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
        fail(400, 'INVALID_INPUT', `${field} must contain 1–128 letters, numbers, underscores or hyphens.`);
    }
    return value;
};

class CallStore {
    constructor(filename, now = Date.now) {
        if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
        this.now = now;
        this.db = new DatabaseSync(filename);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, appointmentId TEXT NOT NULL UNIQUE,
                doctorId TEXT NOT NULL, clientId TEXT NOT NULL,
                opensAt INTEGER NOT NULL, closesAt INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'open', createdAt INTEGER NOT NULL,
                endedAt INTEGER
            );
            CREATE TABLE IF NOT EXISTS credentials (
                digest TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
                userId TEXT NOT NULL, kind TEXT NOT NULL, expiresAt INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS credentials_session ON credentials(sessionId, userId, kind);
            CREATE TABLE IF NOT EXISTS attendance (
                sessionId TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL,
                firstJoinedAt INTEGER, lastJoinedAt INTEGER, lastLeftAt INTEGER,
                totalConnectedMs INTEGER NOT NULL DEFAULT 0, joinCount INTEGER NOT NULL DEFAULT 0,
                connected INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (sessionId, role), CHECK (role IN ('doctor', 'client'))
            );
        `);
        const columns = new Set(this.db.prepare('PRAGMA table_info(sessions)').all().map(column => column.name));
        if (!columns.has('overlapStartedAt')) this.db.exec('ALTER TABLE sessions ADD COLUMN overlapStartedAt INTEGER');
        if (!columns.has('overlapMs')) this.db.exec('ALTER TABLE sessions ADD COLUMN overlapMs INTEGER NOT NULL DEFAULT 0');
        // A process restart closes any in-memory signaling connections. Never carry stale presence forward.
        this.db.exec('UPDATE attendance SET connected = 0, lastJoinedAt = NULL; UPDATE sessions SET overlapStartedAt = NULL;');
    }
    transaction(work) {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = work(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    create(input) {
        const appointmentId = id(input?.appointmentId, 'appointmentId');
        const doctorId = id(input?.doctorId, 'doctorId');
        const clientId = id(input?.clientId, 'clientId');
        const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
        const opensAt = timestamp(input.opensAt);
        const closesAt = timestamp(input.closesAt);
        if (doctorId === clientId || !Number.isFinite(opensAt) || !Number.isFinite(closesAt) ||
            closesAt <= opensAt || closesAt - opensAt > 12 * 3600_000) {
            fail(400, 'INVALID_INPUT', 'Use distinct participants and an ISO date window of at most 12 hours.');
        }
        return this.transaction(() => {
            const existing = this.db.prepare('SELECT * FROM sessions WHERE appointmentId = ?').get(appointmentId);
            if (existing) {
                if (existing.doctorId !== doctorId || existing.clientId !== clientId ||
                    existing.opensAt !== opensAt || existing.closesAt !== closesAt) {
                    fail(409, 'APPOINTMENT_CONFLICT', 'This appointment already has a different call configuration.');
                }
                return { created: false, session: this.describe(existing) };
            }
            if (closesAt <= this.now()) fail(400, 'INVALID_INPUT', 'The joining window has already ended.');
            const sessionId = randomUUID();
            this.db.prepare(`INSERT INTO sessions
                (id, appointmentId, doctorId, clientId, opensAt, closesAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(sessionId, appointmentId, doctorId, clientId, opensAt, closesAt, this.now());
            return { created: true, session: this.get(sessionId) };
        });
    }
    row(sessionId) {
        const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id(sessionId, 'sessionId'));
        if (!session) fail(404, 'NOT_FOUND', 'Call session not found.');
        return session;
    }
    describe(session) {
        const attendance = Object.fromEntries(['doctor', 'client'].map(role => {
            const row = this.db.prepare('SELECT * FROM attendance WHERE sessionId = ? AND role = ?').get(session.id, role);
            const liveMs = row?.connected && row.lastJoinedAt ? Math.max(0, this.now() - row.lastJoinedAt) : 0;
            return [role, {
                joined: Boolean(row?.firstJoinedAt),
                firstJoinedAt: row?.firstJoinedAt ? new Date(row.firstJoinedAt).toISOString() : null,
                lastLeftAt: row?.lastLeftAt ? new Date(row.lastLeftAt).toISOString() : null,
                connectedSeconds: Math.floor(((row?.totalConnectedMs || 0) + liveMs) / 1000),
                joinCount: row?.joinCount || 0,
                connected: Boolean(row?.connected)
            }];
        }));
        const liveOverlap = session.overlapStartedAt ? Math.max(0, this.now() - session.overlapStartedAt) : 0;
        return { ...session, state: session.state !== 'open' ? session.state :
            this.now() >= session.closesAt ? 'expired' : this.now() < session.opensAt ? 'scheduled' : 'open',
            opensAt: new Date(session.opensAt).toISOString(), closesAt: new Date(session.closesAt).toISOString(),
            createdAt: new Date(session.createdAt).toISOString(),
            endedAt: session.endedAt === null ? null : new Date(session.endedAt).toISOString(),
            attendance: { ...attendance, overlapSeconds: Math.floor(((session.overlapMs || 0) + liveOverlap) / 1000) } };
    }
    get(sessionId) { return this.describe(this.row(sessionId)); }
    assertOpen(session) {
        if (session.state !== 'open' || this.now() >= session.closesAt) fail(410, 'SESSION_CLOSED', 'This call has ended.');
        if (this.now() < session.opensAt) fail(403, 'TOO_EARLY', 'This call is not open yet.');
    }
    ticket(sessionId, userId) {
        id(userId, 'userId');
        return this.transaction(() => {
            const session = this.row(sessionId);
            if (userId !== session.doctorId && userId !== session.clientId) fail(403, 'NOT_PARTICIPANT', 'User is not assigned to this call.');
            this.assertOpen(session);
            this.db.prepare("DELETE FROM credentials WHERE sessionId = ? AND userId = ? AND kind = 'ticket'").run(sessionId, userId);
            this.db.prepare('DELETE FROM credentials WHERE expiresAt <= ?').run(this.now());
            const ticket = secret();
            const expiresAt = Math.min(this.now() + 60_000, session.closesAt);
            this.db.prepare('INSERT INTO credentials VALUES (?, ?, ?, ?, ?)').run(hash(ticket), sessionId, userId, 'ticket', expiresAt);
            return { ticket, expiresAt: new Date(expiresAt).toISOString() };
        });
    }
    credential(token, kind) {
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'INVALID_CREDENTIAL', 'Call access is invalid or expired.');
        const credential = this.db.prepare('SELECT * FROM credentials WHERE digest = ? AND kind = ?').get(hash(token), kind);
        if (!credential || credential.expiresAt <= this.now()) fail(401, 'INVALID_CREDENTIAL', 'Call access is invalid or expired.');
        const session = this.row(credential.sessionId);
        this.assertOpen(session);
        return { ...credential, session, role: credential.userId === session.doctorId ? 'doctor' : 'client' };
    }
    exchange(ticket) {
        return this.transaction(() => {
            const claim = this.credential(ticket, 'ticket');
            this.db.prepare('DELETE FROM credentials WHERE sessionId = ? AND userId = ?').run(claim.sessionId, claim.userId);
            const token = secret();
            this.db.prepare('INSERT INTO credentials VALUES (?, ?, ?, ?, ?)')
                .run(hash(token), claim.sessionId, claim.userId, 'connection', claim.session.closesAt);
            return { token, sessionId: claim.sessionId, role: claim.role, expiresAt: new Date(claim.session.closesAt).toISOString() };
        });
    }
    presence(sessionId, role, connected) {
        if (!['doctor', 'client'].includes(role)) fail(400, 'INVALID_INPUT', 'Invalid participant role.');
        return this.transaction(() => {
            const session = this.row(sessionId);
            const now = this.now();
            this.db.prepare(`INSERT INTO attendance (sessionId, role) VALUES (?, ?)
                ON CONFLICT(sessionId, role) DO NOTHING`).run(sessionId, role);
            const row = this.db.prepare('SELECT * FROM attendance WHERE sessionId = ? AND role = ?').get(sessionId, role);
            if (connected && !row.connected) {
                this.db.prepare(`UPDATE attendance SET connected = 1,
                    firstJoinedAt = COALESCE(firstJoinedAt, ?), lastJoinedAt = ?, joinCount = joinCount + 1
                    WHERE sessionId = ? AND role = ?`).run(now, now, sessionId, role);
            } else if (!connected && row.connected) {
                this.db.prepare(`UPDATE attendance SET connected = 0, lastLeftAt = ?,
                    totalConnectedMs = totalConnectedMs + MAX(0, ? - lastJoinedAt), lastJoinedAt = NULL
                    WHERE sessionId = ? AND role = ?`).run(now, now, sessionId, role);
            }
            const connectedCount = this.db.prepare('SELECT COUNT(*) count FROM attendance WHERE sessionId = ? AND connected = 1').get(sessionId).count;
            if (connectedCount === 2 && session.overlapStartedAt === null) {
                this.db.prepare('UPDATE sessions SET overlapStartedAt = ? WHERE id = ?').run(now, sessionId);
            } else if (connectedCount < 2 && session.overlapStartedAt !== null) {
                this.db.prepare('UPDATE sessions SET overlapMs = overlapMs + MAX(0, ? - overlapStartedAt), overlapStartedAt = NULL WHERE id = ?').run(now, sessionId);
            }
            return this.get(sessionId).attendance;
        });
    }
    end(sessionId, state) {
        if (!['ended', 'cancelled'].includes(state)) fail(400, 'INVALID_INPUT', 'State must be ended or cancelled.');
        return this.transaction(() => {
            const session = this.row(sessionId);
            const now = this.now();
            this.db.prepare(`UPDATE attendance SET connected = 0, lastLeftAt = ?,
                totalConnectedMs = totalConnectedMs + CASE WHEN lastJoinedAt IS NULL THEN 0 ELSE MAX(0, ? - lastJoinedAt) END,
                lastJoinedAt = NULL WHERE sessionId = ? AND connected = 1`).run(now, now, sessionId);
            if (session.overlapStartedAt !== null) {
                this.db.prepare('UPDATE sessions SET overlapMs = overlapMs + MAX(0, ? - overlapStartedAt), overlapStartedAt = NULL WHERE id = ?').run(now, sessionId);
            }
            this.db.prepare("UPDATE sessions SET state = ?, endedAt = ? WHERE id = ? AND state = 'open'").run(state, this.now(), sessionId);
            this.db.prepare('DELETE FROM credentials WHERE sessionId = ?').run(sessionId);
            return this.get(sessionId);
        });
    }
    close() { this.db.close(); }
}
module.exports = { CallStore, CallError, fail, hash, id, secret };
