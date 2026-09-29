# Handoff verification

Automated verification completed on 2026-09-26; browser checks completed on 2026-09-24:

- All **17 automated tests passed** in the pinned Node 24.14.0 container, with external networking disabled and a read-only source mount.
- The final Docker image built successfully from the standalone folder. The build uses production dependencies and runs as the non-root `node` user.
- Ticket bootstrap also passed regression checks without `AbortSignal.timeout`, covering older WebViews and stalled-request recovery.

- Automated HTTP/Socket.IO tests: backend auth, forbidden legacy routes, idempotent create/conflict, assigned participants, early/expired access, one-use exchange races, unauthenticated sockets, server-supplied identity, room isolation, duplicate replacement, reconnect, revocation, cancellation, idle expiry, persistence and local browser assets.
- Browser: a missing ticket shows a terminal access message and makes no media request.
- Browser: two participants with synthetic video/silent audio joined, negotiated media and displayed both local and remote 640×360 video. Playback time advanced on both sides after the browser autoplay button was used.
- Browser: leaving removed the caller's media source and remote peer; the other participant returned to waiting. No browser errors were reported in these checks.

Not established by those checks: physical camera/microphone quality, audible audio, Bluetooth routing, Android/iOS WebView behavior, deployed TURN/TLS fallback, public-network connectivity, load capacity, the real booking/auth backend, or production availability. See the deployment and app guides for the staging acceptance checklist.

The synthetic preview exists only in `tests/`; it must never be used as a production entry point. Production runs `src/server.js` and requires participant tickets.
