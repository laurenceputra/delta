# Delta SG

A Cloudflare-hostable foreground PWA prototype for Singapore expressway speed and reference timing. No paid map APIs, navigation destination, Android Auto integration, or journey upload.

## Run

Requires Node 20+ and Python 3 for the development server. No runtime dependencies.

```sh
npm test
npm run check
npm run dev
```

Open http://localhost:4173. Live device location requires HTTPS (localhost is an exception). A phone needs the deployed HTTPS address; another machine's localhost is not a phone preview. Allow precise location before driving, keep the PWA foregrounded, and use the screen wake lock where supported. Demo controls simulate movement over the same road geometry as live mode.

For a personal Cloudflare account, `npx wrangler deploy` uses `wrangler.jsonc`. Installable manifest, icons, service worker and road bundle are included. The Sites deployment is private by default.

## Product behaviour

- Detect expressway/direction from successive device fixes, heading and geometry.
- Follow the current mainline, show up to three mapped exits ahead, update as exits pass.
- Compare actual elapsed time with reference travel time over matched distance. Negative delta means ahead/faster; positive means behind/slower. A positive delta is not permission to exceed the posted speed limit.
- Starting midway means tracking since detection, not reconstructed entrance history. Road changes and uncertain fixes can restart the reference session.
- Missing speed limits produce no delta; missing exits produce no invented destinations.
- Forecasts assume continuation at the displayed speed; actual future traffic and driving may differ.
- GPS gaps, tunnels, parallel roads and flyovers can prevent dependable tracking. This is advisory software, not a calibrated speedometer or enforcement-compliance assessment.

## Data and enforcement

See `dist/data/` for source provenance, coverage and the audit. OSM data is subject to ODbL and OpenStreetMap contributor attribution. Data age and gaps matter: road signs and current restrictions remain authoritative. No API key is required at runtime.

EASE (Expressway Average Speed Enforcement) is distinct from journey timing. No official BKE or island-wide EASE boundary is inferred from ordinary entrance/exit ramps. Until official paired boundaries, measured distances and rules are verified, the app provides no EASE compliance result.

Research sources:
- https://www.mha.gov.sg/media-room/newsroom/stepping-up-enforcement-efforts-to-reduce-accidents-involving-cyclists/
- https://www.channelnewsasia.com/singapore/traffic-accidents-injuries-deaths-2026-police-6342626
- https://datamall.lta.gov.sg/content/datamall/en/static-data.html

## Before relying on live results

Replay tests validate calculations and data wiring. They do not replace passenger-operated field validation on all expressways, in both directions, during Android Auto operation and through tunnels. Browser position updates have no guaranteed cadence. Never interact with controls while driving.

## Validation completed

Eight engine tests and three integration tests pass. The integration replay covers twenty long directed paths with over 15,000 comparable fixes, checking timing continuity and duplicate-free exit rows. Chromium checks covered live BKE identification with injected device positions, all ten demo selectors, mobile/desktop layouts, offline reload, location-error clearing, recovery and the stale-fix watchdog. These tests use simulated positions, not road measurements.
