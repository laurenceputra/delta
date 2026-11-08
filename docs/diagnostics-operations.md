# Diagnostics operations

Diagnostics are optional. GPS tracking works without storage, upload credentials, analysis access or a network connection after the app assets are cached.

## Hosted configuration

Preserve the existing Sites project, domain and public audience. The hosting manifest declares `DIAGNOSTICS_DB` (D1), `DIAGNOSTICS_BUCKET` (private R2) and the MCP capability. Set runtime values in Sites settings; never put values in Git, chat, frontend assets, build output or logs.

| Runtime key | Meaning |
| --- | --- |
| `DIAGNOSTICS_UPLOAD_KEY` | Shared upload secret, at least 6 characters. Required only for uploads. |
| `DIAGNOSTICS_ANALYST_EMAILS` | Comma-separated verified owner email allowlist for analysis and maintenance. Empty denies access. |
| `DIAGNOSTICS_RETENTION_READY` | Set to `true` only after testing daily unattended cleanup. Other values disable uploads. |

After changing hosted configuration, follow the instructions in Sites settings and republish when required. Keep credentials out of archive exports. Rotation of the upload key invalidates old one-hour cookies; re-enter the new key to resume a partially uploaded recording with its device-held per-recording capability.

The public driving page does not require sign-in. Enter the upload key and acknowledge being parked before uploading. The key creates a Secure/HttpOnly/SameSite upload-only cookie. Each recording additionally requires its random `X-Upload-Token`; this token is stored only with that local recording and deleted on verified completion. The shared key grants no analyst access.

## Local limits and lifecycle

All recordings share 50 MiB of stored diagnostics; recording stops rather than evicting an unexpired recording. A drive stops at two hours, 10 MiB compressed or 50 MiB expanded. Writes reserve 20 MiB of reported device space. GPS callbacks are stored in ordered bounded gzip chunks, including rejected fixes and signal errors. A browser can stop delivering GPS or terminate the page; no background positions are invented and interrupted recording does not automatically resume.

Unuploaded recordings expire after seven days, with cleanup when the app opens or recording starts. Upload retries are idempotent. The local copy is deleted only after every chunk and the final server checksum map match. At most 100 small receipts are kept for 30 days. Export and deletion remain available if uploading fails.

## Server retention and maintenance

Incomplete uploads expire after 24 hours and completed recordings after 30 days. Reads enforce expiry immediately. A daily Sites-linked cloud task invokes the owner-authorized `cleanup_expired` tool, following returned continuation state until complete, then reads back a summary. It removes expired records/chunks, abandoned R2 objects and unused road-data snapshots. Do not enable uploads until this operation works through fresh unattended access. A saved schedule alone is not proof that it runs.

## Analysis and backup

Publishing the MCP capability provisions a private plugin for the owner. Connect that plugin in ChatGPT if it is not installed automatically. Read-only tools list recordings, return summaries, retrieve bounded event chunks and export original gzip chunks. Only allowlisted, platform-authenticated analyst identities can read them. Maintenance deletion is a separate, explicitly destructive tool.

To investigate, identify a recording, retrieve its manifest and chunks, and assemble the portable export `{manifest,chunks:[{index,data}]}`. `data` is base64 gzip. Retrieve the matching road-data snapshot when the checkout differs; verify the SHA-256 of exact roads JSON bytes followed by expanded local-roads JSON bytes. Keep exports in ignored `recordings/` and reports in `reports/`.

Follow [the replay guide](diagnostics-analysis.md). Replay uses a controlled clock and reports observed GPS separately from inferred roads. A candidate engine may produce different decisions; the manifest's original build identifies the released implementation. Never commit real drive traces to the public repository.

For an independent backup, export the manifest, all original chunks and matching road-data files. Validate their checksums and run replay from that archive before relying on it. GitHub and Site code rollback do not back up database records or uploaded files. Do not promise point-in-time recovery from a source commit.

## Build and release

`npm run build` generates the content version, Worker and static assets. Package `.openai/hosting.json`, `dist/server`, `dist/client`, and the immutable `drizzle/` SQL/metadata from the exact pushed commit. Production publishing applies schema migrations; local development applies them with `npm run db:migrate:local`. Never create tables during a request. Verify existing driving tests, backend authorization/limits, replay, browser storage behaviour and mobile layout before publishing.
