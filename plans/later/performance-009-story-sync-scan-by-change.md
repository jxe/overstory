# Performance 009: Story Sync scans cost by change, not by tree size

**Why:** Joe asked on 2026-11-16, once Performance 007 had made a collection row edit as cheap
as a one-file note edit (about 55 ms of CPU on the 5,000-row benchmark). Most of what is left
is the scan every sync does: about 25 ms with 200 notes, and it grows with the number of
Markdown files, not with what changed. Comes after Performance 007.

## What the scan does now

`snapshotDirectory` (`packages/fs/src/protocol-tree.ts`) walks the folder on every sync. Story
Sync's object index (`packages/story-sync/src/state/object-index.ts`) remembers each path's
hash with its full stat tuple (size, mtime, ctime, inode, device), but the walk uses it only
for files that aren't Markdown:

- In page mode (`pageSource`), every Markdown file is read and parsed into a page object on
  every scan. No cache is consulted at all.
- In file mode, `fileSource` skips the index for `.md` names (`!markdownName(name)`), so every
  Markdown file is read and hashed.
- Every file's index row is written again on every scan, changed or not. Each write prepares
  its own statement, outside any transaction (about 13 ms per sync on the benchmark).
- A file whose object changed is stat'ed a second time, for its entry time.

The index is never authority. A row counts only while its stat tuple matches. An object
served from it is checked against its hash before it leaves the daemon. An uncached walk
revalidates every row at open, after watcher gaps, and on a timer. That safety model stays.

## Steps

1. **Find why Markdown skips the file cache.** The exclusion came in with the first commit of
   the current history, without a reason. Check what reads a Markdown file's bytes during the
   walk: page parsing, presented headings, and the root `_index.md` profile frontmatter. Then
   either drop the exclusion or record why it has to stay.
2. **Cache pages by stat.** A page row whose stat tuple matches gives the page hash without
   reading the file. Its bytes load lazily: re-read and re-parse on demand, then check the
   hash, as `fileSource` already does for cached files. A page that no longer matches its
   hash fails the read, and the next scan picks it up.
3. **Write index rows only when they change.** Skip a row whose stored tuple and hash already
   match, prepare the statements once, and write one scan's rows in a single transaction.
4. **Stat once.** Use the stat from the cache lookup for the entry's source time.
5. **Measure.** Run `tests/performance/collection-sync.ts` with `FILES=200` and `FILES=2000`,
   and record idle-sync and note-edit times before and after. Done when an idle sync and a
   one-note edit cost about the same at 2,000 notes as at 200, apart from the readdir and
   stat of each file. Also run the revalidation tests and one uncached walk on Joe's todos
   tree, to check that both give the same root.

## Not in this plan

- Skipping unchanged directories without even a readdir, driven by the file watcher
  (`directoryHash`). Worth doing only if step 5 shows readdir and stat dominating.
- The note edit that goes through the merge worker instead of fast-forwarding (about 30 ms
  of its time on the benchmark). That's a separate investigation.
