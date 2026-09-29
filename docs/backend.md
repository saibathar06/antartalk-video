# Booking/backend integration

The caller of these APIs is the trusted AntarTalk backend. This service does not accept AntarTalk login tokens and does not implement appointment booking. Use opaque database IDs; do not send diagnoses, contact details or clinical notes.

## Authentication and deployment boundary

All `/v1/sessions` endpoints require `Authorization: Bearer <SERVICE_API_KEY>`. Store this key in the backend's secret manager. In production, additionally restrict these endpoints at the reverse proxy to the backend's network or use private networking/mTLS. The call page and `/v1/exchange` remain reachable by participants. There are no public legacy MiroTalk room-creation endpoints.

Responses containing tickets must use `Cache-Control: no-store` in the AntarTalk backend too. Redact launch URLs, headers and request/response bodies from application logging, analytics, traces and crash reporting.

## 1. Create a call

`POST /v1/sessions`

```json
{
  "appointmentId": "appt_123",
  "doctorId": "user_doctor_9",
  "clientId": "user_client_42",
  "opensAt": "2026-10-01T09:50:00.000Z",
  "closesAt": "2026-10-01T11:10:00.000Z"
}
```

All IDs are 1–128 letters, numbers, underscores or hyphens. The participants must differ. Timestamps are ISO-8601 with an explicit timezone; maximum access window is 12 hours. The booking team chooses the early-join and overrun allowances. This creates a record, not a running media process; no scheduler is needed in this service.

Returns `201` for a new call and `200` for an identical retry:

```json
{
  "id": "a-generated-uuid",
  "appointmentId": "appt_123",
  "doctorId": "user_doctor_9",
  "clientId": "user_client_42",
  "opensAt": "2026-10-01T09:50:00.000Z",
  "closesAt": "2026-10-01T11:10:00.000Z",
  "state": "scheduled",
  "createdAt": "2026-09-24T15:00:00.000Z",
  "endedAt": null
}
```

Persist `id` against the appointment. A unique appointment ID prevents duplicate calls when the booking transaction or webhook retries. Different configuration under the same ID returns `409 APPOINTMENT_CONFLICT`. Existing ended/cancelled calls never reopen.

For rescheduling, cancel the old session and create a new one using an appointment revision ID, e.g. `appt_123_v2`; atomically update the booking's active session mapping. Do not reuse the old call's participant access.

## 2. Authorize a participant

Expose your own authenticated application endpoint, for example:

`POST /api/appointments/:appointmentId/video-session/join`

Its required behavior:

1. Validate the logged-in user's session and the current appointment status.
2. Read the appointment and video session ID from your database.
3. Verify the user is the appointment's assigned doctor or client.
4. Request a ticket with the **user ID from authenticated server context**. Never accept it from the request body or infer authorization from a role name alone.
5. Return the service response to that participant, without caching/logging it.

Call the video service:

`POST /v1/sessions/:sessionId/tickets`

```json
{
  "userId": "user_doctor_9",
  "parentOrigin": "https://app.example.com"
}
```

`parentOrigin` is optional for mobile, and must exactly match a configured `APP_ORIGINS` entry when supplied. The backend selects it from its known client configuration, not arbitrary unvalidated input.

```json
{
  "sessionId": "a-generated-uuid",
  "launchUrl": "https://video.example.com/call#ticket=ONE_USE_SECRET&parentOrigin=https%3A%2F%2Fapp.example.com",
  "expiresAt": "2026-10-01T10:01:00.000Z"
}
```

Tickets expire at most 60 seconds after issuance. Open the launch URL immediately. The fragment avoids HTTP access-log/referrer exposure and is removed by the page before other scripts run. It is still a bearer secret; anyone who steals it before use could redeem it. The service does not perform independent identity verification after your backend issues the ticket.

A newer ticket invalidates older unused tickets for the same participant. Redeeming a ticket revokes that participant's previous connection credential and disconnects their old socket. It does not affect the other participant. An exchanged connection credential survives reconnect until the window ends or the backend closes the call.

Do not automatically retry a ticket exchange. If launch or exchange fails, request a fresh ticket through the authenticated backend. Never persist launch URLs as appointment links.

## 3. End or cancel

`POST /v1/sessions/:sessionId/end`

```json
{ "state": "ended" }
```

Use `cancelled` when cancelling an appointment. Repeated requests preserve the first terminal state and return `200`. This revokes credentials, rejects further tickets and disconnects active signaling connections immediately. Idle sockets are also checked once per second for expiry.

Leaving a call in the client disconnects only that participant; it does not mark the appointment complete. Your backend owns the business rule for completion and which user can end the session for both people.

## Read status

`GET /v1/sessions/:sessionId` returns the session record plus `connectedRoles`, an array containing `doctor` and/or `client`. This is signaling presence, not proof that media is connected or billable time. States: `scheduled`, `open`, `expired`, `ended`, `cancelled`. No join/leave webhooks are implemented in v1.

## Errors

```json
{ "code": "NOT_PARTICIPANT", "message": "User is not assigned to this call." }
```

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | INVALID_INPUT / INVALID_ORIGIN | Invalid IDs, time window or embedding origin |
| 401 | UNAUTHORIZED | Missing/wrong service credential |
| 401 | INVALID_CREDENTIAL | Invalid, expired or consumed participant credential |
| 403 | NOT_PARTICIPANT / TOO_EARLY | Not assigned, or joining window not open |
| 404 | NOT_FOUND | Unknown session or endpoint |
| 409 | APPOINTMENT_CONFLICT | Reused appointment ID with changed configuration |
| 410 | SESSION_CLOSED | Expired, ended or cancelled |
| 429 | RATE_LIMITED | Retry with backoff |
| 500 | REQUEST_FAILED | Temporary service failure; do not expose internal errors |

Retry create/end safely with bounded exponential backoff on transport errors and 5xx. For tickets, retries generate a fresh ticket and invalidate the previous unused one. Do not retry 4xx without fixing their cause. Use request timeouts; do not block a booking database transaction while making a network call.

## Public exchange (implemented by the supplied page)

`POST /v1/exchange` with `{ "ticket": "..." }` returns `{ token, sessionId, role, expiresAt }`. It accepts only one-use tickets. This endpoint is not a login API. The page uses `token` in Socket.IO `auth`, never in query parameters. The app should normally use the supplied page instead of implementing this protocol itself.
