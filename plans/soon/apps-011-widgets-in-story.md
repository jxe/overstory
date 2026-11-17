# Apps 011: Views and widgets in Story

**Order:** Joe's own widgets can be built and tried while
[Apps 010](../later/apps-010-activation-and-lending.md) lands. Widgets from other people wait
for Apps 010. Apps 019 (Beetle in Story) was folded in on 2026-11-16 (Joe): Story shows views
only once it can draw them as widgets, so until step 3 a view block shows as its source, and a
browser sees the host's plain HTML.

**Why and when:** Joe wants to embed small apps in Story pages, drawn natively, not in a web
view and not with React (Joe, 2026-11-05, in the apps discussion). Since 2026-11-11 they are
written in Beetle, in `.beetle` files and pages' `view` blocks, not TSX
([reading and watching §4](../../docs/overstory-spec/1.2-reading-and-watching.md#4-views)). This is the third of the three apps plans Joe split on 2026-11-06. It absorbs
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
  | Page | Configuration as the page's properties (front matter), read as `page`, edited in a settings sheet ([Beetle §3.7](../../docs/overstory-spec/1.5-beetle.md#37-view-blocks-in-pages)) |
  | Reader | `my table X:` rows, and `keep` per placement |
  | Session | `session table X:` rows, and `state`; never stored, for fast state such as games |

  ([Beetle §3.9](../../docs/overstory-spec/1.5-beetle.md#39-state).) An app reads and
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
- **Native `Rows` cells** (Joe, 2026-11-11, deferred to here): Story draws a `Rows` element
  ([Beetle §3.1](../../docs/overstory-spec/1.5-beetle.md#31-elements)) as its native list when
  every cell is one it knows. Proposed starter set: `Bullet`, `Text`, `People`, `Count`,
  `Date`. A `Rows` with any other cell falls back to ordinary view drawing.
- **Views run locally on a placed tree when they can,** and on the host otherwise.
- **The UI language becomes its own package, like Beetle:**
  - The component model and vocabulary.
  - The wire form.
  - The host interface.
  - Conformance fixtures.

  Swift is one implementation, and an HTML renderer is another.

## 1. Story understands Beetle files

- Swift node mapping (`ProtocolPage`, `ProtocolPathRead`): `x.beetle` and `x/_index.beetle`
  supply node `x`, from `docs/overstory-spec/conformance/node-bodies.json`; a page's code
  version covers its view blocks only (`codeVersion` in `@ovst/beetle`). Story lists and opens
  views like pages, showing their source.
- Highlighting in Story's code blocks, view blocks and `.beetle` files (Quagmire's code row is
  plain text today), from the tree-sitter grammar in `packages/beetle/editors` or a port of its
  highlight queries.

## 2. The UI language package

- The view tree types and element vocabulary as their own package, with:
  - The view tree types.
  - The vocabulary of the 26 components listed in the design doc.
  - Their props and events.
  - Conformance fixtures, each a view tree with the expected rendering facts.
- **Decide first:** the package's name and where its spec lives (proposed:
  `docs/ui-language/`).
- The host's plain browser rendering (`renderViewTree` in `public-page.ts`) moves to this
  vocabulary.

## 3. The SwiftUI renderer, drawing the host's answer

- Draw the vocabulary on the Mac and on the iPhone, from the views route's `tree` answer
  ([reading and watching §4.1](../../docs/overstory-spec/1.2-reading-and-watching.md#41-answer-forms)),
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
  [Beetle §3.9](../../docs/overstory-spec/1.5-beetle.md#39-state); session tables in memory.
  Decide where `my` table rows are stored and how they reach the reader's other devices, then
  write it into Beetle. Proposed: under the reader's own tree, syncing like any collection.
- Controls bind to named fields; lists of a model offer its row actions.

**Verify:** the fixtures pass in both stacks; a state change redraws without a request.

## 6. Collections drawn from Beetle views (was Apps 012)

- On a placed tree, Story Sync answers the same views request from its own SQLite stores, so
  Story asks for a collection's view the same way whether the tree is placed or not.
- Story draws a collection's list from its `schema.beetle` views over a `Rows` element instead
  of its own `~views` presentation (`PresentedView.swift`, `StoryPresentedCollection.swift`),
  and `~views` goes from Beetle and the spec.
- The last of USL goes with it: StoryKit's `OverstoryWorkspace/USL` folder
  (the USL parser and checker that `BeetleSchema.swift` rewrites `schema.beetle` into, layout,
  logical rows, `PresentedView`, `PresentedViewEdits`), `USLTests` and `PresentedViewTests`,
  and `conformance/presented-views.json`. Story reads a schema's tables with the Swift port of
  the Beetle checker from step 5, held to `beetle.json`.
- Row actions come from the app's row-action mutations (`mutation … for Table.op`,
  [Beetle §4.1](../../docs/overstory-spec/1.5-beetle.md#41-facts)) when it has them, and
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
