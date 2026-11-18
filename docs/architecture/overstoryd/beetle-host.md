# The Beetle host

overstoryd runs Beetle views and mutations ([views](../../overstory-spec/4.1-views.md), [mutations](../../overstory-spec/4.2-mutations.md))
in process, in `src/beetle-host.ts`, for every tree
([deployment](../../../packages/overstoryd/deploy/README.md#views-and-mutations)). It
interprets Beetle with [`@ovst/beetle`](../../../packages/beetle/README.md)'s checker and
evaluator; it loads no authored JavaScript, compiler or query engine
(`tests/unit/overstoryd-code-boundary.test.ts`).

## Code

A handle names a tree, a path, a declaration and a code version. The host reads the
handle's file at the tree's accepted head, and every file it uses, from retained objects:
a `.beetle` file's bytes, or a page's view blocks. The code version is SHA-256 over those
files' paths and texts, in path order (views §11); a handle whose version isn't the
head's answers "not active". Checked programs are cached by root and path.

## Rows

Views read each collection a program binds (a `schema.beetle` it uses) from the host's
database of it (Performance 007, `collection-databases.ts`):
`<data>/collections/<tree>/<path>/_store.sqlite3`, in the schema's database layout. It is
the collection's log applied, and records the log entry it is at, its row count and its
rows hash state. Every collection on the host has one, whether or not Beetle runs there.
Each accepted update applies its new log entries to the databases of the collections it
moved as it is accepted, each entry checked against its row count and rows hash, and
whatever reads a tree's databases waits for that: a view finds its database at the head.
A database that is missing, from another schema, or doesn't follow its log is rebuilt
from the newest snapshot entry's file (checked once against its rows hash) and the
entries after it; no whole log is replayed into memory. Commits don't wait on the disk:
the log is what the tree holds, and a database behind it applies the entries it lacks.

Accepting row operations reads the same databases (`CollectionDatabases.replay` and
`check`). The operations apply to just the rows they name, read from the database at the
basis's entry; each changed row is checked against the schema and against the rest of
the collection there by query (the rows it refers to exist, no other row has its `unique`
values or its name, no row still refers to a removed one), and the rows hash moves by
the changed rows alone. A trace's later frames and a candidate's new entries build on
entries the host checked and hasn't accepted yet. A basis no database is at, such as an
older root, is replayed from its log. Path reads of a row, and a collection's rows on a
public page, are read from the database at the head; an older root reads its log. A
snapshot's file is the database (`VACUUM INTO`), without its own record.

The view reads it through `@ovst/beetle/sqlite`'s
`SQLiteStore`, which asks SQLite only for what the view reaches: a `for` over a table is
narrowed by its conditions, translated to SQL (`sql.ts`: comparisons with null-safe `is`,
`and`/`or`/`not`, membership through relationships and lists, rules inlined, arithmetic,
text joins, `??`, `length`), with its `orderBy` and `limit` when every condition was
translated exactly and the ordering is on the row's own columns. Each condition has a
translation that keeps every row Beetle keeps and one that keeps only rows it keeps; where
they differ (case-folding beyond ASCII, values of mixed types, Person fields from profile
cards) the looser one narrows and the evaluator checks the rows. Keys and relationships are
looked up by their columns. Each read also carries the view's read shape (`shape.ts`, found from
the source): the relationships the view follows from those rows, at any depth, through
drawn views and rules. SQLite answers the rows and everything the shape follows in one
statement, as nested JSON (`json_object`/`json_group_array` subqueries), and the store
keeps each nested part as the answer to the match the evaluator will make for it. Before a
view runs, the evaluator asks for every read it knows from the source and input alone
(`Store.prefetch`): its table-typed inputs' rows, the people rows name when it ranges over
people, each table it ranges over with no condition that narrows it (once, with one shape
for every place it does), and its top-level `for`s narrowed by their inputs. SQLite answers
them all in one statement (`select json_array(…)`, batched past 100 reads). Every Supplies
view takes one statement. A `for` narrowed by one outer row's fields is read inside that
row's JSON as a correlated subquery, with its ordering and limit. Anything else the source
can't predict is read when the evaluator gets to it. The evaluator applies a condition
itself unless the store answered its exact translation; the in-memory store answers the
same and is what the tests compare against.
People are virtual `Person` rows: their name, handle and
bio come from profile cards the caller may read, and read as null otherwise.

## Views

`/views` streams use the protocol's `liveViewStream`. Each mount is evaluated over the
head's rows; a stream answers again when its tree accepts an update or a profile tree it
read from does, and sends a result only when the output changed. A data view's value is
its JSON; a UI view's is its node tree. The `rows` answer form waits for Story's
evaluator.

## Mutations

A mutation holds the databases of the collections it binds (no view, mutation or
accepted update moves them meanwhile), gathers its facts over them at the head, and writes
into a SQL transaction on each changed database's own second connection (`SQLiteWriteStore`,
`begin immediate`, SQLite's foreign key checks off because deletes follow the layout's
foreign keys themselves). Views keep reading the database as it was until the transaction
commits. When its update is accepted, the rows of its accepted log entry are written as
the entry holds them (stamped times included), the database records the entry, its row
count and rows hash, and the transaction commits, so it is what applying the entry would
have made. Otherwise it rolls back, and the database follows the log. Its row operations come from the
rows it touched (`editedLogical`): each written row's own logical row and the rows a
relationship holds it in (a join row's owner, an ordered connection's holder), each
converted from just its neighborhood, before and after, and stamped with the mutation's
time. No whole collection is read. It
submits them as one update guarded on the head it read, as its caller; a head that moved
runs it again. Public errors (`unauthorized`, `forbidden`, `missing`, `invalid`,
`conflict`) answer 401, 403, 404, 422 and 409 and write nothing. Receipts are kept in
`<data>/beetle/receipts.sqlite3` by caller and mutation ID: an exact retry is answered
from the receipt, and the same ID with other input is a conflict.
