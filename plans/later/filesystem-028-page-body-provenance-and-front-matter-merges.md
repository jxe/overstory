# Filesystem 028: provenance for page bodies, and front-matter merge cases

**Why and when:** pages are logical nodes since Filesystem 026
([status](../../status.md#pages-as-logical-nodes-built--2026-10-28)), and since the
Protocol 003 flag day every tree on the live host holds its Markdown as pages. Two deeper
follow-ups were left in Filesystem 026; Joe split them out on 2026-11-16 so that plan could
be the cleanup alone.

## Status

- **Effort:** M.
- **Risk:** MEDIUM: both touch merges.
- **Overlaps:** the change feed (`packages/overstoryd/src/change-feed.ts`,
  [status](../../status.md#performance-010-a-change-feed-group-commit-and-tree-mailboxes--2026-11-16)),
  which can make the provenance indexer a consumer with its own cursor, and [History 007](history-007-page-history.md) (line provenance).

## 1. Provenance for page bodies

The provenance index (Performance 004,
[format](../../docs/architecture/overstoryd/provenance-index.md)) and line provenance
([History 007](history-007-page-history.md)) index page bodies, not only file bytes. Until
then a copy out of a page's body goes as a snapshot.

## 2. Front-matter merge cases

Close the overstoryd 014/015 front-matter cases that per-property merge now covers (the
"Per-key frontmatter conflicts" candidate moved here).

Known simplification to revisit while here: page lists merge member by member as ordered
lists.
