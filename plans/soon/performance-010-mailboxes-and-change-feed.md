# Performance 010: overstoryd as writers with mailboxes and a change feed

**Why and when:** Joe, 2026-11-16, after exploring overstoryd's structure (map in project files
`overstoryd-map/`, rebuilt with `node build.mjs ~/src/arbor`): carve overstoryd along
data-oriented lines, with mailboxes where order matters and a change feed after the commit, for
robustness and speed. After the Protocol 003 flag day. Nothing here changes the protocol, the
merge sidecar's question/answer contract, or a storage format.

## The shape

- **Ingest** (stateless, per request): parse, rebuild deltas, hash-check, decode once into the
  flat working form, authenticate, check write access. Everything that doesn't need the tree's
  head happens here, outside the tree's turn.
- **One actor per tree** (today's `withTreeLock`): the only writer of the tree's head, kept in
  working form with its open decisions. Decides each candidate (fast-forward or ask the merge
  sidecar), then hands the decided change to the commit writer. The host's own updates
  (collection snapshots, config advances, boundary rewrites) arrive in the same mailbox as
  low-priority, coalesced messages.
- **One commit writer**: everything queued since its last sync goes in one journal append, one
  `fdatasync` and one SQLite transaction; then it publishes the change records and answers each
  waiting request. When idle it commits at once.
- **A change feed**: one `ChangeRecord` per accepted update (tree, ordinal, before and after
  roots, changed paths, collection folders touched, entry changes, the transition), computed
  once in the tree actor. Backed by the observations table; recent records in memory.
- **Consumers with cursors**: watch hub, collections follower, Beetle views, provenance indexer,
  snapshot scheduler, packer. Each reads the feed at its own pace, coalesces when behind, and
  resumes from its cursor after a failure. None can slow down or fail an update. Readers that
  need collection rows wait for "ordinal at least n".
- **One `Mailbox` type** with a bound, depth and wait time reported in `Server-Timing`, replacing
  the seven hand-written queues: tree locks (`updateLocks`), collection `turns`, the per-tree
  `advancing` chain, the journal's `appending` chain, the merge FIFO, the provenance backfill
  set, and the packing debounce.

## What it costs now

Measured 2026-11-16 at d0c5ca2a with `tests/performance/page-edit-cost.ts` (64 KB page, 60
sibling pages, one-level tree, local disk), with a temporary counter on
`decodeProtocolDirectory`:

- A plain traced edit: median ~7–11 ms, one fsync, 6 objects written.
- The host decodes a directory 8–10 times per edit: once each in `validateGraphChange`,
  `validateReservedBoundaries`, the profile's `rootIndexHash` and `treeHoldsPages`, and 4 times
  in `changedCollectionFolders` after the commit (before and after root, once for
  `collections.accepted` and again for `snapshotCollectionsAfter`). Deeper trees multiply this.
- `Packs.append` chains appends, but each update still pays its own `fdatasync` and index
  transaction, so N concurrent updates on different trees cost N syncs in turn (~4 ms each on
  Railway).
- A merge holds its tree's turn for the whole question, up to the 20 s evaluation limit.

## Steps

Each step ships alone, keeps behaviour identical (existing tests, plus a differential test where
an algorithm changes), and states before and after from the same harness.

1. **Compute the change once.** Build the `ChangeRecord` in acceptance and pass it to
   `notifyAccepted`'s consumers, so `collections.accepted`, `snapshotCollectionsAfter`, document
   versions and watch transitions stop walking the two roots again. Measure decodes and CPU per
   edit on `page-edit-cost.ts` and `rehearse-tree.ts`.
2. **Group commit in the journal.** `Packs.append` writes everything queued while the previous
   `fdatasync` ran as one append, one sync and one index transaction. Measure with the fsync
   shim at 4 ms (`/mnt/project-files/perf004/fsdelay.c`) and several concurrent submitters;
   report fsyncs per update and p90. Then extend the batch to the SQLite commit (the commit
   writer).
3. **Change feed with cursors.** Replace `notifyAccepted`'s direct calls with subscribers
   reading an ordinal feed. Collection databases record the ordinal they have reached; readers
   wait for it instead of the `advancing` promise. The provenance backfill becomes the indexer
   starting from an older cursor, paced, never using the merge worker. Log each consumer's lag.
   Needs tests for resume after failure and for read-your-writes.
4. **The host's own updates go through the tree's mailbox.** Collection snapshots, config
   advances and boundary rewrites become coalesced low-priority messages instead of loose
   promises that take `withTreeLock`.
5. **Tree actors keep their head in working form.** Candidates are decoded once at ingest; graph
   validation, reserved boundaries, the profile index hash and the page check read the actor's
   flat head instead of decoding the root again. Move work that doesn't need the head out of the
   turn. Measure CPU per edit and lock-wait on `rehearse-tree.ts` with a copy of Joe's todos
   tree.
6. **Push authorization changes.** Publish an event when the authorization epoch moves, instead
   of polling it every 250 ms for all streams.
7. **Ask the merge sidecar without holding the turn, only if measured.** If live update logs
   show `lock-wait` while merges run: ask against a head snapshot, keep accepting plain edits,
   re-ask once if the head moved, then hold the turn.

Host-side steps are rehearsed on a copy of Joe's real data with a cold start before deploying.
