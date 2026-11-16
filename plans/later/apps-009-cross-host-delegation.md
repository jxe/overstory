# Apps 009: Code on one host using access held on another

**Why and when:** after Apps 008, once apps span hosts. A design sketch; no timing yet.
It became concrete with Beetle: [Apps 015](../soon/apps-015-the-view-language.md) lists
"collections in another tree than the view's" as left, and the first time that tree lives on
another host, a Beetle view on one host needs rows held on another. It also holds the
spec-extension question it was paired with until 2026-11-16 ("executable data across
servers"): how plan discovery, delegated authorization and server-to-server routing let a
view use remote data without treating network reachability as authority.

## Status

- **Effort:** L
- **Risk:** HIGH. It defines delegated authorization across servers, which the
  spec defers.
- **State:** DESIGN SKETCH 2026-09-27, split from the portable-profiles design
  (Security 008). Builds on the in-process Beetle host
  ([the Beetle host](../../docs/architecture/overstoryd/beetle-host.md)),
  [Apps 010](apps-010-activation-and-lending.md)'s execution tokens and
  [Apps 008](apps-008-app-approvals-on-placement-hosts.md). One decision is Joe's
  (marked **Decide**).
- **Closes:** the spec's deferred item 2, cross-server plan discovery, delegated
  authorization and server-to-server execution routing
  ([deferred](../../docs/overstory-spec/README.md#deferred)).

## The problem

Code runs on host R, and a resource it needs is on host S. Execution tokens
are host-private ([execution tokens](../../docs/architecture/overstoryd/execution-tokens.md)),
so S cannot tell who is calling, which code runs, or whose lend applies.

## The design

**The caller authorizes the crossing.** Hosts have no identities, and adding
host keys is what this avoids. At the start of an execution that needs a
resource on S, the caller's device signs an **execution grant**: the caller's
profile and DeviceID, the app TreeID and pinned code root, the requirements on
S, S's origin as the audience, and an expiry. R forwards it with each call to
S. S verifies the device signature against the caller's device keys (from the
caller's home host, as a placement host does), verifies any lend against the
lender's `apps.yaml` (as Apps 008 reads it), and enforces its own
`access.yaml` as always. What S trusts R for is only to run the pinned code,
which lending already trusts the app's administrators to do.

**Two ways to cross, to choose between per read.** A Beetle view's plan is known from its
source, so R can either ask S for rows (S runs the part of the plan over its own tables, under
the grant, and answers `rows`), or ask S to run a whole nested view. Asking for rows keeps
the evaluator on R and S answering only plans it can check; it is the likely default.

**Decide:** what waits. Anonymous callers, and lends to `everyone` callers,
have nobody to sign, and would need host identities. Recommended: v1 is
caller-signed only; those stay same-host until someone needs them.

## Work

- Record the grant's format,
  its lifetime and revocation (a revoked device or lend ends the execution on
  S, as on one host), and how a long-running or resumed execution renews it;
  then spec ([reading and watching §4.2](../../docs/overstory-spec/1.2-reading-and-watching.md#42-plans-and-live-dependencies),
  [updates and merging §4.1](../../docs/overstory-spec/1.3-updates-and-merging.md#41-relationship-to-tree-synchronization),
  access control §1.1 and §2.1, the deferred list), overstoryd on both roles, and a two-host test.
