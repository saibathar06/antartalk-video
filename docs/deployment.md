# Deployment

## Components

Run one always-on Node 24 service, persistent local SQLite volume, an HTTPS reverse proxy with WebSocket support, and a public Coturn instance. Avoid sleeping/free-tier service instances for active calls. Keep the API/signaling service and database on the same host; do not put SQLite on network storage.

```sh
cp .env.example .env
# Fill in HTTPS origins, two independently generated secrets and TURN URLs.
docker compose up --build -d
```

Generate each secret separately with `openssl rand -hex 32`. `SERVICE_API_KEY` is shared only with the booking/backend. `TURN_SECRET` is shared only with Coturn; the browser receives generated expiring TURN credentials, not this secret. Use an infrastructure secret manager for deployment. Neither secret is shipped in this folder.

The Compose file binds HTTP to host loopback port 8080. Keep its `PORT=8080` and `BIND_HOST=0.0.0.0` values unless you also update port mappings and health checks. Put the proxy on the same machine or update private routing appropriately. Provision a valid public certificate at the proxy; enable HSTS once HTTPS is verified. The service must not be exposed as public plaintext HTTP.

Proxy `/socket.io/` with HTTP/1.1 upgrade headers and idle timeouts above 60 seconds. Forward `/call`, `/session.js`, `/session.css`, `/lib/`, `/js/`, `/css/`, `/images/`, `/sounds/`, `/svg/` and `/v1/exchange`. Restrict `/v1/sessions` to the trusted backend network as an additional layer. `/healthz` checks the database and process, not TURN connectivity.

Apply per-IP connection/request limits at the proxy, including WebSocket upgrades. The service has a bounded global API limit (1,200 requests/minute) and per-connected-socket signaling limit (300 events/10 seconds); these are not a replacement for edge abuse protection. Restrict allowed origins with exact `APP_ORIGINS` entries. Native clients may omit Origin; credentials are always required regardless of Origin.

## Coturn

Start from [coturn.conf.example](coturn.conf.example). Replace the hostname, certificate paths, secret, and NAT mapping. Use Coturn's `use-auth-secret` mode; static username/password mode does not match this service's generated credentials.

Open inbound UDP/TCP 3478, TCP 5349, and the configured UDP relay range. Restrictive networks may require TURN/TLS on TCP 443 on a dedicated TURN IP/host. Configure the TURN listener, firewall and `TURN_URLS` together; an ordinary HTTP proxy cannot proxy TURN. `no-tcp-relay` disables RFC 6062 TCP peer allocations, not the browser's TCP connection to TURN for relaying UDP media.

`RELAY_ONLY=true` is the production default: participants send media through TURN, avoiding disclosure of their public IP addresses to each other. Budget bandwidth for both directions and provision quotas for expected concurrent calls. Temporary credentials expire at the session deadline plus five minutes to allow allocation cleanup. Capacity planning and load testing are still required.

## Persistence and operation

- Keep `/app/data` on the named volume. Back up SQLite with a SQLite-aware online backup or stop the service before copying the database and WAL files. Test restoration.
- Run exactly one replica/process. In-memory socket membership is intentional. Multiple replicas require a shared membership/admission store and coordinated signaling, not just extra containers.
- No server recording or clinical notes are stored. IDs, session windows/state and credential hashes are stored. Select a retention policy with the backend team. Terminal records are retained for idempotency; expired credentials are pruned when issuing tickets. No automatic session-record deletion is enabled.
- Do not log Authorization headers, JSON bodies, tickets, URL fragments, SDP or ICE addresses. The service reports only generic unexpected-error types, not sensitive request data. Configure your proxy/APM accordingly.
- Rotate `SERVICE_API_KEY` by coordinating the backend and service deploy. Rotating it does not revoke existing participant credentials; end affected sessions when that is required. Rotate `TURN_SECRET` with a planned transition because live relay refreshes may fail.
- On restart, database records/connection credentials survive. Clients try bounded signaling reconnection and rebuild their peers. A long outage ends the client flow and requires a fresh authenticated join.
- Back up before schema changes; this version creates its initial schema automatically and has no migration history yet.
- Build and test pinned dependencies before updating. Browser libraries are served locally; upstream analytics and translation scripts are excluded by the call entry point. The CSP blocks third-party script/connect/image loading.

## Release checks

1. Integrate the actual booking/authentication backend and verify user IDs cannot be supplied by an untrusted client.
2. Run `npm ci && npm test` in CI on the chosen Node 24 runtime. Build the Docker image and verify non-root volume permissions, health checks and restart recovery.
3. Verify HTTPS, iframe permissions, WebSocket upgrade and restrictive-network TURN fallback with two real devices on separate networks. Inspect selected ICE candidates to confirm relay use.
4. Run the [app device matrix](app-integration.md#device-acceptance-matrix), including leaving, cancellation, expiry and network changes. These tests have not been executed on physical devices in this handoff.
5. Exercise expected concurrency and TURN bandwidth; test edge limits and the single-process capacity before release.
6. Review the included AGPL-3.0 license and upstream alternative licensing with the team responsible for distribution. Provide the required corresponding source access for your chosen licensing path. Keeping the service separate does not itself remove license obligations.

This service is an integration/staging implementation, not a claim of medical-regulatory compliance, guaranteed background mobile calling, or high-availability failover.
