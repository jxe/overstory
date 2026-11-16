# Filesystem 026: no Markdown files

**Why and when:** pages are logical nodes, written to disk by each placement
([status](../../status.md#pages-as-logical-nodes-built--2026-10-28),
[spec 02 §9](../../docs/overstory-spec/1.1-data-model.md#9-properties-markdown-content-and-identity)).
Since 2026-11-16 the host has no conversion code, trees it makes start with a page, the
descriptor no longer says `pages`, and every client (TypeScript and Swift) writes Markdown as
a page whenever its front matter parses (Joe, 2026-11-16: he is the only client, so no
transition). Moves, copies, lineage and Move to Document on pages now address the page body in
both clients (main bd05c37, 79a5148f, 2026-11-16; all 7 `LiveEditorAdmissionTests` pass). One
step is left. Provenance for page bodies and the front-matter merge cases
are [Filesystem 028](../later/filesystem-028-page-body-provenance-and-front-matter-merges.md).

## Status

**PLANNED · S effort · low risk.** Host only; take it with
[Performance 010](performance-010-mailboxes-and-change-feed.md), which reworks the accept
path the check goes on.

## The host refuses a Markdown file entry that reads as a page

- On accept, a candidate's new or changed file entry with a page name whose bytes parse as a
  page is refused ("write it as a page"). A file whose front matter doesn't parse stays a file.
- About 120 host tests (`source-acceptance`, `snapshot-acceptance` and others) write `note.md`
  as a file entry; they move to `.txt` names or to pages first.
- Before it deploys, check on a backup that no head holds such an entry.
