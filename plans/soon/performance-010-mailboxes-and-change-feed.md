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

Steps 1 to 4 are built and deployed (2026-11-16). Rehearsed first on Joe's Mac against the
migrated 2026-11-16 backup: all 28 trees read back the same update and root as main, cold start
the same; `rehearse-tree.ts` host time per request 3.5 to 1.9 ms median; 8 concurrent trees,
journal syncs per update 1.00 to about 0.34. (`rehearse-tree.ts` needs fixing before it runs
again: it passes no `at` to `executeExactSourceEdits` and edits the root `_index.md` as a file.)

- **The change once:** acceptance's entry-change walk also names the collection folders whose
  log moved, and the collections follower and the snapshot check take them from it instead of
  walking both roots twice each. Host directory decodes per traced edit on `page-edit-cost.ts`:
  about 12 to 8. The rest (graph validation, reserved boundaries, the profile index hash, the
  trace rebuild) is step 1's below.
- **Group commit in the journal:** `Packs.append` groups appends issued while a sync runs into
  one write, one `fdatasync` and one index transaction; an idle store writes at once.
  `tests/performance/concurrent-trees-cost.ts`, 8 writers on 8 trees, fsync shim at 4 ms:
  median 45 to 15 ms, p90 63 to 32 ms, 165 to 430 updates a second, syncs per update 1 to
  0.27; with no delay, unchanged. The SQLite commit is not batched: under WAL with
  `synchronous = NORMAL` it doesn't sync, so there was nothing to share.
- **A change feed** (`change-feed.ts`): each accepted update is published once as a
  `ChangeRecord`. Listeners that must see it at once (authorization invalidation, watch
  streams, packing, remote-group prefetch) run as it is published; the collections follower
  (one consumer per tree) and the snapshot scheduler read it with cursors, take what they fell
  behind on as one coalesced batch, and log lag and slow batches. A collection read waits for
  its tree's follower to reach the head instead of the `advancing` promise chain. Cursors are
  in memory, since both consumers' state rebuilds from the tree on demand. Same speed on both
  harnesses. The provenance backfill stays as it was: already paced, one tree at a time, and
  never asking the merge worker.
- **Tree mailboxes** (`mailbox.ts`): a tree's turns are a `Mailbox` instead of a promise
  chain, reporting its depth on arrival (`lock-depth` in `Server-Timing`). The host's own
  collection snapshot is low priority: client updates waiting for the tree go first. Config
  advances and boundary rewrites were never loose promises (their callers await them), so they
  stay normal turns. The other hand-written queues (collection turns, the merge FIFO, packing)
  can move to `Mailbox` when one of them needs its numbers.

1. **Tree actors keep their head in working form.** Candidates are decoded once at ingest; graph
   validation, reserved boundaries, the profile index hash and the Filesystem 026 check read the actor's
   flat head instead of decoding the root again. (Done in passing: the reserved-boundary check
   reads each directory once, not once per mounted child.) Move work that doesn't need the head out of the
   turn. Measure CPU per edit and lock-wait on `rehearse-tree.ts` with a copy of Joe's todos
   tree.
2. **Push authorization changes, or drop this.** Publish an event when the authorization epoch
   moves, instead of polling it every 250 ms. Checked 2026-11-16: the poll is one timer for
   every open stream and one trivial query a tick, whatever the number of watchers, and the
   epoch also moves on commits by other processes (`data_version`), which no event in this
   process can announce. Pushing needs every authorization-relevant write to announce itself,
   and a missed one leaves a revoked watch open. Recommendation: drop it.
3. **Ask the merge sidecar without holding the turn, only if measured.** If live update logs
   show `lock-wait` while merges run: ask against a head snapshot, keep accepting plain edits,
   re-ask once if the head moved, then hold the turn.

Host-side steps are rehearsed on a copy of Joe's real data with a cold start before deploying.
