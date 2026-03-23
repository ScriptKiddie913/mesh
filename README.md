# Mesh Relay Chat (No npm / no npx)

This project is a browser-based mesh chat PWA with:

- WebRTC Data Channels for peer links
- Vercel-hosted signaling API (`api/signal.js`)
- TTL-based relay forwarding + dedup
- Signed HELLO identity packets (Ed25519 fallback ECDSA)
- ECDH-derived shared secrets + AES-GCM ratcheted message keys
- IndexedDB message persistence
- Optional Web Bluetooth connection probe
- QR-based room sharing
- Service worker offline shell cache

## Important Notes

- This is dependency-free by design: no package manager required.
- True production-grade onion routing and Signal-grade double ratchet are complex protocols; this implementation provides a practical onion-style next-hop routing strategy and per-peer forward ratchet for message keys.
- WebRTC still depends on browser/network conditions. STUN is configured, TURN is not.

## Files

- `index.html` - main UI
- `styles.css` - responsive design
- `app.js` - app wiring and UI logic
- `lib/mesh.js` - WebRTC mesh, routing, secure envelope flow
- `lib/crypto.js` - identity, ECDH, signing, ratchet helpers
- `lib/db.js` - IndexedDB persistence
- `lib/bluetooth.js` - optional Web Bluetooth helper
- `api/signal.js` - signaling via Vercel Function + Vercel KV REST API
- `sw.js` - service worker
- `manifest.webmanifest` - PWA manifest

## Vercel Deployment (No npm/npx)

1. Push this folder to a Git repository.
2. Import the repository in Vercel Dashboard.
3. Add environment variables in Vercel project settings:
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
4. Attach Vercel KV (Upstash) to the project and use its REST values.
5. Deploy.

No build command is needed. Vercel serves static files and runs `api/signal.js` as a serverless function.

## Usage

1. Open the deployed URL on two or more devices on the same hotspot/LAN.
2. Use the same room name.
3. Click `Join` on each device.
4. Send broadcast (`*`) or direct message to peer ID.
5. Increase/decrease TTL for relay scope.

## Security Model Snapshot

- Each node has persistent identity key and ECDH key in IndexedDB.
- HELLO packets are signed.
- Per-peer shared secret is derived with ECDH.
- Each message advances a symmetric chain (ratchet-like), deriving a fresh AES-GCM key.
- No message content is stored on central servers.

## Browser Support

- Best on Chromium-based browsers for WebRTC + Web Bluetooth.
- Safari/WebKit may have partial behavior for some APIs.
