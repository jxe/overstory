# Apps 010: Activation and lending

**Why and when:** Joe wants to test the permissions and lending models against real apps
(he split this out of Apps 005 on 2026-11-06). Since 2026-11-11 the host runs Beetle views and
mutations in process, as their caller ([the Beetle host](../../docs/architecture/overstoryd/beetle-host.md),
for every tree since 2026-11-16). This plan makes them run as an app, under the
authority an activation grants. Moving from the sidecar to Beetle changed how code runs on
the host, not whose authority it runs with, so every question here still stands.

## Status

**PLANNED · M–L effort · high authority-boundary risk.** It builds on
[Apps 015](../soon/apps-015-beetle-on-the-host.md)'s host evaluator, which loads `.beetle` files
from trees at a pinned code version. Widgets from other people
([Apps 011](../soon/apps-011-widgets-in-story.md)) wait on this plan. Joe's own
widgets don't.

## 1. What code gets without asking (decided)

Joe decided on 2026-11-11 that code with no lender gets only `everyone` access and the tree's
own `app` rules. Anything more of the caller's needs the caller's `who: me` entry in
`apps.yaml`, which is what a placement host already gives
([access control §1.1](../../docs/overstory-spec/3.2-access-control.md#11-execution-authority)).
An app reads and writes its own `my` tables
([Beetle §3.9](../../docs/overstory-spec/1.5-beetle.md#39-state)) without asking.

Still to do in code: `executionAllows` in `packages/overstoryd/src/access.ts` stops treating
the caller's own access as a grant with no lender. Until this lands, Joe's own widgets run as
their reader, as Apps 011 says.

## 2. Activation and execution tokens

- An **activation** is private host configuration (in the tree configuration graph,
  spec 04 §2). It names a Beetle handle (tree, path, declaration, code version; [Beetle §6](../../docs/overstory-spec/1.5-beetle.md#6-handles-and-code-versions))
  and adds with the
  activation's lenders, providers and resource limits.
  - Unactivated handles are refused.
  - Adding or sharing a `.beetle` file never enables it with more than §1 gives.
- **Each question runs under its own host-issued execution token**
  ([execution tokens](../../docs/architecture/overstoryd/execution-tokens.md)).
  - The token carries the actual caller, the source tree and path, the pinned code version,
    the lent grants with their lenders, and the activation.
  - The issuer chooses lenders in a fixed order: the caller's own access first, then by
    lender TreeID.
  - There is no public mint endpoint.
  - The in-process evaluator reads and submits under the token instead of the caller's own
    authority.
- **The token checks the reads and the update, not the route.** A view's reads (its
  narrowing) and a mutation's submitted update are checked against the token, not the
  route's caller check.
- **History says which code made a change.** A mutation's update is authored by the app,
  with the caller recorded.

## 3. Author and user authority together

From Apps 006 (dissolved 2026-11-16). Some apps need both: the author's access (an app's own
collection, which readers can't read directly) and the reader's (their notebook). A mutation
then declares which writes need which, and Story's consent names only the reader's part.

- How a `.beetle` mutation or view declares that it needs the author's access as well as the
  caller's, and for which tables. Nothing in Beetle says this yet; design it as a language
  statement, not a TypeScript API.
- Each grant keeps its lender separate for coverage checks; the token combines them.
- Consent diffs come from the accepted `access.yaml` and `apps.yaml` rules. Ordinary public
  access and already-covered requirements need no new consent; only a wider scope asks the
  affected grantor.
- New versions inside an approved scope stay trusted; refactoring files doesn't erase policy,
  and a file used from another tree gains no grant of its own.
- Corpus to design against: a public read of an app's own table (author read, no user
  capability); a reader saving into their own notebook (user create authority only); and a
  save that writes both the app's table and the reader's tree in one mutation.

## 4. Revocation

Revoking the activation, a lender's grant or the caller's access:
- Ends open view streams.
- Refuses queued results and receipts.
- Fails closed if the invalidation channel is lost.

A revoked caller can't use an old receipt to read a result.

## 5. Consent in Story

The first time Story runs an app's view or mutation that needs more than §1 gives:
- It asks, using the declared scope of the app's addressable views and mutations.
- The answer is written to the reader's `apps.yaml` as `who: me`.
- Later versions that stay inside the approved scope don't ask again. A wider scope asks
  for the difference.

Story shows what was approved and lets the reader revoke it.

**Verify:** extend `tests/integration/host-collections.test.ts` with real execution tokens
and the real materializations, not mocked grants:
- An anonymous reader through an `app` rule.
- Caller-only reads.
- A lent write.
- A mutation by a caller who can read but not write, allowed only through a lender.
- Revocation while a stream is open and while results are queued.
- A forged or stale token.

Consent and revocation in Story get a hand check on the Mac. Add it to
[Joe's to-do](../joe.md) when the step lands.

## Before a real app is enabled

Run a soak on an isolated copy of the live host, covering Story consent and revocation, and
configuration conflict resolution, including queued configuration writes. Take a fresh
backup of the live host first. When the steps above land, the soak and the go-ahead go to
[Joe's to-do](../joe.md).

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol` and
`bun run check:links`. Record evidence in `status.md`, trim steps as they land, and delete
the plan when only Joe's items are left.

Not here:
- Approvals on placement hosts
  ([Apps 008](../later/apps-008-app-approvals-on-placement-hosts.md)).
- Cross-host delegation ([Apps 009](../later/apps-009-cross-host-delegation.md)).
- Durable multi-step work with effects outside Overstory: [Apps 017](apps-017-data-runners.md)'s
  runners. A Beetle mutation is one transaction on the host, so it needs no workflow
  machinery of its own.

Never widen authority to get a fixture passing.

## Text moved from the spec (2026-11-11)

Joe moved these undecided rules out of [reading and watching §4](../../docs/overstory-spec/1.2-reading-and-watching.md#4-views)
on 2026-11-11. They were written for compiled TypeScript; what still applies to Beetle,
restated, comes back into the spec when this plan decides it:

- A file's path is ordinary Overstory identity, not an application ID. Moving a file changes
  its views' addresses, as moving any file changes its URL. A handle names a tree, path and
  declaration; its code version names its version.
- A host enables more than §1 for a tree only explicitly. Adding a `.beetle` file doesn't
  publish it with more authority, and a request uses one coherent code version of the
  addressed view and everything it uses. A version that fails to check doesn't replace the
  last usable one.
- File names never create mutation endpoints or private-data boundaries; the views and
  mutate routes are the only way in.
- Static baking may replace explicitly static reads with their results. A view that depends
  on who reads it, live data, mutations or host-only capabilities stays a hosted view and
  never silently becomes static.
