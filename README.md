# Delta SG

A Cloudflare-hostable foreground PWA prototype for Singapore road names and GPS speed, with expressway-only reference timing. No paid map APIs, navigation destination, Android Auto integration, or journey upload.

## Run

Requires Node 20+ and Python 3 for the development server. No runtime dependencies.

```sh
npm test
npm run check
npm run dev
```

Open http://localhost:4173. Live device location requires HTTPS (localhost is an exception). A phone needs the deployed HTTPS address; another machine's localhost is not a phone preview. Allow precise location before driving, keep the PWA foregrounded, and use the screen wake lock where supported. Demo controls simulate movement over the same road geometry as live mode.

For a personal Cloudflare account, `npx wrangler deploy` uses `wrangler.jsonc`. Installable manifest, icons, service worker and road bundle are included. The current Sites deployment is public; access is managed through Sites.

## Product behaviour

- Identify mapped public motor roads and ramps using a spatial index, heading and recent fixes. Display GPS speed everywhere; hold a new road candidate for six seconds before changing a confirmed route.
- Enable delta and upcoming exits only on confirmed mainlines of the ten expressways. Suppress timing at ambiguous local-road/expressway overlaps.
- Light, Dark and System themes follow a saved device preference. The separately labelled Screen awake control manages wake lock.
- Follow the current mainline, show up to three mapped exits ahead, update as exits pass.
- Compare actual elapsed time with reference travel time over matched distance. Negative delta means ahead/faster; positive means behind/slower. A positive delta is not permission to exceed the posted speed limit.
- Starting midway may anchor a provisional clock at the first credible mainline fix, before route confirmation; this is not a physical entrance crossing. If GPS disappears before confirmation, the provisional road and clock remain visible, but speed, delta and exits are withheld until a plausible directed route is confirmed. During a GPS gap, live speed and pace disappear while the entry clock and last confirmed road remain. A unique directed mapped path can restore estimated full-session timing; ambiguous routes keep the entry clock but withhold a full-session pace comparison.
- Missing or implausible speed tags use a visibly marked assumed 50 km/h reference. The current limit and cumulative use of assumed reference segments are shown separately. Missing exits produce no invented destinations.
- Forecasts cap projected travel speed at each mapped or assumed future segment limit; actual future traffic and driving may differ.
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

Engine and integration replay tests cover directed route continuity, local-road transitions, GPS gaps, tunnel reconstruction and ambiguous paths. Chromium checks cover theme persistence, compact live and demo layouts, three visible exits on small screens, and offline assets. These tests use simulated positions, not road measurements.

## App v0.3.1

The driving instruments size to their content, keeping the speed value, limit, and limit source inside the card at narrow widths and larger text settings. Compact views retain three exit rows and the bottom safety gutter.

## Updating an installed copy

The installed code identifies itself in Settings as **App vX.Y.Z · build ABC123…**. The app release number comes from `package.json` and is distinct from the Sites hosting version. The build ID is a deterministic hash of runtime assets and the service worker template, so even an accidental same-version content change produces a new worker cache. For each release, bump `package.json` and run `npm run build:version`; that generates `dist/version.js`, `dist/version.json`, and `dist/sw.js`. `npm run check` fails if these generated files drift from the source.

The service worker precaches the compressed local-road bundle (about 1.9 MB transfer; roughly 17 MB expanded JSON). The plain JSON fallback supports browsers without DecompressionStream and is cached after use. A new worker installs in the background and waits. Settings shows **Update ready** when it is installed; **I’m parked — update** activates it and reloads this tab after activation. Active drives never reload automatically. Closing all old tabs allows a waiting worker to activate naturally on the next launch. The previous pre-v0.3.0 worker cannot show the new waiting notice, so close and reopen once to migrate. Offline launches use the last installed assets and display that build’s version; the label does not claim that it is the latest online release. A failed update check leaves the current drive and installed build intact. Newer road data is still a snapshot, not a live road feed.
