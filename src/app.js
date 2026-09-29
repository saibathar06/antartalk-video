'use strict';
const express = require('express');
const { createServer } = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Server } = require('socket.io');
const { CallStore, CallError, hash } = require('./store');
const { attachSignaling } = require('./signaling');

function createApp(config) {
    const store = new CallStore(config.database);
    const app = express();
    app.disable('x-powered-by');
    const server = createServer(app);
    const allowedOrigins = new Set([config.publicOrigin, ...config.parentOrigins]);
    const io = new Server(server, { transports: ['websocket'], maxHttpBufferSize: 128 * 1024,
        allowRequest: (req, callback) => callback(null, !req.headers.origin || allowedOrigins.has(req.headers.origin)) });
    const signaling = attachSignaling(io, store, config);
    const frontend = path.resolve(__dirname, '../vendor/mirotalk/frontend');
    let html = readFileSync(path.join(frontend, 'html/client.html'), 'utf8');
    html = html.replace('<head>', '<head><script src="/session.js"></script><link rel="stylesheet" href="/session.css">')
        .replace(/<script[^>]+(?:stats|translate)\.js[^>]*><\/script>/g, '')
        .replace('<title>MiroTalk C2C</title>', '<title>AntarTalk video session</title>');

    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self' ${config.parentOrigins.join(' ')}; object-src 'none'; base-uri 'self'`,
            'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)' });
        next();
    });
    app.use(express.json({ limit: '8kb' }));
    app.use('/v1', (req, res, next) => {
        const startedAt = Date.now();
        res.once('finish', () => console.log(JSON.stringify({
            level: 'info', event: 'video_api_request', method: req.method,
            path: req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id'),
            status: res.statusCode, durationMs: Date.now() - startedAt
        })));
        next();
    });
    // Bounded fixed-window limiter; no unbounded per-IP map. A proxy should add per-IP limits.
    let requests = 0;
    let resetAt = Date.now() + 60_000;
    app.use('/v1', (req, res, next) => {
        if (Date.now() >= resetAt) { requests = 0; resetAt = Date.now() + 60_000; }
        if (++requests > 1200) return res.status(429).json({ code: 'RATE_LIMITED', message: 'Please retry shortly.' });
        next();
    });
    const serviceAuth = (req, res, next) => {
        const header = req.get('authorization') || '';
        if (!timingSafeEqual(Buffer.from(hash(header)), Buffer.from(hash(`Bearer ${config.serviceKey}`)))) {
            return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Service authentication required.' });
        }
        next();
    };
    app.get('/healthz', (req, res) => { store.db.prepare('SELECT 1').get(); res.json({ status: 'ok', node: process.versions.node }); });
    app.use('/v1/sessions', serviceAuth);
    app.post('/v1/sessions', (req, res) => {
        const result = store.create(req.body);
        res.status(result.created ? 201 : 200).json({ ...result.session, sessionId: result.session.id });
    });
    app.get('/v1/sessions/:id', (req, res) => res.json({ ...store.get(req.params.id), connectedRoles: signaling.participants(req.params.id) }));
    app.post('/v1/sessions/:id/tickets', (req, res) => {
        const parentOrigin = req.body?.parentOrigin;
        if (parentOrigin !== undefined && !config.parentOrigins.includes(parentOrigin)) {
            throw new CallError(400, 'INVALID_ORIGIN', 'parentOrigin must be a configured app origin.');
        }
        const result = store.ticket(req.params.id, req.body?.userId);
        const fragment = new URLSearchParams({ ticket: result.ticket });
        if (parentOrigin) fragment.set('parentOrigin', parentOrigin);
        res.json({ sessionId: req.params.id, launchUrl: `${config.publicOrigin}/call#${fragment}`, expiresAt: result.expiresAt });
    });
    app.post('/v1/sessions/:id/end', (req, res) => {
        const result = store.end(req.params.id, req.body?.state || 'ended');
        signaling.revokeInvalid();
        res.json(result);
    });
    app.post('/v1/exchange', (req, res) => {
        const result = store.exchange(req.body?.ticket);
        signaling.revokeInvalid();
        res.json(result);
    });
    app.get('/call', (req, res) => res.type('html').send(html));
    const libraries = {
        'webrtc-adapter': 'webrtc-adapter', sweetalert2: 'sweetalert2', xss: 'xss', qrious: 'qrious',
        popper: '@popperjs/core', tippy: 'tippy.js', 'ua-parser-js': 'ua-parser-js', 'crypto-js': 'crypto-js',
        highlight: 'highlight.js', 'emoji-mart': 'emoji-mart', fontawesome: '@fortawesome/fontawesome-free', animate: 'animate.css',
    };
    for (const [url, packageName] of Object.entries(libraries)) {
        app.use(`/lib/${url}`, express.static(path.resolve(__dirname, '../node_modules', packageName), { index: false, dotfiles: 'deny' }));
    }
    app.use(express.static(path.resolve(__dirname, '../public'), { index: false, dotfiles: 'deny' }));
    // No legacy /join or /api/v1/meeting endpoints, and no directory with private files.
    for (const directory of ['js', 'css', 'images', 'sounds', 'svg']) {
        app.use(`/${directory}`, express.static(path.join(frontend, directory), { index: false, dotfiles: 'deny' }));
    }
    app.use((req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Open your video session from AntarTalk.' }));
    app.use((error, req, res, next) => {
        const status = error instanceof CallError ? error.status : error.status === 400 || error.status === 413 ? error.status : 500;
        if (status === 500) console.error(JSON.stringify({ level: 'error', event: 'video_api_error',
            errorType: error?.name || 'Error', errorCode: error?.code || 'UNKNOWN', method: req.method,
            path: req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id') })); // Never log bodies or credentials.
        res.status(status).json({ code: error instanceof CallError ? error.code : 'REQUEST_FAILED',
            message: status === 500 ? 'The call service is unavailable. Please retry.' : error instanceof CallError ? error.message : 'Invalid request body.' });
    });
    async function close() {
        signaling.stop();
        await new Promise(resolve => io.close(resolve));
        store.close();
    }
    return { app, server, io, store, close };
}
module.exports = { createApp };
