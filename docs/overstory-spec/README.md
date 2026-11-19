# Overstory specification

*This file is the entry point to the specification. The chapters live in [`docs/overstory-spec/`](), named by layer and chapter; read them in the order of the table below.*
*Overstory names the system, its protocol, and its independently versioned trees; Story names the device tools (the app, the `story` command and Story Sync) and overstoryd the reference host.*

## Specification stance

This is the aspirational public contract for Overstory. It describes behavior an implementation may conform to before that behavior exists in the reference implementation. [Current status](../../status.md) records what the reference implementation actually does; the [planning index](../../plans/README.md) owns remaining work, and completed plans live in git history. The reference implementation reached the spec's wire forms at the Protocol 003 flag day ([status](../../status.md#protocol-003-flag-day--2026-11-16)).

The specification contains only behavior that must remain portable across independently implemented Overstory components. The [reference documentation](../architecture/README.md) describes the current daemon, CLI, clients, runtime architecture, local state, and operating choices without making them Overstory requirements.

The specification is in six layers. Each builds only on the ones below it, so an
implementation can stop after any of them, and the file names carry the layer:
`1.2-reading.md` is layer 1, chapter 2. There are two exceptions: who may read or write is
defined in layer 5, and the decisions an accepted update may keep in layer 4, though layer 1
already applies both, and presence in layer 4 is bounded by the access rules of layer 5.

1. **Trees.** What a tree is and how it travels: the data model, reading,
   updates and merging, and locators.
2. **Typed nodes.** Folders whose children are records, and Beetle, the language
   their tables are declared in.
3. **Views and mutations.** Beetle views and mutations, and how a host
   evaluates and runs them.
4. **Collaboration.** Working on a tree with others: following its accepted
   updates as they happen, accepted state that keeps unresolved decisions and
   how they are resolved, and presence, which is ephemeral and never part of
   the tree.
5. **Accounts and access.** Who the callers are and what they may do:
   accounts and devices, access control, and acting at hosts other than a
   profile's home.
6. **Clients.** How a client holds a tree and edits one it may write: working
   trees, placements on disk, and the command line.

