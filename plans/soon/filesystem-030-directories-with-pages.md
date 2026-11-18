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
  as now ([locators §2.1](../../docs/overstory-spec/1.4-locators.md#21-links-written-in-markdown)),
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

Every node has a page and children, either of which may be empty, and a link base (Joe,
2026-11-18). A node keeps all three in its own entry, however its page is spelled. Joe chose
this over keeping `_index.md` on the directory object or as an `_index` entry.

```ts
type ProtocolNode = {                       // a directory entry, and the tree's root
  page?: Hash;                              // left out when the page is empty
  created: number; modified: number;        // the node's times, as a page entry's today
  directory?: Hash;                         // left out when there are no children
  base?: "folder";                          // the page is spelled `x/_index.md`
};

type ProtocolDirectoryEntry =
  | { name: Name; file: Hash; created: number; modified: number }   // name keeps its extension
  | ({ name: Name } & ProtocolNode)                                  // name has no `.md`
  | { name: Name; tree: TreeID };

type ProtocolDirectory = {
  type: "directory";
  entries: ProtocolDirectoryEntry[];
  collection?: CollectionReference;
};
```

- **There is no variation in the model.** Every node is (page, children, base). The canonical
  encoding leaves out an empty page, empty children and the default base, so `{name, created,
  modified}` alone is an empty node. Absence never means a different kind of thing.
- **`base`** says what the page's relative links resolve from: by default the parent folder,
  with the page spelled `x.md` beside `x/`, or with `base: "folder"` the node's own folder,
  with the page spelled `x/_index.md`. Joe preferred naming it for what it does, over `inside`
  and over a `pageName`, an `index` key in place of `page`, the page object, frontmatter, or
  converting `_index.md` on scan. `base` is written only when the page has content.
- **The root** is a `ProtocolNode`, not a directory, so its page sits beside its children. Its
  page is spelled `_index.md` on disk, and it has no `base`.
- **On disk:**
  - An empty page writes no file, and empty children write no folder.
  - A node that is empty on both counts is an empty `x.md`, which is what a new page is.
  - Empty folders are not tree content, as in git. A placement leaves them alone, and a
    folder becomes a node once it holds something.
  - Folders get times: every node carries `created` and `modified`, whether or not its page
    has content. A child's change doesn't touch them.
- When a folder holds both `x.md` and `x/_index.md`, a placement keeps `_index.md` as the page,
  reports `shadowed-body` as now, and leaves the other file out of the tree.
- A file entry may not take a name that a node entry has (`x` beside `x.md`), as with today's
  `duplicate-node-representation`.
- A rename or move carries the page, its children and its base together. Editing a page changes
  the same objects whichever way it is spelled.

## Steps

1. **Spec.**
   - [data model §5, §5.1, §6, §8, §11 and §12](../../docs/overstory-spec/1.1-data-model.md#5-objects):
     the objects above, entry times on node entries, a root that is a node, and §8 rewritten around
     "a directory can have a page".
   - Remove the body-form change from §8 and from
     [locators §4 and §4](../../docs/overstory-spec/1.4-locators.md#4-resolution-rules).
     A move still rewrites the moved page's own relative links, as now. A node with no stored
     page resolves its links as if it had `x.md`, and the root as if it had `_index.md`.
   - Views are no longer bodies: §8 and §11, [Beetle §2](../../docs/overstory-spec/3.2-beetle.md#2-beetle-files),
     and locators §3.
   - [Placements on disk](../../docs/overstory-spec/7.2-placements-on-disk.md): how a scan maps
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
