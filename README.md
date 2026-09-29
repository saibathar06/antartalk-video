# AntarTalk Video

Standalone appointment-call service built from MiroTalk C2C 1.4.36. Forward this **entire folder**, excluding `node_modules`, `.env` and `data`. Nothing in the existing AntarTalk app is required or modified.

The booking team owns appointments and authentication. This service owns call admission, signaling, the shared browser call page and call-access expiry.

## Integration in three steps

1. Booking backend calls `POST /v1/sessions` with the appointment ID, doctor ID, client ID and joining window. Save the returned session ID. Identical retries return the same session.
2. When a logged-in participant taps Join, the backend verifies appointment access and calls `POST /v1/sessions/:id/tickets`. Open the returned `launchUrl` immediately in a web iframe or mobile WebView.
3. On cancellation/completion, the backend calls `POST /v1/sessions/:id/end`. The time window is also enforced automatically.

**Never put `SERVICE_API_KEY` in a website, mobile app, public environment variable or room URL.** A room ID alone cannot authorize a connection. Launch URLs are sensitive one-use bearer credentials valid for at most 60 seconds; do not share or log them.

## Start here

- [Backend integration and API contract](docs/backend.md)
- [Website and mobile integration](docs/app-integration.md)
- [Deployment, TURN and release checks](docs/deployment.md)
- [Completed verification and remaining staging checks](docs/verification.md)
- [MiroTalk provenance and modifications](vendor/mirotalk/NOTICE.md)

## Local setup

Requires Node 24+ and npm. The Docker runtime pins Node 24.14.0. Production uses PostgreSQL and owns only the `antartalk_video` schema, so it can safely reuse AntarTalk's managed PostgreSQL server without writing to booking tables. SQLite remains available only as a local development/test fallback.

```sh
npm ci
cp .env.example .env
# Edit .env with the values below before starting.
npm start
```

For local testing only, set `NODE_ENV=development`, `PUBLIC_ORIGIN=http://localhost:8080`, `APP_ORIGINS=http://localhost:3000`, a generated `SERVICE_API_KEY`, empty `TURN_URLS`, and `RELAY_ONLY=false`. Production requires HTTPS and TURN. Local direct-mode success does not validate public-network calling.

```sh
npm test
```

Tests exercise real HTTP and WebSocket connections, participant admission, room isolation, ticket replay/expiry, replacement/reconnect, cancellation, asset serving and persistent credential revocation. They do not certify real-device audio/video or deployed TURN networking.

For a local browser smoke test with generated video and silent audio (no camera/microphone access), run `node tests/preview.js` and open `http://localhost:8088/preview/doctor` and `http://localhost:8088/preview/client` in separate tabs. Use the playback button if autoplay is blocked. This fixture binds only to loopback and is excluded from the production image.

## Layout

```text
    src/                 API, PostgreSQL/SQLite stores, configuration, authenticated C2C signaling
public/              Credential exchange, host events, call-page overrides
vendor/mirotalk/      Vendored C2C frontend, provenance and upstream license
tests/               Automated security/integration tests and local preview
docs/                Backend/app/deployment handoff and Coturn configuration
    migrations/          Idempotent video-owned PostgreSQL schema
    Dockerfile           Standalone production container
    compose.yaml         Single-instance service using managed PostgreSQL
.env.example         Required configuration; no credentials included
package-lock.json    Locked server and locally served browser dependencies
LICENSE              AGPL-3.0; retained upstream licensing
```

## Scope and limits

- One doctor and one client per call; one current connection per participant. A fresh join replaces that participant's old connection.
- Audio/video, mute, camera controls and leave. Recording, chat, files and screen sharing are outside the exposed appointment UI.
- Foreground mobile use. Native incoming-call UI and reliable background calling need separate native integration.
- No booking, payments, notifications, clinical records, media recording, webhooks or billing-duration calculation.
- Session and finalized attendance records persist in PostgreSQL; live peer connections reconnect after process/network interruption. Run one signaling instance; multiple replicas still require shared room membership and coordinated signaling.
- Socket closure and time expiry stop the supplied client. Because media is WebRTC between endpoints (including when TURN relays it), signaling cannot forcibly terminate an already-established call between two deliberately modified clients. This is not an SFU with server-controlled media teardown.

Ready for team integration and staging. Production release still requires the deployment and real-device checks in the deployment guide.
