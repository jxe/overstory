# 034-protocol-003: Protocol 003's flag day (schema 32 → 34)

Ran on the live host on 2026-11-16. Keep this directory until the backup below
has aged out (two weeks), then delete it with its `Dockerfile.overstoryd` line.
It ran from `migrations/next`, the path its runbook below names.

## Cutover record (2026-11-16)

- **Rehearsals** on the Nov 9 backup, then on a fresh live backup taken at
  16:40Z (`/data/backups/p003-20261116T164035Z`; local
  `.backups/railway/20261116T164035Z`, sha256 checked): 28 trees, 15,292
  updates dropped, 12 pages, 5 collections and 5 schemas converted, 111 Game
  rows in the games tree clamped (`created` was later than `modified`), nothing
  conflicted or undated. `run.ts` 1.6 s, cold start 0.2 s, `verify.ts` ok, all
  five collection databases built. `compare-overstoryd-roots.ts` cannot read
  across the format change, so `verify.ts` and the fingerprint check stood in.
- **Live:** deploy of 87c7d8e1 served maintenance; the first `run.ts` failed
  before writing (the image lacked `tools/convert-usl-to-beetle.ts`; df66b9b8
  copies it). The second run: schema 34, 15,295 updates dropped, 27 of 28 roots
  equal to the rehearsal's (todos differed by the 3 updates after the backup),
  `verify.ts` ok.
- **Mac:** Story Sync's state version bump archived only the old `sync/`
  layout, so placements kept old roots. Fixed by archiving `trees/`,
  `accounts/*/refs` (a4e16fac) and the configuration ref in
  `connection.json` (34515bbe); a placement that fails now logs why
  (41f84b1b). games-sandbox's old projection was moved aside and placed again.
  All five placements idle, `verify.ts --sync` ok, authored manifest unchanged
  outside games-sandbox, page and row round trips clean.
- **Release:** Quagmire 0.17.0, Story 0.2.0 (Mac, TestFlight build 2059);
  npm by Joe.
- The redeploy of 41f84b1b failed after a clean build (deploy log empty),
  leaving about 2.5 minutes without service at 17:31Z; the next deploys
  succeeded.

## Steps

Two steps, from schema 32 to 34.

| Step | Change | Product change at cutover |
|---|---|---|
| [033-device-clients](steps/033-device-clients.ts) | `devices.clients`: a JSON object of the clients a device last named itself as, by product (Joe, 2026-11-08) | `AccountDirectory.noteClient` also writes `devices.clients` when a product's name changes (it already logs it); `AUTHORITY_SCHEMA.devices` and `createHostSchema` gain `clients`; `overstoryd report` lists each device with its label, last use and clients |
| [034-protocol-003](steps/034-protocol-003.ts) | Each tree's history becomes one first update holding its head in the new format, written beforehand by [`protocol-003.ts`](protocol-003.ts): entry times from history, Markdown files that read as pages become pages, `.mdx` pages become files, rows get Unix-ms times and tagged dates, and each collection's `schema.usl` becomes the `schema.beetle` it converts to (`tools/convert-usl-to-beetle.ts`, which keeps the model fingerprint). `document_versions` is emptied, `entry_metadata` dropped, profile facts reread. `run.ts` then deletes `provenance/`, `materialized/`, `entry-times.sqlite3` and the exec mutation receipts | Protocol 003 and every Protocol 001 move (plans/soon): new object format and wire forms; Protocol 002's index, `?times` and `entry-metadata` are gone. Mac, iPhone, CLI and Story Sync are replaced together, and every placement is placed again |

## Running it

`run.ts <data-root>` lists TreeIDs and DeviceIDs shorter than the spec allows
(`shortIds`), writes every tree's new head to the object store, then runs both
steps in one transaction and the product's schema and data checks. Its report
names each tree's new root (`trees`, as `tools/verify.ts` reads it), how many updates were dropped, what was
converted, and any tree whose head had decisions open (`conflicted`: the fresh
entry has none). Rehearse it on a copy of `/data` with a cold start of the new
build afterwards, timing the provenance backfill of every first entry.
