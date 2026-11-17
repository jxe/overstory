# Performance 009: a Story Sync scan skips unchanged folders

**Why and when:** Joe, 2026-11-16: every sync scanned the whole folder. Steps 1 to 3 of this
plan are done ([status](../../status.md#quick-plans-from-later-and-when-needed--2026-11-17)):
Markdown is trusted by its stat tuple, a directory's files are statted together, and the
object index is written only when a row changes. A warm scan of 5,000 notes in 50 folders
went from about 1.15 s to 70 ms. What is left is the per-file cost that remains: every scan
still lists every directory, stats every file and looks up its index row, about 14 µs a
file. Take this when a real tree's idle sync shows that cost.

## Skip unchanged subtrees

Story Sync's watcher knows which directories had events since the last scan; a directory with
none below it can keep the hash the last scan gave it (`SnapshotObjectIndex.directoryHash`,
declared and unimplemented, and the directory bytes the index already keeps).

- **The race to close first.** A scan right after a write can run before the watcher's event
  arrives: an agent run that publishes as soon as Claude finishes, or `story sync` straight
  after an edit. An adopted subtree would then miss the write until the next event. A
  directory may be adopted only while the watcher has confirmed it is caught up to the
  scan's start (a sentinel write and its event, or the FSEvents event ID), otherwise walk.
- **Objects of an adopted subtree.** The walk's lazy snapshot holds no objects for a subtree
  it didn't walk. When the adopted hash differs from the tracked root's (unpublished local
  changes), its objects must come from the filesystem object source (`FilesystemObjectSource.bytes`),
  which already serves files, pages and directories from the index.
- **Encoding inputs.** A directory's encoding also depends on its basis times, ignore rules,
  boundaries and collection projection. Invalidate on each (ignore files already drop
  directory rows).
- **Safety net.** The scan checks adopted hashes against the objects the index holds; a
  watcher gap and the periodic revalidation (already in `FilesystemObjectSource`) fall back
  to a full walk.

**Prove it** with `tests/performance/collection-sync.ts` (`FILES=5000`; idle syncs report
CPU) and a differential test: the same objects and roots as a full walk, including a write
made just before the scan.
