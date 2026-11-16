# Apps 015: Beetle on the host: views as nodes, view blocks, every tree

**Why and when:** Joe decided on 2026-11-11 that views and mutations are written in Beetle,
in `.beetle` files and pages' `view` blocks, and that TypeScript support for both goes. The
parser, checker, host evaluator, mutations and the Supplies port are deployed, and the host
runs Beetle for every tree (2026-11-16)
([status](../../status.md#apps-015-beetle-views-and-mutations-on-the-host--2026-11-16)). This
plan is the host and TypeScript work left. Story's side (the Swift evaluator, view blocks
drawn in pages, highlighting, the `rows` answer it reads) is
[Apps 019](apps-019-beetle-in-story.md) (Joe, 2026-11-16). Finer live dependencies than
"the tree changed" go to [Performance 010](performance-010-mailboxes-and-change-feed.md),
whose change feed (built 2026-11-16) can make Beetle views a consumer with its own cursor.

The spec describes the target: [Beetle](../../docs/overstory-spec/1.5-beetle.md),
[reading and watching §4](../../docs/overstory-spec/1.2-reading-and-watching.md#4-views),
[locators §7](../../docs/overstory-spec/1.6-locators.md#7-view-addresses).

## Status

**PLANNED · M effort · low risk.** Host and TypeScript only; nothing here needs a Story
release.

## 1. Views as nodes, and view blocks served by the host

Joe decided on 2026-11-11 that a `.beetle` file is a node's body, like a `.md` file, so
`List.beetle` answers at `List`, and that pages may hold fenced `view` blocks
([§3.6](../../docs/overstory-spec/1.5-beetle.md#36-beetle-files),
[§3.7](../../docs/overstory-spec/1.5-beetle.md#37-view-blocks-in-pages)).

- Node mapping in `packages/protocol` (pages and path reads): `x.beetle` and
  `x/_index.beetle` supply node `x`; `x.md` beside `x.beetle` reports
  `duplicate-node-representation` and reads the Markdown. Conformance vectors for the new
  spellings, so Apps 019 can port them to Swift.
- A page's view blocks as one source on the host: code version over the blocks' text only,
  `page` (properties, `name`, `children`), unnamed views addressed internally as `#n`, named
  ones as `Page?view=Name`.
- A view block's unnamed view receives its page's query string.

## 2. HTML for a browser

- `GET` of a `.beetle` file (or a page with view blocks) from a browser renders its view tree
  as HTML, using the same element vocabulary Apps 011 writes down. Until that vocabulary
  exists, a plain fallback rendering of `{type, props, children}`.

## 3. Loose ends

- A row created and edited in the same millisecond: its `modified` can't move, so the diff
  refuses it. Check whether Protocol 003's times still allow this, and fix it if they do.
- Collections in another tree than the view's.

## Open questions

- Combined author and user authority needs a design in the language
  ([Apps 010 §3](../later/apps-010-activation-and-lending.md#3-author-and-user-authority-together));
  durable multi-step work with outside effects belongs to
  [runners](../later/apps-017-data-runners.md).

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol` and
`bun run check:links`. Record evidence in `status.md` and delete the plan.
