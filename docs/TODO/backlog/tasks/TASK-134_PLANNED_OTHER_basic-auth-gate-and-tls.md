---
id: TASK-134
title: 'Basic-auth gate (shared secret) + TLS on the sidecar, applied to all routes incl. image/metadata endpoints'
investigation: INV-034
status: planned
priority: medium
blocked_by: [TASK-129]
date_created: 2026-06-20
date_completed:
files:
  - 'src/server/auth.ts (new — auth middleware)'
  - 'src/server/index.ts (TLS option + middleware wiring)'
  - 'src/backend/http-backend.ts (send auth header)'
---

## What

Add a single shared-secret / basic-auth gate to the sidecar and a TLS option (self-signed cert or documented reverse-proxy). The gate applies to **every** route — DataStorage reads, `/original`, `/thumb`, `/preview`, metadata — because the server serves real local files. The web client (`HttpBackend` and image URLs) sends the credential.

## Why

"Just me, remote" still opens a network port to real local files; auth + the location-scoping guard (TASK-128) are the security boundary. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Requirement 11; Blast Radius 13; Risks 4).

## Implementation Steps

- [ ] 1. Create `src/server/auth.ts`: middleware validating a basic-auth credential or shared secret from config/env. Reject unauthenticated with 401. Apply globally before all route handlers (data, images, metadata).
- [ ] 2. Add TLS in `src/server/index.ts`: support an HTTPS listener with a provided cert/key (or generate a self-signed cert for local use) and document the reverse-proxy alternative.
- [ ] 3. Make `HttpBackend` (TASK-127) attach the auth header to every `fetch`. For image `<img src>` URLs that cannot carry headers, choose and implement a token mechanism (e.g. a signed cookie set after auth, or a query token validated by the middleware) so `/original|/thumb|/preview` are also gated.
- [ ] 4. Confirm the auth path does not interfere with COOP/COEP/CORP (TASK-128/129).

## Done When

- [ ] Unauthenticated requests to any route (data, image, metadata) return 401.
- [ ] An authenticated browser session browses normally over HTTPS.
- [ ] Image endpoints are gated (token/cookie), not publicly fetchable.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** auth/TLS is server-only and additive; confirm the portable desktop build is unaffected. Capture evidence.
