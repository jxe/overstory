# Filesystem 030: move to one entry per node

**Why and when:** Joe wants this "very soon" (2026-11-18, in the spec revisit thread). The spec
already says it: every node has a page and children, either of which may be empty, held in one
directory entry with its metadata (`meta: { created, modified, style: { file: "_index" } }` for `x/_index.md`); the
tree's root is a node object; a new page is `x.md` and nothing moves a page between spellings;
`_index.md` is recognized wherever it occurs; empty folders are not tree content; and `.beetle`
files are files, not pages
([data model §5 and §8](../../docs/overstory-spec/1.1-data-model.md#5-objects),
[locators §2.1](../../docs/overstory-spec/1.4-locators.md#21-links-written-in-markdown)). The code
still pairs a `page` entry `x.md` with a `directory` entry `x`, or reads `_index.md` from a
directory's own entries. This plan moves it over. History is dropped again, as on the Protocol 003
flag day, so nothing converts old roots.

## Steps

1. **Protocol packages, TypeScript and Swift:** the node, directory and root objects, entry
   operations' `EntryValue`, references whose `object` picks a node's properties, children or schema, and the
   canonical rules (no empty properties or empty directory named). Object
   hashes and roots change. Regenerate the conformance vectors that encode objects or entries:
   node bodies, directory documents, protocol objects, pages, path reads, snapshot bundles,
   protocol graphs and accepted state.
2. **overstoryd:** acceptance, projections, path reads (the root node, the directories down to
   the parent, then the node's properties, children and schema), the merge tool (a node's properties,
   children, schema and each `meta` member merge independently; rename and move carry them all), and the provenance index, which
   is keyed by path. Views are served at their `.beetle` file's path with its extension.
3. **Story Sync:** a scan reads `x.md` beside `x/`, or `x/_index.md`, as one node and records the
   style; writes each page back where its style says; writes an empty node as an empty `x.md`;
   ignores empty folders; reports `shadowed-body` and `duplicate-node-representation`.
   **Typed nodes and records** (spec 2026-11-18, same flag day): a node's `schema` names its
   schema file and its `children` then names the head log entry; the directory's `collection`
   reference, `modelFingerprint` and `version` go (the fingerprint is computed from the schema),
   and `schema.beetle` stops being a directory entry. Wire renames from rows to records:
   `recordsHash`/`records` in log entries, `RecordChange { table, key, record }`, `TypedRecord`,
   `recordCreate`/`recordDelete`, record targets `{ node, table, record }`, `record-fields-v1`,
   `record-steps`/`records-steps`, a path read's `records: [{ table, record }]`, and a `field`
   decision's `record`. Code names (`collection-schema`, `collections.*`) can follow later.
   **Node shape** (spec 2026-11-19, same flag day): the page object becomes a properties object
   (ordered pairs, the body as the property `""`, last); `id` moves to the node entry; times and
   `style` move into the entry's `meta`; directories are canonical CBOR maps from name to entry;
   no object carries a `type` tag.
4. **Story and StoryKit:** `presentPage` and the sidebar read one entry per node, and the pairing
   code goes. Folders show their own times. Links to a `.beetle` file keep its extension.
5. **Flag day:** host, Story, Story Sync and npm `@ovst/cli` ship together. Trees restart from
   their current state with no history, as on 2026-11-16, and each tree's `_index.md` pages keep
   their spelling through `style`. Joe's go, the release and the deploy go in
   [Joe's to-do](../joe.md) when the code is ready.
