# Apps 011: Views and widgets in Story

**Order:** Joe's own widgets can be built and tried while
[Apps 010](../later/apps-010-activation-and-lending.md) lands. Widgets from other people wait
for Apps 010. Apps 019 (Beetle in Story) was folded in on 2026-11-16 (Joe): Story shows views
only once it can draw them as widgets, so until step 3 a view block shows as its source, and a
browser sees the host's plain HTML.

**Why and when:** Joe wants to embed small apps in Story pages, drawn natively, not in a web
view and not with React (Joe, 2026-11-05, in the apps discussion). Since 2026-11-11 they are
written in Beetle, in `.beetle` files and pages' `view` blocks, not TSX
([views §12](../../docs/overstory-spec/3.1-views.md#12-evaluating-views-on-a-host)). This is the third of the three apps plans Joe split on 2026-11-06. It absorbs
Apps 001 (the Supplies site) and Apps 003 (compiler and editor tooling). Those deleted plans
are in git history, and the parts that still apply are below.

The design and its open questions are in the Claude Doc "Story widgets" from the apps
discussion. Where it says *query* or *endpoint*, read *view*
([Apps 005](../../status.md#views-on-the-host-and-declared-views--2026-11-08)).

## What Joe decided

- **A widget is a Beetle view**, from a `.beetle` file or a page's view blocks, plus the
  mutations it names as actions.
  - Story first draws the host's evaluated `tree` answer, then evaluates on the device with
    a Swift evaluator once a widget needs state or offline drawing (step 5); no JavaScript
    runs for widgets. (Client plugins, [Apps 014](../later/apps-014-client-plugins.md), are the
    only place Story would ever run code, and they are a later, separate decision.)
  - A SwiftUI renderer draws the `{type, props, children, key}` tree.
  - There's no web view per widget and no React. ScriptWidget (MIT) is a reference for the
    SwiftUI mapping.
- **A page draws a widget only from a `view` block** that uses the `.beetle` file and draws
  its view as an element (Joe, 2026-11-11: no lone-link embedding).
- **State has an owner:**

  | Owner | Kind of state |
  |---|---|
  | App | The app's data tables, read by views |
  | Page | Configuration as the page's properties (front matter), read as `page`, edited in a settings sheet ([views §5](../../docs/overstory-spec/3.1-views.md#5-view-blocks-in-pages)) |
  | Reader | `my table X:` rows, and `keep` per placement |
  | Session | `session table X:` rows, and `state`; never stored, for fast state such as games |

  ([views §6](../../docs/overstory-spec/3.1-views.md#6-state).) An app reads and
  writes its own `my` tables with no prompt, written on the device first.
- **A placement is identified by** the page's TreeID and frontmatter `id`, plus a block
  key made of the view block's element, its attributes and which occurrence it is. An explicit key is needed
  only when those aren't enough.
- **Transient state is `state x = …`**, bound to a control with `value={x}`. `keep x = …`
  persists it as a one-row `my` table, keyed by placement and name.
- **Link props only address records** (which list, which practice).
- **Actions are calls** in attributes: `Button action={addPractice(name: n)}`, `Form
  action={addPractice}`, `then={…}` to navigate, `set(x, v)` for state.
- **Row actions come from mutations.** `mutation … for Model.delete` (or `move`, `edit`,
  `create`) lets any list of that model offer them. Without one, a list falls back to plain row edits
  through `POST /updates` when the reader can write.
- **No arrangement model in the first cut** (Joe, 2026-11-06). A widget lays out its rows
  in code. A reader's choice of sort or grouping is a `keep` control (a picker) that the
  view reads, kept per placement. A layout shared by everyone reading a page is dropped for
  now; if it matters, it comes back as a page property the view reads.
- **Native `Rows` cells** (Joe, 2026-11-17): `Bullet`, `Text`, `People`, `Count` and `Date`.
  A `Rows` with any other cell is drawn whole as ordinary columns and rows
  ([views §9](../../docs/overstory-spec/3.1-views.md#9-element-types-and-layout)).
- **Views run locally on a placed tree when they can,** and on the host otherwise.
- **The element types are part of Beetle, not a separate package** (Joe, 2026-11-17). The
  set is small, like the cores of SwiftUI, Compose and elm-ui: `Text`, `Markdown`, `Link`,
  `Image`, `Button`, `TextField`, `Form`, `Column`, `Row` and `Rows`
  ([views §9](../../docs/overstory-spec/3.1-views.md#9-element-types-and-layout)).
  Card, Stack, Section, Grid, Badge and Avatar go: a card is a `Column` with a style, and a
  portrait is an `Image` of a person. The design doc's 26 components are dropped.
  - `Form` came back (Joe, 2026-11-18), defined in Beetle's terms rather than HTML's: named
    controls give a mutation's parameters, typed; Return submits; it clears on success and shows
    field errors at their controls
    ([views §7](../../docs/overstory-spec/3.1-views.md#7-actions-forms-and-events)).
  - Layout is a few attributes that say what a layout should do, not how: `spacing`,
    `align`, `grow`, `padding`, `minWidth`/`maxWidth` and `style` roles. Story draws them with
    SwiftUI stacks and the HTML renderer with flexbox. No positions, constraints, colors or
    font sizes.
  - Grids, overlapping layouts and custom layouts are new element types from client plugins
    ([Apps 014](../later/apps-014-client-plugins.md)).
- **`my` rows live in a private tree of the reader's own** (Joe, 2026-11-17), one folder per
  app, never in the profile tree, which others read
  ([views §6](../../docs/overstory-spec/3.1-views.md#6-state)).
- **Mutations offline** (Joe, 2026-11-17): on a placed tree, a mutation applies to Story
  Sync's local copy at once and is sent when back online, like a row edit, and a refusal then
  shows as its error. On a tree that isn't placed, actions are disabled while offline. Until
  step 5 every tree works like one that isn't placed.

## 1. Story understands Beetle files

- Swift node mapping (`ProtocolPage`, `ProtocolPathRead`): `x.beetle` and `x/_index.beetle`
  supply node `x`, from `docs/overstory-spec/conformance/node-bodies.json`; a page's code
  version covers its view blocks only (`codeVersion` in `@ovst/beetle`). Story lists and opens
  views like pages, showing their source.
- Highlighting in Story's code blocks, view blocks and `.beetle` files (Quagmire's code row is
  plain text today), from the tree-sitter grammar in `packages/beetle/editors` or a port of its
  highlight queries.

## 2. The element types in Beetle

- `@ovst/beetle` checks element types against
  [views §9](../../docs/overstory-spec/3.1-views.md#9-element-types-and-layout) (it
  accepts any capitalized type today), and the conformance fixtures and examples move to them
  (Supplies' `Card`, `Avatar`, `Section`, `Grid` and `Badge`).
- Conformance fixtures, each a view tree with the expected rendering facts, including layout.
- The controls of [views §7](../../docs/overstory-spec/3.1-views.md#7-actions-forms-and-events)
  (Joe, 2026-11-18): `Toggle`, `Picker`, `Text editable`, and `value={t.field}` with an `action`
  whose parameter named after the field takes the new value. The checker rejects a missing or
  mistyped parameter; clients show the new value while the action runs and put the old one back
  on a public error.
- The host's plain browser rendering (`renderViewTree` in `public-page.ts`) moves to these
  types and draws the layout attributes with flexbox; `Portrait`, `Stack` and `Card` go.

## 3. The SwiftUI renderer, drawing the host's answer

- Draw the vocabulary on the Mac and on the iPhone, from the views route's `tree` answer
  ([views §12.1](../../docs/overstory-spec/3.1-views.md#121-answer-forms)),
  kept current by its stream. No evaluator on the device yet, so state can't change.
- A `view` block on a page draws in place (a block's unnamed view is `#n`, its named views
  without parameters draw too; the host already serves both), with a menu for its settings;
  Story shows the source while editing.
- Actions run mutations through `/mutate` and show pending and error states.
- Snapshot-test the conformance fixtures on both platforms.

## 4. Placement and page state

- Placement identity and page properties (read as `page`, edited in a settings sheet), as
  decided above.
- Port Supplies' List, Practice and search screens as widgets. They are the acceptance
  corpus.

## 5. The evaluator in Story, the `rows` answer and reader state

- The views route answers the `rows` form for a Beetle view (refused today with
  `unsupported-operation`): the plan's rows without evaluating.
- A Swift port of the checker's plan and of the evaluator, sharing the conformance fixtures
  (`docs/overstory-spec/conformance/beetle.json`). Story evaluates views over Story Sync's
  local SQLite on a placed tree, or over a `rows` answer, and applies mutations
  optimistically with the same evaluator.
- **Re-evaluation works like this:**
  - A state or row change reevaluates only the expansions that read it.
  - There's at most one evaluation per frame, and generation numbers drop stale ones.
  - The old tree stays on screen until the new one is ready.
  - Story waits up to about 100 ms so all of an evaluation's streams are at one tree version.
- `state`, `keep`, `my` and `session` tables per
  [views §6](../../docs/overstory-spec/3.1-views.md#6-state); session tables in memory,
  `my` rows in the reader's private tree. Decide how a client finds that tree (from the
  account, presumably) and create it on first write.
- Mutations on a placed tree apply locally first and queue while offline, as decided above.
- Controls bind to named fields; lists of a model offer its row actions.

**Verify:** the fixtures pass in both stacks; a state change redraws without a request.

## 6. Collections drawn from Beetle views (was Apps 012)

- On a placed tree, Story Sync answers the same views request from its own SQLite stores, so
  Story asks for a collection's view the same way whether the tree is placed or not.
- Story draws a collection's list from its `schema.beetle` views over a `Rows` element instead
  of the plain list `StoryCollectionView` shows since USL went (2026-11-17; Story drew
  `~views` before), and `~views` goes from Beetle (the TypeScript checker and StoryKit's
  `Schema/` both still accept it) and the spec.
- Row actions come from the app's row-action mutations (`mutation … for Table.op`,
  [mutations §1](../../docs/overstory-spec/3.2-mutations.md#1-facts)) when it has them, and
  otherwise from plain row edits
  ([Schema language 007](../features/schema-language-007-editing-in-the-collection-view.md)).
- A page that presents a collection (the
  [pages that present other collections](../spec-extensions/pages-that-present-other-collections.md)
  extension, once settled) and a widget drawn from a view block share placement identity and
  menus.

**Verify:** the People directory and the games sandbox look and edit the same before and
after.

## 7. Checking and editor tooling (from Apps 003)

- `beetle` checks and formats, and `packages/beetle/editors` has tree-sitter, Zed and VS Code
  support. Later, one language service for VS Code and Zed over the same checker, with
  completion for models, fields and mutations.

## Later: the HTML renderer and the Supplies site (from Apps 001)

A second renderer draws the same view trees as HTML, so a tree's widgets also work as a web
site, served by overstoryd and later from a host such as Vercel.
- The rules carry over from Apps 001:
  - Pages advertise their source with `<link rel="overstory">`.
  - Bundles hold no server code or credentials.
  - The browser never receives raw SQLite or unrelated private rows.
- If the Supplies site ever moves off its current home, migrating its real data needs a
  reviewed identity map, durable redirects, side-by-side staging and a tested rollback.

## Verify

- Each step has tests on the TypeScript side, and Swift package tests on Joe's Mac; each Swift
  step ships with a Story release.
- Swift snapshot tests cover the renderer.
- When a step lands, its hand check of the Supplies widgets on Joe's Mac and iPhone goes to
  [Joe's to-do](../joe.md).

Never widen authority to get a widget working: until Apps 010, widgets run as their reader,
and only Joe's own are enabled.
