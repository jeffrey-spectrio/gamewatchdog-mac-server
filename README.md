# GameWatchdog Mac Server

Mac mini self-hosted replacement for the Cloudflare Worker. The existing Worker can remain online as a fallback.

## Included in V0.1

- Existing Android/iOS-compatible status, command, acknowledgement and screenshot APIs
- SQLite command queue, device status, events and screenshot index
- Persistent JPEG screenshot history with age and disk quota cleanup
- Token separation for devices and control clients
- Authentication failure rate limiting
- Authenticated WebSocket event stream at `/ws`
- Minimal mobile control page
- Remote controls and live status for automatic PvP and D1 modes
- Android APK OTA manifest, SHA-256 verification metadata and streamed download
- iOS App Store, TestFlight or enterprise update-link manifest
- Caddy HTTPS and macOS launchd examples

## Requirements

- macOS on an always-on Mac mini
- Node.js 24 or newer
- A domain pointing to the home public IP
- Router port forwarding to the Mac mini
- HTTPS reverse proxy (Caddy recommended)

## Quick start

```bash
npm install
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Put the two generated values in `.env` as `CONTROL_TOKEN` and `DEVICE_TOKEN`, then:

```bash
npm start
```

Open `http://127.0.0.1:8787/health` to verify the server. Do not expose port 8787 directly; expose Caddy's HTTPS port instead.

## Client compatibility

Set the Android and iOS base URL to the public HTTPS URL, for example `https://gamewatchdog.example.com:8443`. Current clients use the control token for Android polling, so initially set `DEVICE_TOKEN` equal to `CONTROL_TOKEN`. A future Android version can store a separate device token.

## Screenshot history

Images are stored in `screenshots/`; metadata is stored in `data/gamewatchdog.sqlite`. The defaults retain 3 days and at most 5 GB. Both are configurable in `.env`. Screenshots load only after the viewer clicks the button; the page then starts at the latest image and provides previous/next navigation.

- `GET /api/control/screenshots?device=home-zflip3&limit=50`
- `GET /api/control/screenshots/:id`

These two viewing endpoints are public. Capturing screenshots and all control commands still require `Authorization: Bearer <CONTROL_TOKEN>`.

## WebSocket

Connect to `wss://your-domain:port/ws` and immediately send:

```json
{"type":"auth","token":"CONTROL_TOKEN"}
```

The server then pushes status, queued-command, acknowledgement and screenshot events.

## Public deployment checklist

1. Keep the Node server bound to `127.0.0.1`.
2. Forward only the chosen Caddy HTTPS port through the router.
3. Replace the example domain in `deploy/Caddyfile.example`.
4. Use long random tokens and never put them in URLs.
5. Restrict macOS firewall access to the reverse proxy port.
6. Configure Dynamic DNS if the home public IP changes.

## API compatibility

The following Worker-compatible endpoints are retained:

- `GET /api/control/status`
- `POST /api/control/command`
- `GET /api/control/screenshot`
- `POST /api/device/poll`
- `POST /api/device/ack`
- `POST /api/device/screenshot`

## OTA app releases

Set `PUBLIC_BASE_URL` to the public HTTPS origin. For Android, copy the signed APK to the path in `ANDROID_APK_PATH`, then set `ANDROID_VERSION` and the monotonically increasing `ANDROID_BUILD`. The app checks the public manifest, downloads the APK, verifies its server-provided SHA-256 digest and opens Android's system installer for user confirmation. Android still enforces that the APK is signed with the same signing key.

For iOS, set `IOS_VERSION`, `IOS_BUILD` and an HTTPS `IOS_UPDATE_URL` pointing to the App Store, TestFlight or your managed enterprise distribution page. iOS does not permit an app to silently replace itself.

- `GET /api/app/update?platform=android&build=1718`
- `GET /api/app/update?platform=ios&build=2`
- `GET /api/app/download/android`
