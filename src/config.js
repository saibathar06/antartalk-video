'use strict';
const path = require('node:path');

function origin(value, name, development) {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password ||
        (url.protocol !== 'https:' && !(development && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
        throw new Error(`${name} must be an HTTPS origin without a trailing slash (localhost HTTP allowed in development).`);
    }
    return value;
}
function configFromEnv(env = process.env) {
    const development = env.NODE_ENV === 'development';
    if (!env.SERVICE_API_KEY || env.SERVICE_API_KEY.length < 32) throw new Error('SERVICE_API_KEY must be at least 32 characters.');
    const publicOrigin = origin(env.PUBLIC_ORIGIN, 'PUBLIC_ORIGIN', development);
    const parentOrigins = (env.APP_ORIGINS || '').split(',').filter(Boolean).map(s => origin(s.trim(), 'APP_ORIGINS', development));
    const turnUrls = (env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (turnUrls.some(s => !/^turns?:[^\s]+$/.test(s))) throw new Error('TURN_URLS must contain turn: or turns: URLs.');
    if (!development && (!turnUrls.length || !env.TURN_SECRET || env.TURN_SECRET.length < 32)) {
        throw new Error('Production requires TURN_URLS and a TURN_SECRET of at least 32 characters.');
    }
    if (turnUrls.length && !env.TURN_SECRET) throw new Error('TURN_SECRET is required with TURN_URLS.');
    const port = Number(env.PORT || 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid.');
    const databaseUrl = env.DATABASE_URL?.trim() || null;
    if (!development && !databaseUrl) throw new Error('Production requires DATABASE_URL for durable PostgreSQL storage.');
    return { publicOrigin, parentOrigins, serviceKey: env.SERVICE_API_KEY, turnUrls,
        turnSecret: env.TURN_SECRET, relayOnly: env.RELAY_ONLY !== 'false', port,
        databaseUrl,
        database: env.DATABASE_PATH || path.resolve(__dirname, '../data/calls.sqlite'),
        bindHost: env.BIND_HOST || '0.0.0.0' };
}
module.exports = { configFromEnv };
