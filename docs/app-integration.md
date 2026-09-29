# App and website integration

No existing AntarTalk app files are included or required. Both platforms obtain a fresh launch URL from the **AntarTalk backend**, then open the same hosted call page. Never call the service's administrative endpoints from a client or ship its service key.

## Shared flow

1. User taps Join on an authenticated appointment.
2. Request your backend's `POST /api/appointments/:id/video-session/join` (the backend team implements this route).
3. Validate `launchUrl`: HTTPS, exact configured video origin, pathname `/call`, no embedded username/password. Do not allow arbitrary URLs returned by navigation or messages.
4. Open it immediately, once. Keep it only in memory. A retry, reload or fresh screen mount requires a fresh backend ticket.
5. Handle terminal events by unmounting the call page and offering Return to appointment / Join again. A fresh join requires a new backend request.

The backend response is `{ sessionId, launchUrl, expiresAt }`. Room names and participant identities must not be constructed by the app. The page displays role labels rather than patient names.

## Website

Use a dedicated iframe with full available height. MiroTalk is a browser application; `react-native-webview` is not the website renderer.

```html
<iframe
  id="video-call"
  title="AntarTalk video session"
  allow="camera; microphone; autoplay; fullscreen"
  referrerpolicy="no-referrer"
  style="width:100%;height:100%;border:0"
></iframe>
```

Set `src` to the validated `launchUrl` after the backend request. Configure the website's own Permissions-Policy and CSP to allow camera/microphone and framing for the exact video origin. The service's `APP_ORIGINS` must include the website origin. Have the backend include that same `parentOrigin` when requesting tickets.

```js
const videoOrigin = 'https://video.example.com';
const frame = document.getElementById('video-call');
window.addEventListener('message', event => {
  if (event.origin !== videoOrigin || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (data?.source !== 'antartalk-video' || data.version !== 1) return;
  if (data.sessionId && data.sessionId !== expectedSessionId) return;
  // Dispatch a validated event to your call-screen state machine.
});

// Host Leave button: tell the page to stop tracks, then unmount the iframe.
frame.contentWindow.postMessage({ source: 'antartalk-host', type: 'leave' }, videoOrigin);
```

Do not pass tokens into analytics, route search parameters, error messages or persistent browser storage. Do not treat UI events as authoritative appointment completion or billing evidence.

## React Native / Expo mobile

Use `react-native-webview` in the real application build. For Expo SDK 54, the documented version is 13.15.0; the app team must choose the version compatible with its actual upstream SDK. See [Expo SDK 54 WebView](https://docs.expo.dev/versions/v54.0.0/sdk/webview/) and [WebView reference](https://github.com/react-native-webview/react-native-webview/blob/v13.15.0/docs/Reference.md).

Configuration methodology:

- iOS: add camera and microphone usage descriptions. Allow inline playback. Use `mediaCapturePermissionGrantType="grantIfSameHostElseDeny"` for the trusted call origin; this still respects first-time OS permission prompts.
- Android: declare and request camera and record-audio permissions before joining; declare audio-settings permission where required by your integration.
- Set `javaScriptEnabled`, `domStorageEnabled`, `allowsInlineMediaPlayback` and `mediaPlaybackRequiresUserAction={false}`.
- Restrict navigation to the configured video origin and pathname `/call`. Reject external navigation/new windows. Do not grant media access to arbitrary hosts.
- Receive `window.ReactNativeWebView.postMessage` in `onMessage`; safely parse JSON and validate the source/version/type/session ID.
- Show loading and actionable permission/network failure states. Handle `onError`, `onHttpError` and render-process termination by unmounting and offering a fresh join.
- Unmount on leave/navigation/logout. Optionally call `window.AntarTalkCall.finish(); true;` through the WebView ref before unmounting; this emits `left` and explicitly stops tracks.
- Foreground-only v1: on backgrounding, leave/unmount the call and offer a fresh join on return. Native background audio, CallKit/ConnectionService and incoming calls are not included.
- The service manages socket reconnection inside the page. Do not remount the WebView on every host re-render or status event.

The shipped call page stops media on disconnect/leave/expiry. A new join for the same user replaces their previous call connection. If the platform needs a browser fallback, request a **fresh** ticket; a ticket already redeemed by a WebView cannot be reused in a browser.

## Events

```json
{
  "source": "antartalk-video",
  "version": 1,
  "type": "connected",
  "sessionId": "the-session-uuid"
}
```

| Type | Host behavior |
| --- | --- |
| waiting | Joined signaling; waiting for the other participant/media |
| connected | WebRTC peer reports a connected transport |
| reconnecting | Show reconnecting status; keep the page mounted |
| left | Participant chose to leave; close the call screen |
| ended | Access ended or was revoked; close the call screen |
| replaced | Another connection replaced this one; close and explain |
| error | Display the optional `message`; allow a fresh join for terminal failures |

Errors before exchange can omit `sessionId`. `connected` is transport status, not proof of audible media. `error` can also report a media negotiation failure; the host may offer a fresh join. No event contains credentials. The authoritative appointment/session state comes from the backend.

## Device acceptance matrix

Before release, test website↔website, website↔Android, website↔iPhone and Android↔iPhone on real builds. Cover denied/revoked permissions, camera switching, mute, Bluetooth and speaker routing, incoming phone calls, background/foreground, screen lock, network switching, TURN-only connections, cancellation, expiry, duplicate joins, server restart and both participants leaving. Test a small phone and landscape; verify screen-reader labels and large text in the host screen.
