# Schema language 008: port excellences and supplies-remake to Story

**Why and when:** Joe asked on 2026-10-13 for the MAI excellences document and supplies-remake
to run natively in Story on Overstory collections instead of Supabase. This was milestone 6 of
Schema language 002; Joe split it out on 2026-10-25. It needs
[Schema language 007](../features/schema-language-007-editing-in-the-collection-view.md)'s structured
editor (step 8) and [Security 013](../features/security-013-row-ownership-and-read-rules.md)'s
row ownership. Updated 2026-11-17 after USL was removed from arbor.

## Status

- **Effort:** M.
- **Risk:** MEDIUM. Each site's data moves; the live sites keep running until Joe switches.

## Where things are

- Both sites run on cranberries, which still reads USL: excellences' `lib/schema.usl` and
  supplies-remake's schema use `@ovst/usl` 0.3.0, frozen on npm. Arbor reads only
  `schema.beetle`, and its table checker is `@ovst/beetle/tables`.
- `tests/fixtures/tables/supplies.beetle` and `packages/beetle/examples/supplies/` are the
  Supplies schema and mutations in Beetle. `tests/fixtures/tables/excellences.beetle` has
  drifted from excellences' own schema, which has the `@fold`s.
- The games sandbox (2026-10-24) was filled by a one-off script from the public
  `GET /api/cranberries?document=games`: ids and `modified` kept, `created` not carried,
  people's names, avatars and bios dropped (no Person rows).

## Steps

1. **Excellences' schema in Beetle.** Write excellences' `lib/schema.usl` as `schema.beetle`
   (models, `@fold`s), replace the drifted fixture with it, and check it with
   `@ovst/beetle/tables`.
2. **An importer** reads cranberries' snapshot (`GET /api/cranberries`, or the `remake` tables)
   into a tree, through `@ovst/beetle/tables`' `rowsFromRecords`:
   - the games tables and the excellences tables, as JSONL or SQLite;
   - `created`/`modified` carried over from cranberries' stamps;
   - list positions from `List_games.games_position`;
   - people without accounts as `contact:<key>` placeholders keyed by their source id, as the
     games sandbox does; they show by name once the People directory holds them.
   Cranberries has no export command: `readDocument` returns the whole snapshot, so a small
   `cranberries export` would serve both sites.
3. **Check and compare.** Run the store check (`@ovst/beetle/tables/verify`), then show the
   result in Story next to the live site and compare.

**Done when:** the excellences document and a supplies-remake game list run in Story, backed by
files or SQLite, with the same content they have on Supabase, and Supplies' ownership rule
holds as access policy.

## Close out

Record the evidence in `status.md`; switching the live sites is Joe's go-ahead (to-do). Delete
this plan.
