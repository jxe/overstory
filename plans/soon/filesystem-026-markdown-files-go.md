# Filesystem 026: moves and copies in page bodies, and no Markdown files

**Why and when:** pages are logical nodes, written to disk by each placement
([status](../../status.md#pages-as-logical-nodes-built--2026-10-28),
[spec 02 §9](../../docs/overstory-spec/1.1-data-model.md#9-properties-markdown-content-and-identity)).
Since 2026-11-16 the host has no conversion code, trees it makes start with a page, the
descriptor no longer says `pages`, and every client (TypeScript and Swift) writes Markdown as
a page whenever its front matter parses (Joe, 2026-11-16: he is the only client, so no
transition). Two steps are left. Provenance for page bodies and the front-matter merge cases
are [Filesystem 028](../later/filesystem-028-page-body-provenance-and-front-matter-merges.md).

## Status

**PLANNED · M effort · medium risk.** Step 1 is both clients and the merge engine; step 2 is
host only; take step 2 with
[Performance 010](performance-010-mailboxes-and-change-feed.md), which reworks the accept
path the check goes on.

## 1. Moves and copies in a page's body

Both clients state a page edit that carries lineage or copies as a snapshot (TypeScript's
`prepareSourceChange`, `local-change.ts` "a copy out of a page"; Swift's `ChangeLog`), though
the spec already lets `moveSource` and `copySource` address a page's body (updates §2.5). So on
a page, block moves, cross-page copies and Move to Document lose their operations, and a merge
with a peer's concurrent edit is worse, not only less exact: 5 of Story's 7
`LiveEditorAdmissionTests` fail on it (found 2026-11-16). Every live tree is pages, so this is
how Story works today.

- Clients state moves and copies over page bodies as `moveSource` / `copySource` with body
  ranges, as for files; the merge engine replays them (check it does across two pages).
- The live editor admission tests pass unchanged.

## 2. The host refuses a Markdown file entry that reads as a page

- On accept, a candidate's new or changed file entry with a page name whose bytes parse as a
  page is refused ("write it as a page"). A file whose front matter doesn't parse stays a file.
- About 120 host tests (`source-acceptance`, `snapshot-acceptance` and others) write `note.md`
  as a file entry; they move to `.txt` names or to pages first.
- Before it deploys, check on a backup that no head holds such an entry.