A host conforms to layers 1, 2, 4 and 5, and to layer 3 when it runs apps; a
Story-compatible client conforms to all six. Every route is listed in the [route index](#route-index). The `story` command's
contract is [the command line](6.3-command-line.md); local
client/daemon transport, UI controls, other CLI commands, runtime algorithms, package
topology, private-state layout, and test machinery are reference choices.

## Specification map

New readers should start with the non-normative [walkthrough](00-walkthrough.md), which follows one local profile identity through claiming an account, activating trees, editing, watching, adding records, and querying it from a page. The numbered files are the normative contract, in reading order.

| Layer | File | Public contract |
|---|---|---|
| 1. Trees | [data model](1.1-data-model.md) | Trees and nodes; the directory, properties, file and log objects and their hashes; entry metadata and times; nodes as a page and children, and how files and folders spell them; a page with children and its presented headings; reserved names |
| | [reading](1.2-reading.md) | Reading the current tree, a snapshot, an object or a path; references and selectors; stream framing, errors and encodings |
| | [updates and merging](1.3-updates-and-merging.md) | The update route, request identity, results and deltas; authored changes: traces, operations, property operations; exact-state preconditions, acceptance, and merging properties |
| | [locators](1.4-locators.md) | References by TreeID, path and stable key; links written in Markdown; canonical names and domains; finding trees; reading at the canonical URL |
| 2. Typed nodes | [records](2.1-records.md) | A folder whose children are records: what the tree holds, record identity and order, validation and merge |
| | [Beetle](2.2-beetle.md) | The language shared by schemas, views and mutations: syntax, `.beetle` files, imports, expressions and built-ins, limits and diagnostics, and the grammar |
| | [Beetle tables](2.3-beetle-tables.md) | Tables and fields, enums, connections and keys; a typed node's `schema.beetle`, its storage layers, relational layout and fingerprint |
| 3. Views and mutations | [views](3.1-views.md) | Elements, reading records, conditions and rules, expansion, view blocks in pages, state, actions and forms, data views, element types; handles and code versions; the `views` route with answer forms, plans and live dependencies; view addresses |
| | [mutations](3.2-mutations.md) | Facts and public errors, and the `mutate` route |
| 4. Collaboration | [watching](4.1-watching.md) | The watch stream: resuming after an update, events, objects carried, and when it ends |
| | [conflicts](4.2-conflicts.md) | Accepted unresolved state; reading conflicts; explicit resolution; accepted decisions and continued editing; format-aware merge rules |
| | [presence](4.3-presence.md) | Presence entries, cursors, routes, access and bounds, runners and messages |
| 5. Accounts and access | [accounts and devices](5.1-accounts-and-devices.md) | Profile identity, host accounts, tree configurations, device pairing and sessions, and declaring, activating and mounting trees |
| | [access control](5.2-access-control.md) | Resource rules, caller/code constraints, combined execution authority, authentication, guarded updates and watches; what views and mutations may read and write, user identity, consent and data disclosure |
| | [federation](5.3-federation.md) | Home and placement hosts, placement accounts, invitations accepted as placements, published device keys, and visitor sessions |
| 6. Clients | [working trees](6.1-working-trees.md), with [the update machine's runner](../implementing-sync-services/update-machine.md) | The three ways to hold a tree (Browse, Replica, alongside Story Sync), and the update machine a working tree runs: the change log, one prepared request in flight, one successor, validated apply, held rejections, exact ambiguous recovery, and editor capture |
| | [placements on disk](6.2-placements-on-disk.md) | How a placement writes a tree into a folder: page frontmatter, tree membership and ignore files, and records as CSV, JSON, Markdown files or SQLite; local placements |
| | [the command line](6.3-command-line.md) | The `story` command as scripts, agents and runners call it: conventions, exit codes and environment; placing and moving folders; agent bundles, sessions, run requests and reporting; identity; sync state and its JSON |

The specification map does not report implementation progress. See
[status.md](../../status.md) for that boundary and [`conformance/`](conformance) for
the exact portable fixtures currently shared by the TypeScript and Swift
implementations.

## Conformance

Language-neutral vectors under [`conformance`](conformance) cover descriptors, access, errors, resolution, objects, updates, snapshots, SSE framing and resume, bootstrap idempotency, pairing, configuration merge and governance, activation, and tree-scoped reachability. The [reference implementation documentation](../architecture/README.md), including the local API, the CLI beyond [the command line](6.3-command-line.md), and client design, is informative rather than normative.

The checked-in configuration vectors describe the `tree-config-v1` graph.

## Route index

Every HTTP route an Overstory host exposes, and the section that defines it.

| Route | Defined in |
|---|---|
| `GET /.overstory/health`, `GET /.overstory/integrity`, `GET /.overstory/account`, `GET /.overstory/account/directory` (optional), `GET /.overstory/trees`, `GET /.well-known/overstory[/{path}]` | [locators §5.2](1.4-locators.md#52-host-reads) |
| `GET /.overstory/trees/{TreeID}`, `/snapshots/{root}`, `/objects/{hash}` | [reading](1.2-reading.md) |
| `GET /.overstory/trees/{TreeID}/snapshots/{root}/path/{path}` | [reading §5](1.2-reading.md#5-reading-a-path) |
| `GET /.overstory/trees/{TreeID}/conflicts` | [conflicts §2](4.2-conflicts.md#2-reading-conflicts) |
| `GET {canonical URL}{/path}` (Markdown; HTML optional) | [reading at the canonical URL §6](1.4-locators.md#6-reading-at-the-canonical-url) |
| `POST /.overstory/trees/{TreeID}/updates` | [updates and merging §1](1.3-updates-and-merging.md#1-the-update-request) |
| `GET /.overstory/trees/{TreeID}/watch` | [watching §1](4.1-watching.md#1-the-watch-stream) |
| `GET /.overstory/trees/{TreeID}/presence`, `POST /.overstory/trees/{TreeID}/presence/{PresenceID}[/messages]` | [presence §3](4.3-presence.md#3-routes) |
| `QUERY /.overstory/trees/{TreeID}/views` | [views §12](3.1-views.md#12-evaluating-views-on-a-host) |
| `POST /.overstory/trees/{TreeID}/mutate` | [mutations §3](3.2-mutations.md#3-running-mutations) |
| `POST /.overstory/challenges` (purpose `account`, `placement` or `session`), `PUT /.overstory/accounts` (a new home, or a placement) | [accounts and devices §1.2](5.1-accounts-and-devices.md#12-claiming-an-account-with-the-profile-key), [federation §3](5.3-federation.md#3-accepting-an-invitation-as-a-placement) |
| `POST /.overstory/pairings`, `PUT /.overstory/pairings/claim` | [accounts and devices §4](5.1-accounts-and-devices.md#4-device-pairing) |
| `POST /.overstory/device-sessions` | [accounts and devices §4.1](5.1-accounts-and-devices.md#41-device-sessions) |

Routes one host calls on another live under `/.overstory/peer/`; no client
needs them:

| Route | Defined in |
|---|---|
| `GET /.overstory/peer/profiles/{ProfileTreeID}/device-keys` | [federation §4](5.3-federation.md#4-published-device-keys) |
| `GET https://{domain}/.overstory/peer/domain-check` | [locators §5.1](1.4-locators.md#51-trees-at-a-persons-domain) |

A host also reads another host's public trees (a remote group's members) with
the ordinary tree reads above.

Authentication headers apply to every route ([access control §2](5.2-access-control.md#2-authentication-and-secrets)); shared read values are introduced with [reading](1.2-reading.md), while SSE framing and common errors are in [reading §6.1](1.2-reading.md#61-stream-framing-and-errors).

## Component roles

- An **Overstory host** owns its accounts, the private tree configurations it
  governs, its hosted trees' boundaries and accepted history, their objects,
  access enforcement and watch streams. A profile has one home host, which
  holds its configuration, and may have placement accounts at others
  ([federation](5.3-federation.md)). A host needs no files on disk in the
  shape of its trees.
- An **Overstory client** finds trees, transfers objects, keeps a working tree
  in sync through the update machine ([working trees](6.1-working-trees.md)),
  and never discloses credentials or link secrets.
- An **app runtime** serves a view at its node's own address, passes it the
  caller's user context, runs its mutations, and streams validated results,
  disclosing no more than the view's plan reads ([views §12](3.1-views.md#12-evaluating-views-on-a-host)).

The protocol does not dictate private indexes, journals, caches, local
client/daemon transport, or UI.

## Deferred

These are the behaviors the specification names but does not yet define. Each
inline mention links here; accepted implementation work is indexed under
[plans](../../plans/README.md), while proposed additions not yet decided are
[spec extensions](../../plans/spec-extensions/README.md).

1. **Remote tree deletion.** Retiring an active remote tree, and with it its configuration, is invalid until a deletion lifecycle exists ([accounts and devices](5.1-accounts-and-devices.md#32-invariants)).
2. **Cross-server plan discovery, delegated authorization, and server-to-server execution routing** ([mutations §3.1](3.2-mutations.md#31-relationship-to-tree-synchronization), [views §12.2](3.1-views.md#122-plans-and-live-dependencies)).
3. **External non-tree side effects** need an effect and consent contract distinct from deterministic record mutations ([mutations](3.2-mutations.md)).
4. **Agents beside an app**: pages whose body is a prompt, with the app's views and mutations as their tools, run by a runner, and their transcripts ([Apps 002](../../plans/features/apps-002-agents-beside-an-app.md)).
5. **A Markdown-readable link carrying both a stable key and a content fragment.** The `#overstory-key=` alias has no room for a heading; such a link uses the `;overstory-key=` path suffix, which Overstory resolves but other Markdown readers do not ([locators §2.1](1.4-locators.md#21-links-written-in-markdown)).
6. **Aggregates beyond `count`, `sum`, `min` and `max`, pagination, and unbounded traversal** in views; today they are capability extensions ([views §12.2](3.1-views.md#122-plans-and-live-dependencies)).
7. **A capability field that may reference a `system:` address** without making it a content locator ([locators](1.4-locators.md#1-forms)).
8. **Additional fine-grained operation families** beyond the resource operations defined in access control. Exact-state preconditions are concurrency guards, not permissions ([updates and merging §3.1](1.3-updates-and-merging.md#31-exact-state-preconditions), [access control §3.2](5.2-access-control.md#32-updates-and-guards)).
9. **Several simultaneous local placements of one TreeID**, including the ownership and conflict rules needed when more than one path is writable.
10. **Placement-specific read-only ceilings** for installations where the same TreeID has several local placements with different effective limits.
11. **Durable pinned placements of immutable historical revisions.** Revision locators remain read-only even when a client later makes them durable.
12. **Reader-local annotation or proposal overlays** that augment a mounted tree without changing the underlying authored content. A nested mount is path composition, not such an overlay.
