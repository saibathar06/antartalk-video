'use strict';
const { configFromEnv } = require('./config');
const { createApp } = require('./app');
process.umask(0o077);
const config = configFromEnv();
const service = createApp(config);
service.server.listen(config.port, config.bindHost, () => console.log(`AntarTalk video listening on port ${config.port}`));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    await service.close();
    clearTimeout(timeout);
});
