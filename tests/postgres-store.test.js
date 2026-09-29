'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('pg-mem');
const { PostgresCallStore } = require('../src/postgres-store');

test('PostgreSQL attendance survives store reload and duplicate presence events are idempotent', async t => {
    const memory = newDb({ noAstCoverageCheck: true });
    const adapter = memory.adapters.createPg();
    let now = Date.parse('2030-01-01T10:00:00.000Z');
    const firstPool = new adapter.Pool();
    t.after(async () => { await firstPool.end().catch(() => {}); });
    const first = await new PostgresCallStore(null, () => now, { pool: firstPool }).initialize();
    const created = await first.create({
        appointmentId: 'persistent-appointment',
        doctorId: 'doctor-1',
        clientId: 'client-1',
        opensAt: new Date(now - 1000).toISOString(),
        closesAt: new Date(now + 3600_000).toISOString()
    });

    await first.presence(created.session.id, 'doctor', true);
    await first.presence(created.session.id, 'doctor', true);
    await first.presence(created.session.id, 'client', true);
    now += 5 * 60_000;
    await first.presence(created.session.id, 'client', false);
    await first.presence(created.session.id, 'client', false);
    await first.presence(created.session.id, 'doctor', false);

    const beforeReload = await first.get(created.session.id);
    assert.equal(beforeReload.attendance.doctor.joinCount, 1);
    assert.equal(beforeReload.attendance.client.joinCount, 1);
    assert.equal(beforeReload.attendance.overlapSeconds, 300);

    await firstPool.end();
    const secondPool = new adapter.Pool();
    t.after(async () => { await secondPool.end().catch(() => {}); });
    const reloaded = await new PostgresCallStore(null, () => now, { pool: secondPool }).initialize();
    const afterReload = await reloaded.get(created.session.id);

    assert.equal(afterReload.attendance.doctor.joined, true);
    assert.equal(afterReload.attendance.client.joined, true);
    assert.equal(afterReload.attendance.doctor.joinCount, 1);
    assert.equal(afterReload.attendance.client.joinCount, 1);
    assert.equal(afterReload.attendance.overlapSeconds, 300);
});
