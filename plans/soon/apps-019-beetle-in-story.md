# Apps 019: Beetle in Story

**Why and when:** Story's side of Beetle, split out of
[Apps 015](apps-015-beetle-on-the-host.md) by Joe on 2026-11-16, with the rest of Apps 012
(Story draws declared views like any view) folded in. The host evaluates Beetle views and
runs mutations ([status](../../status.md#apps-015-beetle-views-and-mutations-on-the-host--2026-11-16));
Story still draws collections with its own `~views` presentation (`PresentedView.swift`,
`StoryPresentedCollection.swift`), and its Beetle support is the `schema.beetle` reader
(`BeetleSchema.swift`). [Apps 011](apps-011-widgets-in-story.md) (widgets) needs steps 1
and 2.

## Status

**PLANNED · L effort · medium risk.** Swift work, built and tested on Joe's Mac. Each step
ships with a Story release.

## 1. The `rows` answer, on the host

- The views route answers the `rows` form for a Beetle view (refused today with
  `unsupported-operation`): the plan's rows, without evaluating, so a client evaluates the
  view itself and state changes stay on the device
  ([reading and watching §4](../../docs/overstory-spec/1.2-reading-and-watching.md#4-views)).
  This is TypeScript, but only Story's evaluator reads it, so it comes with step 2.

## 2. The evaluator in Story

- A Swift port of the checker's plan and of the evaluator, sharing the conformance fixtures
  (`docs/overstory-spec/conformance/beetle.json`).
- Story evaluates views over Story Sync's local rows on a placed tree, or over a `rows`
  answer from the host, and applies mutations optimistically with the same evaluator.
- `state` and `keep` per [Beetle §3.9](../../docs/overstory-spec/1.5-beetle.md#39-state);
  session tables in memory.

**Verify:** the fixtures pass in both stacks; a state change redraws without a request.

## 3. Collections drawn from Beetle views (was Apps 012)

- On a placed tree, Story Sync answers the same views request from its own SQLite stores, so
  Story asks for a collection's view the same way whether the tree is placed or not.
- Story draws a collection's list from its `schema.beetle` views over a `Rows` element
  ([Beetle §3.1](../../docs/overstory-spec/1.5-beetle.md#31-elements)) instead of its own
  `~views` presentation, and `~views` goes from Beetle and the spec. Row actions come from
  the app's row-action mutations (`mutation … for Table.op`,
  [Beetle §4.1](../../docs/overstory-spec/1.5-beetle.md#41-facts)) when it has them, and
  otherwise from plain row edits
  ([Schema language 007](../features/schema-language-007-editing-in-the-collection-view.md)).
- A page that presents a collection (the
  [pages that present other collections](../spec-extensions/pages-that-present-other-collections.md)
  extension, once settled) and a widget drawn from a view block share placement identity and
  menus.

**Verify:** the People directory and the games sandbox look and edit the same before and
after.

## 4. Views as nodes and view blocks in Story

- Swift node mapping (`ProtocolPage`, `ProtocolPathRead`): `x.beetle` and `x/_index.beetle`
  supply node `x`, from `docs/overstory-spec/conformance/node-bodies.json`; a page's code version covers its view
  blocks only (`codeVersion` in `@ovst/beetle`).
- Story draws a page's view blocks in place, and shows the source while editing.

## 5. Highlighting

- Highlighting in Story's code blocks and view blocks (Quagmire's code row is plain text
  today), from the tree-sitter grammar in `packages/beetle/editors` or a port of its
  highlight queries.

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol`, `bun run check:links`, and
the Swift package tests on Joe's Mac. Record evidence in `status.md`, trim steps as they
land, and send each step's hand check to [Joe's to-do](../joe.md).
