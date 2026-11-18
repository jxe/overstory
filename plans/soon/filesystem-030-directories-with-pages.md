# Filesystem 030: directories with pages, one entry per node

**Why and when:** Joe wants this "very soon" (2026-11-18, in the spec revisit thread). Today a
node with content and children is two directory entries, a `page` entry `x.md` and a
`directory` entry `x`, or a directory whose own entries include `_index.md`. That means every
reader pairs entries up, and the spec spends a section on which one wins. The tree should just
know that a directory can have a page. History is dropped again, as on the Protocol 003 flag day,
so nothing converts old roots.

## What Joe decided

- **The tree model:** a node is one entry, and a directory can have a page (Joe, 2026-11-18).
- **No link rewriting for layout.** A page's relative links resolve from where its file is,
  as now ([locators §2.1](../../docs/overstory-spec/1.6-locators.md#21-links-written-in-markdown)),
  and nothing ever moves a page between `x.md` and `x/_index.md` on its own. The earlier idea of
  letting each placement choose its layout and shifting link bases to match was dropped for
  this.
- **The convention:** a new page is `x.md`. If `x` later gets children, they go in `x/` beside
  it, and the page doesn't move. The root's page is `_index.md`, since the root has no parent
  to sit in.
- **`_index.md` is recognized wherever it occurs** (Joe, 2026-11-18). A folder made outside
  Story with `x/_index.md` keeps that spelling, and its links keep resolving from `x/`.
- **Views stop being bodies** (Joe, earlier in the same thread). A `.beetle` file is a file
  addressed with its extension. `x.beetle` no longer supplies the content of `/x`, and
  `_index.beetle` means nothing special.

## The objects

```ts
type ProtocolDirectoryEntry =
  | { name: Name; file: Hash; created: number; modified: number }   // name keeps its extension
  | { name: Name; page?: Hash; created?: number; modified?: number;  // `x.md`; times iff page
      directory?: Hash }                                             // `x/`
  | { name: Name; tree: TreeID };

type ProtocolDirectory = {
  type: "directory";
  entries: ProtocolDirectoryEntry[];
  index?: { page: Hash; created: number; modified: number };        // this directory's `_index.md`
  collection?: CollectionReference;
};
```

- A node entry's `name` has no `.md`. It has at least one of `page` and `directory`.
- `index` is where `_index.md` goes, so the root's page lives there. A directory's page is then
  either its parent entry's `page` (spelled `x.md`) or its own `index` (spelled `x/_index.md`).
  The spelling tells a placement where to write the file and tells a reader the link base. No
  other flag is needed.
- When both exist, the node reads `index`, and the placement reports `shadowed-body` as now.
- A file entry may not take a name that a node entry has (`x` beside `x.md`), as with today's
  `duplicate-node-representation`.

Open, to settle while writing the spec. These are not Joe's calls unless he wants them:

- Whether `index` should be a page entry in `entries` named `_index` instead. That keeps one
  entry shape, but brings back a reserved name.
- Whether a node entry with only a `directory` and an empty directory object is allowed. Today
  an empty folder is a directory entry, so probably yes.

## Steps

1. **Spec.**
   - [Data model §5, §5.1, §6, §8, §11 and §12](../../docs/overstory-spec/1.1-data-model.md#5-objects):
     the objects above, entry times on node entries and `index`, and §8 rewritten around
     "a directory can have a page".
   - Remove the body-form change from §8 and from
     [locators §2.1 and §4](../../docs/overstory-spec/1.6-locators.md#4-resolution-rules).
     A move still rewrites the moved page's own relative links, as now. A node with no stored
     page resolves its links as if it had `x.md`, and the root as if it had `_index.md`.
   - Views are no longer bodies: §8 and §11, [Beetle §3.6](../../docs/overstory-spec/1.5-beetle.md#36-beetle-files),
     and locators §3.
   - [Placements on disk](../../docs/overstory-spec/2.2-placements-on-disk.md): how a scan maps
     `x.md`, `x/` and `x/_index.md` onto one entry.
   - Conformance vectors: node bodies, directory documents, protocol objects, pages, path reads
     and snapshot bundles, regenerated.
2. **Protocol packages, TypeScript and Swift:** encode, decode and validate the new entries and
   `index`. Object hashes and roots change.
3. **overstoryd:** acceptance, projections, path reads (a node's page and children come from one
   entry), the merge tool (a node entry's page and directory merge independently; rename and move
   carry both), and the provenance index, which is keyed by path, with a page's path unchanged.
4. **Story Sync:** a scan reads `x.md` plus `x/`, or `x/_index.md`, as one node, and writes each
   page back where its spelling says. A page created for a node writes `x.md`, or `_index.md` at
   the root.
5. **Story and StoryKit:** `presentPage` and the sidebar read one entry per node, and the
   pairing code goes. Creating a child under a leaf page already leaves the page where it is.
6. **Flag day:** host, Story, Story Sync and npm `@ovst/cli` ship together. Trees restart from
   their current state with no history, as on 2026-11-16. Joe's go, the release and the deploy
   go in [Joe's to-do](../joe.md) when the code is ready.
