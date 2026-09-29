'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const path = require('node:path');

const script = readFileSync(path.join(__dirname, '../public/session.js'), 'utf8');
function bootstrap(fetch) {
    const timers = new Map();
    let nextTimer = 0;
    let replacedUrl;
    const window = { addEventListener() {} };
    window.parent = window;
    runInNewContext(script, {
        window, URLSearchParams, AbortController, // Deliberately no AbortSignal.timeout.
        location: { hash: '#ticket=test-ticket' },
        history: { replaceState: (_state, _title, url) => { replacedUrl = url; } },
        setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id), fetch,
    });
    return { call: window.AntarTalkCall, timers, replacedUrl };
}

test('ticket bootstrap works without AbortSignal.timeout and clears the request timer', async () => {
    let request;
    const result = bootstrap(async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ token: 'connection-token', sessionId: 'session-1',
            expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
    });
    const access = await result.call.ready;
    assert.equal(access.token, 'connection-token');
    assert.equal(result.replacedUrl, '/call');
    assert.equal(request.url, '/v1/exchange');
    assert.equal(JSON.parse(request.options.body).ticket, 'test-ticket');
    assert.equal(result.timers.size, 1); // Only session expiry remains.
    assert.ok([...result.timers.values()][0].delay > 15_000);
});

test('a stalled ticket exchange aborts and returns an actionable retry message', async () => {
    const result = bootstrap((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    assert.equal(result.timers.get(1).delay, 15_000);
    result.timers.get(1).callback();
    assert.match((await result.call.ready).error, /Return to AntarTalk and try joining again/);
    assert.equal(result.timers.size, 0);
});
