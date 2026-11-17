# Delta SG

A Cloudflare-hostable foreground driving companion for Singapore: know your speed and see what is ahead. Everyday view prioritises speed, limit references and upcoming expressway exits; Pace adds expressway-only reference timing. Optional diagnostics can be recorded locally and explicitly uploaded while parked. No paid map APIs or navigation destination are required.

## Run

Requires Node 24+ for the SQLite-backed backend tests. The driving interface remains plain JavaScript; Wrangler provides a local Worker with D1, R2 and static assets.

```sh
npm ci
npm run build
npm run db:migrate:local
npm test
npm run check
npm run dev
```

Open http://localhost:4173. Live device location requires HTTPS (localhost is an exception). A phone needs the deployed HTTPS address; another machine's localhost is not a phone preview. Allow precise location before driving, keep the PWA foregrounded, and use the screen wake lock where supported. Demo controls simulate movement over the same road geometry as live mode.

The Sites deployment remains public; the upload API and analysis tools have separate server-side authorization. `wrangler.jsonc` uses placeholder identifiers for local development, not direct production deployment. Publish the generated Worker and assets through the existing Sites project. See [diagnostics operations](docs/diagnostics-operations.md) for hosted configuration, retention and backup.

## Product behaviour

- Identify mapped public motor roads and ramps using a spatial index, heading and recent fixes. Display GPS speed everywhere; change the visible road after two seconds of reliable evidence while independently retaining timing for recovery.
- Switch Everyday / Pace on the main screen without restarting the tracker. The device saves the view preference. Fresh installs default to Everyday; identifiable existing installs retain Pace. Both views show critical GPS and overspeed signals; timing and exit projections are shown only in Pace. Upcoming exits require confirmed expressway tracking.
- Light, Dark and System themes follow a saved device preference. The separately labelled Screen awake control manages wake lock.
- Updates download in the background. A waiting update activates at the visible parked gate before the first session in a fresh page. Active or resumed sessions never auto-reload, including after switching modes. An explicit parked update remains available in Settings; other open Delta windows block activation. Offline/failed startup checks are bounded so the installed app remains usable. Existing v0.5.0 clients need one parked update to receive this policy.
- Follow the current mainline, show up to three mapped exits ahead, update as exits pass.
- Compare actual elapsed time with reference travel time over matched distance. Negative delta means ahead/faster; positive means behind/slower. A positive delta is not permission to exceed the posted speed limit.
- Preserve early entrance evidence through GPS loss. Retain a separate latest reliable pre-entry timing anchor, upgrading it to an observed boundary fix or a bracketed crossing when supported. Unobserved crossing times stay estimated. Shared ramps carry candidate destinations rather than an originating expressway's inherited identity; confirmed new local-road entries cannot reuse an unrelated old delta.
- During a GPS gap, speed is unavailable and the last known road, limit and pace are clearly labelled. Supported directed routes can restore estimated full-session timing with piecewise limits. After ten seconds of reliable unresolved recovery evidence, archive the incomplete earlier journey and start a distinct session since GPS recovery. Weak or missing intervals do not consume that recovery budget.
- Missing or implausible speed tags use a visibly marked assumed 50 km/h reference. The current limit and cumulative use of assumed reference segments are shown separately. Missing exits produce no invented destinations.
- Exit projections assume the current GPS speed continues to each exit; reference time still follows every mapped or assumed speed-limit segment. Projections disappear when stopped or GPS is stale. They are estimates, not a recommended speed.
- GPS gaps, tunnels, parallel roads and flyovers can prevent dependable tracking. This is advisory software, not a calibrated speedometer or enforcement-compliance assessment.

## Drive smoothness Beta

Settings offers **Enable beta for this drive**, off on each fresh page. Enable while parked with the phone firmly mounted. A direct tap requests motion permission where required. A three-second rolling warm-up learns sensor orientation and can finish while moving; individual bumps do not restart it. Missing or denied sensors leave feedback neutral/off.

Beta starts local diagnostics on the first valid sensor sample, including warm-up (or shares an existing manual recording without taking ownership). Routine raw samples are capped at 10 Hz; state transitions also retain their exact triggering sample and rule evidence. The existing two-hour, 10 MiB compressed / 50 MiB expanded recording limits, 50 MiB local budget and seven-day local retention remain. Disabling Beta stops only its own recording. **BETA · REC OFF** pauses feedback if recording stops or reaches a limit.

The optional inset border estimates motion smoothness from filtered acceleration and jerk: green to amber/red, with gradual decay and no flashing. Gray indicates learning, sensor gaps or stability checks. Reduced-motion settings remove transitions. Vehicle yaw is excluded from mount-tilt checks. Brief disturbances recover automatically after a stable second; a sustained changed mount pose requires **Restart setup while parked**. Screen rotation alone does not permanently invalidate the learned pose. The Beta labels generic abrupt motion and vertical bumps, not braking, turning or unsafe driving, and does not establish a vehicle forward axis. Missing GPS lowers confidence without stopping valid motion sensing.

