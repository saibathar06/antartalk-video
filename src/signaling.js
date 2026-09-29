'use strict';
// Adapted from MiroTalk C2C backend/server.js (AGPL-3.0).
const { createHmac, randomBytes } = require('node:crypto');

function iceConfig(config, claim) {
    // Credentials last through the call plus a small allocation-cleanup grace.
    const expiry = Math.ceil(claim.session.closesAt / 1000) + 300;
    const username = `${expiry}:${randomBytes(12).toString('hex')}`;
    return config.turnUrls.length ? [{ urls: config.turnUrls, username,
        credential: createHmac('sha1', config.turnSecret).update(username).digest('base64') }] : [];
}

function attachSignaling(io, store, config) {
    const rooms = new Map();
    const kick = (socket, code, message) => {
        socket.emit('callEnded', { code, message });
        socket.disconnect(true);
    };
    const validate = socket => {
        try { return store.credential(socket.handshake.auth?.token, 'connection'); }
        catch { kick(socket, 'SESSION_CLOSED', 'Call access has ended. Return to AntarTalk to rejoin.'); return null; }
    };
    io.use((socket, next) => {
        try { socket.data.claim = store.credential(socket.handshake.auth?.token, 'connection'); next(); }
        catch (error) { const denied = new Error(error.message); denied.data = { code: error.code || 'INVALID_CREDENTIAL' }; next(denied); }
    });
    io.on('connection', socket => {
        // Only one signaling connection per participant, even before media is ready.
        const claim = socket.data.claim;
        for (const other of io.sockets.sockets.values()) {
            if (other !== socket && other.data.claim?.sessionId === claim.sessionId && other.data.claim?.userId === claim.userId) {
                kick(other, 'REPLACED', 'This call was opened on another connection.');
            }
        }
        let count = 0;
        let resetAt = Date.now() + 10_000;
        socket.use((packet, next) => {
            if (Date.now() >= resetAt) { count = 0; resetAt = Date.now() + 10_000; }
            if (++count > 300) return kick(socket, 'RATE_LIMITED', 'Too many signaling messages.');
            if (validate(socket)) next();
        });
        socket.on('join', (input) => {
            const current = validate(socket);
            if (!current) return;
            if (input?.channel !== current.sessionId) return kick(socket, 'FORBIDDEN_ROOM', 'You cannot join that call.');
            if (socket.data.joined) return;
            const room = rooms.get(current.sessionId) || new Map();
            if (room.size >= 2) return kick(socket, 'ROOM_FULL', 'This call already has two participants.');
            socket.data.joined = true;
            socket.data.peerInfo = {
                peerName: current.role === 'doctor' ? 'Doctor' : 'Client',
                peerVideo: input.peerInfo?.peerVideo === true,
                peerAudio: input.peerInfo?.peerAudio === true,
                peerScreen: false,
            };
            room.set(socket.id, socket);
            rooms.set(current.sessionId, room);
            store.presence(current.sessionId, current.role, true);
            const peers = Object.fromEntries([...room].map(([key, s]) => [key, s.data.peerInfo]));
            for (const peer of room.values()) {
                peer.emit('serverInfo', { roomPeersCount: room.size, redirectURL: false, surveyURL: false });
                if (peer === socket) continue;
                peer.emit('addPeer', { peerId: socket.id, peers, shouldCreateOffer: false,
                    iceServers: iceConfig(config, peer.data.claim), iceTransportPolicy: config.relayOnly ? 'relay' : 'all' });
                socket.emit('addPeer', { peerId: peer.id, peers, shouldCreateOffer: true,
                    iceServers: iceConfig(config, current), iceTransportPolicy: config.relayOnly ? 'relay' : 'all' });
            }
            socket.emit('callReady', { sessionId: current.sessionId, role: current.role });
        });
        const target = input => {
            if (!socket.data.joined || typeof input?.peerId !== 'string' || input.peerId === socket.id) return null;
            return rooms.get(claim.sessionId)?.get(input.peerId);
        };
        socket.on('relaySDP', input => {
            const peer = target(input);
            const sdp = input?.sessionDescription;
            if (peer && ['offer', 'answer'].includes(sdp?.type) && typeof sdp.sdp === 'string' && sdp.sdp.length <= 100_000) {
                peer.emit('sessionDescription', { peerId: socket.id, sessionDescription: { type: sdp.type, sdp: sdp.sdp } });
            }
        });
        socket.on('relayICE', input => {
            const peer = target(input);
            const candidate = input?.iceCandidate;
            if (peer && candidate && typeof candidate.candidate === 'string' && candidate.candidate.length <= 4096) {
                peer.emit('iceCandidate', { peerId: socket.id, iceCandidate: candidate });
            }
        });
        socket.on('peerStatus', input => {
            if (!socket.data.joined || input?.roomId !== claim.sessionId ||
                !['audio', 'video', 'screen'].includes(input.element) || typeof input.active !== 'boolean') return;
            const keys = { audio: 'peerAudio', video: 'peerVideo', screen: 'peerScreen' };
            socket.data.peerInfo[keys[input.element]] = input.active;
            for (const peer of rooms.get(claim.sessionId)?.values() || []) {
                if (peer !== socket) peer.emit('peerStatus', { peerId: socket.id,
                    peerName: socket.data.peerInfo.peerName, element: input.element, active: input.active });
            }
        });
        socket.on('disconnect', () => {
            const room = rooms.get(claim.sessionId);
            if (!room?.delete(socket.id)) return;
            store.presence(claim.sessionId, claim.role, false);
            for (const peer of room.values()) peer.emit('removePeer', { peerId: socket.id });
            if (!room.size) rooms.delete(claim.sessionId);
        });
    });
    function revokeInvalid() {
        for (const socket of io.sockets.sockets.values()) validate(socket);
    }
    // Also enforce closure on idle sockets, without waiting for another event.
    const sweep = setInterval(revokeInvalid, 1000);
    sweep.unref();
    return { revokeInvalid, stop: () => clearInterval(sweep),
        participants: sessionId => [...(rooms.get(sessionId)?.values() || [])].map(s => s.data.claim.role) };
}
module.exports = { attachSignaling, iceConfig };
