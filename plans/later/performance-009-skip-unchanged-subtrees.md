# Performance 009: a Story Sync scan reads only what changed

**Why and when:** Joe, 2026-11-16, while Performance 007 cut a collection row edit to the
cost of a note edit: what is left of every sync is the scan of the folder, which re-reads
every Markdown file each time. He asked for a plan for the file-stat work, to do later.

## What a scan costs now

Measured 2026-11-16 with `tests/performance/collection-sync.ts` (200 notes, a 5,000-row
collection; CPU per sync from `process.cpuUsage`, profiled with `--cpu-prof` and a 0 vs 40
sync difference):

- An idle sync, nothing changed: about 15 ms of CPU, ~25 ms wall.
- About 11 ms of that is `fileSource` in `packages/fs/src/protocol-tree.ts` for Markdown files:
  each is read, hashed and recorded again on every scan. A non-Markdown file is trusted by its
  stat tuple (`SnapshotObjectIndex.fileHash`), but `fileSource` skips the index for `.md`
  names (`!markdownName(name)`, since 8e4ae386, 2026-09-09, with no reason given), and in page
  mode `pageSource` re-reads and re-parses every Markdown file before any index lookup.
- About 9.5 ms is `ObjectIndex.rememberObject` (`packages/story-sync/src/state/object-index.ts`):
  one SQLite upsert per Markdown file per scan, each through a freshly `prepare`d statement,
  each its own transaction, rewriting a row that hasn't changed.
- Every directory is walked: `readdir`, then a `stat` per file (two for a changed one), and
  every directory object is re-encoded and re-recorded. `SnapshotObjectIndex.directoryHash`,
  which would let an unchanged subtree be adopted without walking it, has no implementation.

So a scan grows with the number of files in the folder, not with what changed: 200 notes cost
~15 ms; Joe's real trees, with thousands of pages, cost proportionally more on every sync.

## Steps

1. **Find why Markdown skips the stat cache**, before changing it. Check who reads a Markdown
   file's bytes during a scan (source documents and their provenance, document binding, page
   conversion) and whether any of them relies on the scan having read them. A cached entry
   still serves its bytes through the lazy loader, as other files do.
2. **Trust a Markdown file by its stat tuple**, as other files are, in both modes. In page
   mode the index row is a `page` row naming the page object, and the row records the mode it
   was read in, so a change of mode re-reads. A file whose tuple matches isn't read or parsed.
3. **Write the object index only when a row changes**, through cached statements (`query`),
   all of a scan's writes in one transaction. An unchanged row is not rewritten.
4. **Skip unchanged subtrees.** Story Sync's watcher knows which directories had events
   since the last scan; a directory with none below it keeps the hash the last scan gave it
   (`directoryHash`, and the directory bytes the index keeps). The interface allows this only
   for callers that verify the produced object afterwards, so the scan checks the adopted
   hashes against the objects the index holds, and a watcher gap or the periodic
   revalidation (already in `FilesystemObjectSource`) falls back to a full walk.
5. **Prove it** with `collection-sync.ts` and a variant with 5,000 notes: an idle sync should
   cost a few milliseconds whatever the number of files, a one-note edit about the same plus
   that note, with the same objects and roots as a full walk (a differential test of the
   scan with and without the index and the subtree shortcut).