Uploads pack the small, crash-safe local chunks into groups capped at **1 MiB compressed and 8 MiB expanded**, with two concurrent requests, bounded timeouts/retries, verified-byte progress and checksum-based resume. Original local chunks remain until completed server verification. Packing metadata is retained without storing a second payload copy; the upload key is never saved. Analyst reads page events and compressed bytes to keep responses bounded.

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

## App v0.4.2

Exit projections assume the current GPS speed continues, against a reference that follows each mapped limit. Their heading identifies this assumption. Ramp role is separated from downstream destination: shared exit paths can show Leaving PIE while retaining branch uncertainty, and a ramp heading follows the two-second visual confirmation. A shared physical boundary is retained only when all compatible paths agree.

## App v0.4.0

Diagnostics recording is opt-in and persists bounded gzip chunks in IndexedDB. All local recordings share a 50 MiB budget, expire after seven days, and stop at two hours or the per-recording limits. Successful checksum-verified uploads remove local chunks and retain a small receipt. Upload authorization is separate from owner-only analysis through the Site's MCP tools. Backend setup and retention must be verified before enabling uploads. The memory-only recorder and its old 10,000-event limit have been removed.

## App v0.3.2

During GPS loss, a confirmed expressway session keeps its elapsed clock and shows the last valid pace in a muted **LAST KNOWN** state with age. Live speed and pace forecasts remain unavailable until the mapped route is recovered from fresh fixes. Last-known exit names and distances are marked stale. A recovered comparison remains an estimate, and an unresolved route cannot claim a full-session pace. A completed expressway segment is archived in Settings and no longer shown as an active delta on local roads.

## App v0.3.7

A reliably detected current road appears after two consistent fixes over two seconds. A prior expressway delta stays visibly paused while the route is checked. It is dismissed only after 20 seconds of reliable evidence for a local road, rather than after a wall-clock timeout; GPS loss alone does not count. Confirmed local roads replace stale ramp labels.

## App v0.3.6

An entrance approach can anchor an estimated session clock before a confirmed mainline fix. GPS, road identification, and pace status are shown separately so a retained road does not imply a fresh position. Optional local diagnostics are off by default; an explicit Settings control records a bounded in-memory trace that can be exported as JSON or cleared without uploading.

## App v0.3.5

The dashboard follows a reliably detected current road after two consistent fixes over two seconds. Current GPS speed and the current mapped or assumed limit take precedence over a paused prior expressway delta.

## App v0.3.4

Mapped ramp paths can show provisional **Possible entry to** or **Possible exit from** a named expressway. After travel confirms the directed path, the header shows Joining, Leaving, or Transfer. Unknown ramp direction stays explicitly unconfirmed. Mainline timing remains inactive on an entry ramp; a pending exit holds the last known pace, then archives the session when the mapped divergence is sufficiently observed. A transfer across a unique mapped expressway connector keeps the original session. Any displayed crossing time is an estimate from GPS fixes, not an official enforcement boundary.

## App v0.3.3

The driving dashboard keeps speed on the left, pace on the right, and exits below across local roads, route confirmation, GPS gaps, and confirmed mainlines. Inactive pace says “Expressway only”; a provisional first fix says “Entry recorded — awaiting GPS”. Road state changes do not rearrange the instruments.

## App v0.3.1

The driving instruments size to their content, keeping the speed value, limit, and limit source inside the card at narrow widths and larger text settings. Compact views retain three exit rows and the bottom safety gutter.

## Updating an installed copy

The installed code identifies itself in Settings as **App vX.Y.Z · build ABC123…**. The app release number comes from `package.json` and is distinct from the Sites hosting version. The build ID is a deterministic hash of runtime assets and the service worker template, so even an accidental same-version content change produces a new worker cache. For each release, bump `package.json` and run `npm run build:version`; that generates `dist/version.js`, `dist/version.json`, and `dist/sw.js`. `npm run check` fails if these generated files drift from the source.

The service worker precaches the compressed local-road bundle (about 1.9 MB transfer; roughly 17 MB expanded JSON). The plain JSON fallback supports browsers without DecompressionStream and is cached after use. A new worker installs in the background and waits. Settings shows **Update ready** when it is installed; **I’m parked — update** activates it and reloads this tab after activation. Active drives never reload automatically. Closing all old tabs allows a waiting worker to activate naturally on the next launch. The previous pre-v0.3.0 worker cannot show the new waiting notice, so close and reopen once to migrate. Offline launches use the last installed assets and display that build’s version; the label does not claim that it is the latest online release. A failed update check leaves the current drive and installed build intact. Newer road data is still a snapshot, not a live road feed.
