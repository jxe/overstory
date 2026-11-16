# Apps 015: Beetle on the host: a same-millisecond row edit

**Why and when:** Joe decided on 2026-11-11 that views and mutations are written in Beetle,
in `.beetle` files and pages' `view` blocks, and that TypeScript support for both goes. The
parser, checker, host evaluator, mutations and the Supplies port are deployed, and the host
runs Beetle for every tree, serves views at their nodes' addresses and pages' view blocks,
and draws them for a browser (2026-11-16)
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

**PLANNED · S effort · low risk.** Host and TypeScript only; nothing here needs a Story
release.

## Loose ends

- A row created and edited in the same millisecond: its `modified` can't move, so the diff
  refuses it. Check whether Protocol 003's times still allow this, and fix it if they do.

## Open questions

- Combined author and user authority needs a design in the language
  ([Apps 010 §3](../later/apps-010-activation-and-lending.md#3-author-and-user-authority-together));
  durable multi-step work with outside effects belongs to
  [runners](../later/apps-017-data-runners.md).

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol` and
`bun run check:links`. Record evidence in `status.md` and delete the plan.
