'use strict';
// Local UI inspection only. Synthetic camera/audio; no real devices or booking data.
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const service = createApp({ database: ':memory:', serviceKey: 'local-preview-not-a-production-secret',
    publicOrigin: 'http://localhost:8088', parentOrigins: [], turnUrls: [], relayOnly: false });
const session = service.store.create({ appointmentId: 'preview', doctorId: 'doctor', clientId: 'client',
    opensAt: new Date(Date.now() - 1000).toISOString(), closesAt: new Date(Date.now() + 3600_000).toISOString() }).session;
const send = service.app.response.send;
service.app.response.send = function (body) {
    if (this.req.path === '/test-media.js') {
        this.status(200).type('js');
        return send.call(this, fs.readFileSync(path.join(__dirname, 'synthetic-media.js'), 'utf8'));
    }
    if (['/preview/doctor', '/preview/client'].includes(this.req.path)) {
        const userId = this.req.path.split('/').pop();
        const { ticket } = service.store.ticket(session.id, userId);
        this.status(302).set('Location', `/call#ticket=${ticket}`);
        return send.call(this, 'Opening synthetic call');
    }
    if (this.req.path === '/call' && typeof body === 'string') {
        body = body.replace('<head>', '<head><script src="/test-media.js"></script>');
    }
    return send.call(this, body);
};
service.server.listen(8088, '127.0.0.1', () => console.log('Preview: http://localhost:8088/call'));
process.on('SIGINT', async () => { await service.close(); });
