# Security 013: row ownership and read rules

**Why:** a shared collection needs rows that only their authors edit (games by their authors,
Supplies' lists by their owner unless `openToEdits`, excellences' entries) and rows hidden from
people who may not see them, whatever view reads them. Both are access policy that reads a
row's own data. [Schema language 008](../later/schema-language-008-port-excellences-and-supplies.md)
is the first customer. Merged on 2026-11-17 (Joe) from Schema language 010 (row ownership,
formerly milestone 5 of Schema language 002, settled with Joe on 2026-10-15) and this plan's
read rules (split from Apps 005 on 2026-11-08).

## Status

- **Effort:** M for ownership, M for read rules.
- **Risk:** HIGH: an authority boundary, access rules that read row data, and device updates
  authorized by effect.

## Joe's decisions

- **Ownership is access policy, not schema**: it must also work on pages that aren't rows
  (front matter `authors`). `access.yaml` gains a property subject, `who: {property: authors}`,
  matching the profiles in that property of the node being changed, judged on its current
  accepted state. One predicate, `unless`/`when: {property: x}` (non-empty), covers "anyone may
  edit unowned rows" and Supplies' `openToEdits`; try it and revisit. No special rule for
  editing `schema.beetle`. "Anyone signed in" is the host's community group; no new subject.
  (2026-10-15)
- **Read rules belong to the model, and the host applies them** to every view and `rows`
  answer, as row-level rules in `access.yaml` such as `who: {property: owner}`. Value
  predicates (`when: {property: visibility, is: Public}`) come second. (2026-11-08)
- No snapshot edits of fine-grained data (2026-10-15), below.

## Invariant

Data never grants access by itself: a property subject only matters through a rule an
administrator accepted.

## What exists now

- Access is whole-tree for device callers. `AccessControl.canWrite` checks at `/`
  (`packages/overstoryd/src/access.ts`); narrow operations are consulted only for executions.
- `resource-effects.ts` sees paths: a collection row edit is `update-content` of the
  collection, and a front-matter edit is `write`.
- `ResourcePolicyContext` (`packages/protocol/src/model/resource-policy.ts`) has no node or state.
- The host's Beetle views and mutations run as their caller
  ([the Beetle host](../../docs/architecture/overstoryd/beetle-host.md)), reading every row the
  caller can read in the tree; a view's `rows` answer ships those rows to the device.
- Supplies' ownership is an app rule its mutations call
  (`rule editor(l List): l.owner == me or l.openToEdits` in
  `packages/beetle/examples/supplies/mutations.beetle`), not a boundary.
- `docs/overstory-spec/conformance/resource-policy.json` covers grammar only.

## 1. Row ownership

**Spec (access control, 3.2).**
- `who: {property: authors}` matches the profiles in that property of the node being changed:
  a row, or a page's front matter. For a new child, it's the parent's property. It's read from
  current accepted state at acceptance. Entries that aren't profile TreeIDs or locators match
  nobody, and a group counts through its members.
- `unless`/`when: {property: x}` (non-empty) is the one row predicate.
- "Anyone signed in" is `{profile: <community TreeID>}`: the group profile at the host's
  canonical `/`; `isGroupMember` already counts enabled accounts.
- **Guard:** changing a property that a rule's subject or predicate names requires that the
  caller currently matches that rule, or is an administrator. Without it, anyone who can write
  a row grants access by editing the field. Precedent: `tree-config-policy.ts`
  `authorizePersonConfigTransition` checks each field against the base.
- Where a schema exists, a rule naming a property that isn't `Person` or `Person[]` is a
  configuration diagnostic.

**Code.**
- Parsing: `parseWho`/`parseResourceRule` (which refuse unknown keys) and the Swift
  `ProtocolResourceWho` and `ProtocolResourceAccessRule`.
- `ResourcePolicyContext` gets a `propertyProfiles(path, name)` callback over current state.
- Effects become semantic: row operations give exact `(row, field)` effects, and front-matter
  edits give property effects instead of `write`. Device updates are then authorized by
  effect, not only by whole-tree `canWrite`.
- No snapshot edits of fine-grained data: a snapshot that changes a collection is authorized
  only as `write` on that collection's path. A caller whose access there comes from a property
  rule, `unless`/`when`, or a narrower grant must send row operations. Story Sync already
  diffs a projection's rows against its base and sends row operations, so the host never
  authorizes ownership from a row diff and needs no tree-level mode switch.
- Readers can't read `access.yaml`, so Story learns locks from an advisory
  per-node answer: fill `NodeCapabilities.*.writable` (`protocol/src/model/node-model.ts`)
  from the host's evaluation.
- Supplies' `editor` rule becomes two access rules: `{property: owner}`, and the community
  with `when: {property: openToEdits}`.
- Conformance: `resource-policy.json` gains valid and invalid property rules and evaluation
  vectors (rule, caller, node properties → allowed) so both stacks agree.

**Done when:** in a shared games tree, an author edits only their own games, anyone in the
community edits unowned ones, and nobody but an owner or administrator changes `authors`.

## 2. Read rules

- Parse row-level read rules from `access.yaml`, compiled once per caller and schema version,
  and apply them in the Beetle host to every read of that model: views, joins, declared views
  and `rows` answers. A view that forgets them can't see past them.

**Verify:** a host view that omits a model's read rule still gets only the rows the rule
allows, through `value`, `tree`, `rows` and a declared view.

## 3. Value predicates

`when: {property: visibility, is: Public}`, so Supplies' public/private check stops being an
app rule its views call and becomes a boundary.

**Verify:** a `rows` answer for a Supplies page never holds another person's private list.

## Open question

1. Is "property non-empty" the right size for `unless`/`when`? Revisit after Supplies and
   excellences use it.
