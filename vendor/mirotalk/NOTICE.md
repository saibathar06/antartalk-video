# MiroTalk C2C provenance

- Upstream: https://github.com/miroslavpejic85/mirotalkc2c
- Local source version: 1.4.36
- Source commit: `2e0de9dfbb430d00377153da9ec687b6a8f9500d`
- License: AGPL-3.0, included in this directory and at the service root.
- Original author: Miroslav Pejic and contributors.

The frontend directory is a snapshot of that repository. AntarTalk changes are limited to the copied `html/client.html` and `js/client.js`: local pinned dependencies; no upstream analytics/translation; ticket-based bootstrapping; identity from the service; Socket.IO authentication; host events; relay policy; bounded reconnect handling; queued early ICE candidates; stopping devices on leave; and the appointment audio/video scope. `public/session.js` and `public/session.css` implement the host bridge and overrides.

`src/signaling.js` adapts the C2C `join`, `addPeer`, `relaySDP`, `relayICE`, `peerStatus` and `removePeer` protocol from upstream `backend/server.js`, adding authenticated two-participant admission and revocation. The original unauthenticated server is not part of the runnable service.

This folder preserves upstream source notices. The original repository outside this folder has not been modified. Browser dependency licenses are distributed with their npm packages. Retain license notices and fulfill the applicable source-distribution/network-use obligations when deploying this modified service, or obtain appropriate alternative licensing.
