# Filesystem 029: the host refuses Markdown files that read as pages

**Why and when:** left from Filesystem 026 when it closed on 2026-11-16
([status](../../status.md#pages-as-logical-nodes-built--2026-10-28)). Every client writes
Markdown as a page whenever its front matter parses, and the live host held no Markdown file
entries (121 pages, 0 files, 2026-11-16). When needed: when a client other than Story, Story
Sync or the CLI writes to a host, or a Markdown file entry turns up in a head.

## Status

**PLANNED · not started · S effort in the host, M in its tests.**

## The change

- On a client's candidate (`validateGraph` from `submitCandidate`, not the host's own writes or
  a mirrored remote tree), a new or changed file entry with a page name whose bytes parse as a
  page is refused ("write it as a page"). `validateGraphChange` already decodes exactly the
  changed directories; the check reads only `.md` file entries the basis doesn't hold.
- Tried 2026-11-16: about 110 host tests write `note.md` (and a few other `.md` names) as file
  entries. Renaming them to `.txt` fixes about 80; the other 30 test Markdown merging (prose
  insertions, paragraph moves, Markdown rule output, folder choices with `.md` files) and must
  write pages instead, reading text back with `decodeProtocolPage(...).body`.
- Before it deploys, check on a backup that no head holds such an entry.
