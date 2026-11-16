# Apps 011: Widgets in Story

**Order:** after [Apps 019](apps-019-beetle-in-story.md) steps 1 and 2 (Beetle in Story). Joe's own widgets can be
built and tried while [Apps 010](../later/apps-010-activation-and-lending.md) lands. Widgets from
other people wait for Apps 010.

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
  - Story evaluates it on the device with Apps 019's Swift evaluator; no JavaScript runs
    for widgets. (Client plugins, [Apps 014](../later/apps-014-client-plugins.md), are the
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
- **The UI language becomes its own package, like USL:**
  - The component model and vocabulary.
  - The wire form.
  - The host interface.
  - Conformance fixtures.

  Swift is one implementation, and an HTML renderer is another.

## 1. The UI language package

- The view tree types and element vocabulary, split out of apps-runtime, with:
  - The view tree types.
  - The vocabulary of the 26 components listed in the design doc.
  - Their props and events.
  - Conformance fixtures, each a view tree with the expected rendering facts.
- **Decide first:** the package's name and where its spec lives (proposed:
  `docs/ui-language/`).

## 2. Drawing a widget in Story

- Story checks a widget's `.beetle` file (or page) and the files it uses at the pinned version of its
  tree, and evaluates it with Apps 019's Swift evaluator.
- **Re-evaluation works like this:**
  - A state or row change reevaluates only the expansions that read it.
  - There's at most one evaluation per frame, and generation numbers drop stale ones.
  - The old tree stays on screen until the new one is ready.
  - Story waits up to about 100 ms so all of an evaluation's streams are at one tree version.
- Views on a placed tree are evaluated against Story Sync's local SQLite. Otherwise
  Story asks the host for the view's `rows` answer
  ([reading and watching §4](../../docs/overstory-spec/1.2-reading-and-watching.md#4-views))
  and evaluates the view itself, so state changes stay on the device.

## 3. The SwiftUI renderer

- Draw the vocabulary on the Mac and on the iPhone.
- Controls bind to named fields. Actions run mutations and show pending and error states.
- Lists of a model offer its row actions.
- Snapshot-test the conformance fixtures on both platforms.

## 4. View blocks, placement and state

- A `view` block on a page draws the widget in place, with a menu for its settings.
- Placement identity, page properties, `my` and `session` tables, `state` and `keep`, as
  decided above.
- Decide where `my` table rows are stored and how they reach the reader's other devices,
  then write it into [Beetle](../../docs/overstory-spec/1.5-beetle.md#39-state). Proposed:
  under the reader's own tree, syncing like any collection.
- Port Supplies' List, Practice and search screens as widgets. They are the acceptance
  corpus.

## 5. Checking and editor tooling (from Apps 003)

- `beetle` checks and formats, and `packages/beetle/editors` has tree-sitter, Zed and VS Code
  support; Story's highlighting is Apps 019 step 5. Later, one language service
  for VS Code and Zed over the same checker, with completion for models, fields and
  mutations.

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

- Each step has tests on the TypeScript side.
- Swift snapshot tests cover the renderer.
- When a step lands, its hand check of the Supplies widgets on Joe's Mac and iPhone goes to
  [Joe's to-do](../joe.md).

Never widen authority to get a widget working: until Apps 010, widgets run as their reader,
and only Joe's own are enabled.
