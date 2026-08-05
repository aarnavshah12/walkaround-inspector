# Walkaround Inspector

Mobile-first web app (PWA) for timestamped walkaround video inspections of rental cars. Record a slow walkaround in the browser; the video's SHA-256 is computed on-device and RFC 3161 timestamped the moment recording stops; the video then uploads via resumable chunks to a server-side pipeline (Roboflow Workflows) that detects scratches/dents/stains, rejects reflections via temporal parallax, and returns a cryptographically signed PDF report.

## Layout

- `web/` — Next.js PWA client + thin API (capture timestamping, chunked uploads)
- `workflows/` — Roboflow Workflow definitions (video pipeline, enrichment, eval)
- `data/` — local runtime storage (gitignored)

## Dev

```bash
cd web
npm install
npm run dev          # http://localhost:3000
npm run dev:https    # HTTPS for phone testing (camera + WebCrypto need a secure context)
```
