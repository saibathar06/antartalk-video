'use strict';
const { configFromEnv } = require('./config');
const { createApp } = require('./app');
process.umask(0o077);
let service;
async function main() {
    const config = configFromEnv();
    service = await createApp(config);
    service.server.listen(config.port, config.bindHost, () => console.log(`AntarTalk video listening on port ${config.port}`));
}
process.on('unhandledRejection', error => {
    console.error(JSON.stringify({ level: 'fatal', event: 'unhandled_rejection', errorType: error?.name || 'Error', errorCode: error?.code || 'UNKNOWN' }));
    process.exit(1);
});
process.on('uncaughtException', error => {
    console.error(JSON.stringify({ level: 'fatal', event: 'uncaught_exception', errorType: error?.name || 'Error', errorCode: error?.code || 'UNKNOWN' }));
    process.exit(1);
});
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    if (service) await service.close();
    clearTimeout(timeout);
});
main().catch(error => {
    console.error(JSON.stringify({ level: 'fatal', event: 'startup_failed', errorType: error?.name || 'Error', errorCode: error?.code || 'UNKNOWN' }));
    process.exit(1);
});
