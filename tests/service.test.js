'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createApp } = require('../src/app');
const { CallStore } = require('../src/store');
const { configFromEnv } = require('../src/config');
const { iceConfig } = require('../src/signaling');

async function fixture(t) {
    const config = { database: ':memory:', serviceKey: 'test-service-key-with-more-than-32-characters',
        publicOrigin: 'http://localhost:8080', parentOrigins: ['https://app.example.com'], turnUrls: [], relayOnly: false };
    const service = createApp(config);
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const clients = [];
    t.after(async () => { clients.forEach(s => s.disconnect()); await service.close(); });
    async function request(url, body, authorized = true, method) {
        const response = await fetch(base + url, {
            method: method || (body === undefined ? 'GET' : 'POST'),
            headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${config.serviceKey}` } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, data: await response.json() };
    }
    const input = (overrides = {}) => ({ appointmentId: 'appt-1', doctorId: 'doctor-1', clientId: 'client-1',
        opensAt: new Date(Date.now() - 1000).toISOString(), closesAt: new Date(Date.now() + 3600_000).toISOString(), ...overrides });
    const create = async overrides => (await request('/v1/sessions', input(overrides))).data;
    const ticket = async (sessionId, userId) => {
        const response = await request(`/v1/sessions/${sessionId}/tickets`, { userId, parentOrigin: config.parentOrigins[0] });
        assert.equal(response.status, 200);
        return new URLSearchParams(new URL(response.data.launchUrl).hash.slice(1)).get('ticket');
    };
    const access = async (sessionId, userId) => (await request('/v1/exchange', { ticket: await ticket(sessionId, userId) }, false)).data;
    const connect = async token => {
        const socket = io(base, { transports: ['websocket'], auth: { token }, reconnection: false, forceNew: true });
        clients.push(socket);
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
        return socket;
    };
    const join = async (socket, sessionId) => {
        const ready = once(socket, 'callReady');
        socket.emit('join', { channel: sessionId, peerInfo: { peerName: '<script>impersonation</script>', peerAudio: true, peerVideo: true } });
        await ready;
    };
    return { ...service, base, config, request, input, create, ticket, access, connect, join };
}

test('service endpoints require backend authentication; legacy public endpoints are absent', async t => {
    const f = await fixture(t);
    assert.equal((await f.request('/v1/sessions', f.input(), false)).status, 401);
    assert.equal((await f.request('/api/v1/meeting', {}, false)).status, 404);
    assert.equal((await f.request('/join?room=anything&name=Guest', undefined, false)).status, 404);
    assert.equal((await f.request('/healthz', undefined, false)).status, 200);
});

test('appointment creation is idempotent and detects configuration conflicts', async t => {
    const f = await fixture(t);
    const input = f.input();
    const a = await f.request('/v1/sessions', input);
    const b = await f.request('/v1/sessions', input);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(a.data.id, b.data.id);
    assert.equal((await f.request('/v1/sessions', { ...input, clientId: 'different' })).status, 409);
    assert.equal((await f.request('/v1/sessions', { ...input, appointmentId: 'new', clientId: input.doctorId })).status, 400);
});

test('only assigned participants can receive tickets, inside the configured window', async t => {
    const f = await fixture(t);
    const session = await f.create();
    assert.equal((await f.request(`/v1/sessions/${session.id}/tickets`, { userId: 'outsider' })).status, 403);
    assert.equal((await f.request(`/v1/sessions/${session.id}/tickets`, { userId: 'doctor-1', parentOrigin: 'https://evil.example' })).status, 400);
    const future = await f.create({ appointmentId: 'future', opensAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal((await f.request(`/v1/sessions/${future.id}/tickets`, { userId: 'doctor-1' })).data.code, 'TOO_EARLY');
});

test('ticket exchange is single-use, even for simultaneous requests', async t => {
    const f = await fixture(t);
    const session = await f.create();
    const ticket = await f.ticket(session.id, 'doctor-1');
    const results = await Promise.all([f.request('/v1/exchange', { ticket }, false), f.request('/v1/exchange', { ticket }, false)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
    assert.equal(results.find(r => r.status === 200).data.role, 'doctor');
});

test('expired tickets and closed sessions cannot be used', async t => {
    const f = await fixture(t);
    const session = await f.create();
    const ticket = await f.ticket(session.id, 'client-1');
    const later = Date.now() + 61_000;
    f.store.now = () => later;
    assert.equal((await f.request('/v1/exchange', { ticket }, false)).status, 401);
    const access = await f.access(session.id, 'client-1');
    f.store.now = () => later + 3600_000;
    assert.throws(() => f.store.credential(access.token, 'connection'));
    assert.equal((await f.request(`/v1/sessions/${session.id}/tickets`, { userId: 'client-1' })).status, 410);
});

test('unauthenticated websocket connections are rejected', async t => {
    const f = await fixture(t);
    await assert.rejects(f.connect(undefined), /invalid or expired/);
});

test('two assigned peers connect; server supplies identity and enforces room membership', async t => {
    const f = await fixture(t);
    const session = await f.create();
    const doctor = await f.connect((await f.access(session.id, 'doctor-1')).token);
    await f.join(doctor, session.id);
    const client = await f.connect((await f.access(session.id, 'client-1')).token);
    const peerAdded = once(doctor, 'addPeer');
    await f.join(client, session.id);
    const [peer] = await peerAdded;
    assert.equal(peer.peers[client.id].peerName, 'Client');
    assert.equal(peer.peers[doctor.id].peerName, 'Doctor');
    assert.equal(peer.shouldCreateOffer, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    const live = (await f.request(`/v1/sessions/${session.id}`)).data;
    assert.deepEqual(live.connectedRoles.sort(), ['client', 'doctor']);
    assert.equal(live.attendance.doctor.joined, true);
    assert.equal(live.attendance.client.joined, true);
    assert.ok(live.attendance.overlapSeconds >= 0);
    const forwarded = once(client, 'sessionDescription');
    doctor.emit('relaySDP', { peerId: client.id, sessionDescription: { type: 'offer', sdp: 'test-sdp' } });
    assert.equal((await forwarded)[0].sessionDescription.sdp, 'test-sdp');
    const denied = once(doctor, 'callEnded');
    doctor.emit('join', { channel: 'different-room' });
    assert.equal((await denied)[0].code, 'FORBIDDEN_ROOM');
});

test('cross-session SDP and forged peer status are not forwarded', async t => {
    const f = await fixture(t);
    const a = await f.create();
    const b = await f.create({ appointmentId: 'appt-2' });
    const doctor = await f.connect((await f.access(a.id, 'doctor-1')).token);
    const client = await f.connect((await f.access(b.id, 'client-1')).token);
    await f.join(doctor, a.id);
    await f.join(client, b.id);
    const received = [];
    client.on('sessionDescription', data => received.push(data));
    client.on('peerStatus', data => received.push(data));
    doctor.emit('relaySDP', { peerId: client.id, sessionDescription: { type: 'offer', sdp: 'malicious' } });
    doctor.emit('peerStatus', { roomId: b.id, peerName: 'Client', element: 'audio', active: false });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(received, []);
});

test('duplicate participant connections replace the old connection; disconnect permits rejoin', async t => {
    const f = await fixture(t);
    const session = await f.create();
    const access = await f.access(session.id, 'doctor-1');
    const first = await f.connect(access.token);
    await f.join(first, session.id);
    const ended = once(first, 'callEnded');
    const second = await f.connect(access.token);
    assert.equal((await ended)[0].code, 'REPLACED');
    await f.join(second, session.id);
    second.disconnect();
    const third = await f.connect(access.token);
    await f.join(third, session.id);
    assert.deepEqual((await f.request(`/v1/sessions/${session.id}`)).data.connectedRoles, ['doctor']);
});

test('new ticket exchange revokes previous credentials and ends their connection', async t => {
    const f = await fixture(t);
    const session = await f.create();
    const access = await f.access(session.id, 'doctor-1');
    const socket = await f.connect(access.token);
    const ended = once(socket, 'callEnded');
    await f.access(session.id, 'doctor-1');
    await ended;
    await assert.rejects(f.connect(access.token));
});

test('end/cancel is idempotent, disconnects sockets and blocks further tickets', async t => {
    const f = await fixture(t);
    const session = await f.create();
    const access = await f.access(session.id, 'client-1');
    const socket = await f.connect(access.token);
    await f.join(socket, session.id);
    const ended = once(socket, 'callEnded');
    assert.equal((await f.request(`/v1/sessions/${session.id}/end`, { state: 'cancelled' })).data.state, 'cancelled');
    await ended;
    assert.equal((await f.request(`/v1/sessions/${session.id}/end`, { state: 'ended' })).data.state, 'cancelled');
    assert.equal((await f.request(`/v1/sessions/${session.id}/tickets`, { userId: 'client-1' })).status, 410);
});

test('session and credential hashes survive restart without persisting bearer secrets', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'antartalk-test-'));
    const filename = path.join(folder, 'calls.sqlite');
    let store = new CallStore(filename);
    try {
        const session = store.create({ appointmentId: 'persisted', doctorId: 'd', clientId: 'c',
            opensAt: new Date(Date.now() - 1000).toISOString(), closesAt: new Date(Date.now() + 3600_000).toISOString() }).session;
        const access = store.exchange(store.ticket(session.id, 'd').ticket);
        const raw = store.db.prepare('SELECT * FROM credentials').all();
        assert.ok(!JSON.stringify(raw).includes(access.token));
        store.close();
        store = new CallStore(filename);
        assert.equal(store.credential(access.token, 'connection').sessionId, session.id);
        store.end(session.id, 'ended');
        store.close();
        store = new CallStore(filename);
        assert.equal(store.get(session.id).state, 'ended');
        assert.throws(() => store.credential(access.token, 'connection'));
    } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('idle connected sockets are closed automatically at the session deadline', async t => {
    const f = await fixture(t);
    const session = await f.create();
    const socket = await f.connect((await f.access(session.id, 'doctor-1')).token);
    await f.join(socket, session.id);
    const ended = once(socket, 'callEnded', { signal: AbortSignal.timeout(2500) });
    f.store.now = () => Date.parse(session.closesAt) + 1;
    assert.equal((await ended)[0].code, 'SESSION_CLOSED');
});

test('call HTML uses local scripts, restrictive embedding, and accessible terminal state assets', async t => {
    const f = await fixture(t);
    const response = await fetch(f.base + '/call');
    const html = await response.text();
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/app.example.com/);
    assert.doesNotMatch(html, /<script[^>]+src="https?:/);
    assert.doesNotMatch(html, /stats\.js|translate\.js/);
    for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) {
        const asset = new URL(match[1], f.base + '/call');
        assert.equal((await fetch(asset)).status, 200, asset.href);
    }
    assert.equal((await fetch(f.base + '/.env')).status, 404);
    assert.equal((await fetch(f.base + '/data/calls.sqlite')).status, 404);
});

test('production configuration fails closed without secrets and TURN; TURN passwords are temporary', () => {
    assert.throws(() => configFromEnv({}), /SERVICE_API_KEY/);
    const env = { SERVICE_API_KEY: 'a'.repeat(64), PUBLIC_ORIGIN: 'https://video.example.com' };
    assert.throws(() => configFromEnv(env), /TURN/);
    const config = configFromEnv({ ...env, TURN_SECRET: 'b'.repeat(64), TURN_URLS: 'turns:turn.example.com:5349' });
    assert.equal(config.relayOnly, true);
    const ice = iceConfig(config, { session: { closesAt: Date.now() + 60_000 } });
    assert.equal(ice.length, 1);
    assert.ok(Number(ice[0].username.split(':')[0]) > Date.now() / 1000);
    assert.notEqual(ice[0].credential, config.turnSecret);
});
