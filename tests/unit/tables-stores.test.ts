import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { compileSchema } from "@ovst/beetle";
import { columnType, layoutOf, recordsFromRows, rowsFromRecords, setupSql, typeDeclarations, validateRow, type Table } from "@ovst/beetle/tables";
import { compareShapes, inspectSqlite, sqliteAffinity, verifyFiles, verifyStore } from "@ovst/beetle/tables/verify";

const fixtures = join(import.meta.dir, "../fixtures/tables");
const schemaOf = (name: string) => compileSchema(readFileSync(join(fixtures, `${name}.beetle`), "utf8"));
const tablesOf = (name: string): Table[] => layoutOf(schemaOf(name));
const fileTablesOf = (name: string): Table[] => layoutOf(schemaOf(name), { store: "files" });
const names = readdirSync(fixtures)
  .filter((f) => f.endsWith(".beetle"))
  .map((f) => f.slice(0, -7));

function sqliteWith(tables: Table[]): Database {
  const db = new Database(":memory:");
  const sql = setupSql(tables, "sqlite");
  db.exec(sql);
  db.exec(sql); // idempotent
  return db;
}
const verifySqlite = (tables: Table[], db: Database) =>
  compareShapes(tables, inspectSqlite(db), (_, c) => columnType(c, "sqlite"), (a, b) => sqliteAffinity(a) === sqliteAffinity(b));

describe("tables: setup SQL on SQLite", () => {
  for (const name of names) {
    test(`${name}: runs twice and the database implements the schema`, () => {
      const tables = tablesOf(name);
      expect(verifySqlite(tables, sqliteWith(tables))).toEqual([]);
    });
  }

  test("seed rows are inserted once and never overwrite edits", () => {
    const tables = tablesOf("stress");
    const db = sqliteWith(tables);
    db.exec(`UPDATE "Genre3" SET "name" = 'Puzzles' WHERE "id" = 'Puzzle'`);
    db.exec(setupSql(tables, "sqlite"));
    expect(db.query(`SELECT "id", "name" FROM "Genre3" ORDER BY "id"`).all()).toEqual([
      { id: "Puzzle", name: "Puzzles" },
      { id: "Strategy", name: "Strategy" },
    ]);
  });

  test("constraints hold: fixed values, composite references, cascades", () => {
    const db = sqliteWith(tablesOf("supplies"));
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`INSERT INTO "List" ("id", "name", "openToEdits", "owner", "visibility", "kind") VALUES ('l1', 'Mine', 0, 'p1', 'Public', 'Tagged')`);
    expect(() =>
      db.exec(`INSERT INTO "List" ("id", "name", "openToEdits", "owner", "visibility", "kind") VALUES ('l2', 'Bad', 0, 'p1', 'Secret', 'Tagged')`),
    ).toThrow(/CHECK/);
    db.exec(`INSERT INTO "Practice" ("id", "name") VALUES ('pr1', 'Breathing')`);
    db.exec(`INSERT INTO "Tag" ("list", "id", "name") VALUES ('l1', 't1', 'calm')`);
    db.exec(`INSERT INTO "Tag_practices" ("tag_list", "tag_id", "practice") VALUES ('l1', 't1', 'pr1')`);
    expect(() => db.exec(`INSERT INTO "Tag_practices" ("tag_list", "tag_id", "practice") VALUES ('l2', 't1', 'pr1')`)).toThrow(/FOREIGN KEY/);
    db.exec(`DELETE FROM "Practice" WHERE "id" = 'pr1'`);
    expect(db.query(`SELECT count(*) AS n FROM "Tag_practices"`).get()).toEqual({ n: 0 });
  });

  test("reports where a database differs", () => {
    const tables = tablesOf("stress");
    const db = new Database(":memory:");
    // Hand-written drift: a nullable title, an untyped extra column, no Team_members, and Rating without its foreign key.
    db.exec(setupSql(tables, "sqlite").replace(`"title" TEXT NOT NULL,\n  "body"`, `"title" TEXT,\n  "body"`));
    db.exec(`ALTER TABLE "Game" ADD COLUMN "extra" TEXT NOT NULL DEFAULT ''`);
    db.exec(`DROP TABLE "Team_members"`);
    db.exec(`CREATE TABLE "Notes" ("id" TEXT PRIMARY KEY)`);
    const codes = verifySqlite(tables, db).map((d) => `${d.severity}:${d.code}:${d.table}`);
    expect(codes.sort()).toEqual(
      ["error:column-nullable:Page", "warning:extra-column:Game", "error:missing-table:Team_members", "warning:extra-table:Notes"].sort(),
    );
  });
});

const postgresUrl = process.env.TABLES_TEST_POSTGRES;
describe.skipIf(!postgresUrl)("tables: setup SQL on Postgres (TABLES_TEST_POSTGRES=postgres://...)", () => {
  for (const name of names) {
    test(`${name}: runs twice and the database implements the schema`, async () => {
      const admin = new SQL(postgresUrl!);
      const db = `tables_test_${name}`;
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db}`);
      await admin.unsafe(`CREATE DATABASE ${db}`);
      await admin.close();
      const url = new URL(postgresUrl!);
      url.pathname = `/${db}`;
      const sql = new SQL(url.toString());
      const tables = tablesOf(name);
      await sql.unsafe(setupSql(tables, "postgres")).simple();
      await sql.unsafe(setupSql(tables, "postgres")).simple();
      await sql.close();
      expect(await verifyStore(schemaOf(name), url.toString())).toEqual([]);
    });
  }
});

describe("tables: data files", () => {
  test("a folder of CSV, JSON and JSONL files that implements the games schema", () => {
    expect(verifyFiles(fileTablesOf("games"), join(fixtures, "games-files"))).toEqual([]);
  });

  test("broken files report each problem", () => {
    const codes = verifyFiles(fileTablesOf("games"), join(fixtures, "games-files-broken")).map((d) => `${d.severity}:${d.code}:${d.table ?? ""}`);
    expect(codes.sort()).toEqual(
      [
        "warning:extra-column:Game",
        "error:bad-value:Game",
        "error:bad-value:Game",
        "error:missing-value:Game",
        "error:duplicate-key:Game",
        "error:bad-value:List",
        "error:dangling-reference:List",
        "warning:extra-table:",
      ].sort(),
    );
  });

  test("validateRow checks one row as Overstory would on write", () => {
    const game = tablesOf("games").find((t) => t.name === "Game")!;
    expect(validateRow(game, { id: "g", name: "Go", status: "Draft", tags: ["x"] })).toEqual([]);
    expect(validateRow(game, { id: "g", status: "Done", tags: "x" }).map((d) => d.code)).toEqual(["bad-value", "bad-value", "missing-value"]);
  });
});

describe("tables: storage names and folding", () => {
  test("@table and @column rename what is stored, references included", () => {
    const tables = tablesOf("stress");
    const episode = tables.find((t) => t.name === "Episode")!;
    expect(tables.map((t) => t.name)).toContain("series");
    expect(episode.foreignKeys).toContainEqual({ columns: ["series_id"], table: "series", refColumns: ["id"], onDelete: "restrict" });
    expect(tables.find((t) => t.name === "series")!.columns.map((c) => c.name)).toContain("series_title");
  });

  test("@fold keeps an n:m as an array in data files and a join table in databases", () => {
    expect(tablesOf("games").map((t) => t.name)).toEqual(["Game", "List", "Game_authors", "List_games"]);
    const files = fileTablesOf("games");
    expect(files.map((t) => t.name)).toEqual(["Game", "List"]);
    expect(files.find((t) => t.name === "List")!.columns.find((c) => c.name === "games")).toMatchObject({
      array: true,
      references: { table: "Game" },
    });
  });
});

describe("tables: for Overstory", () => {
  test("type declarations follow the stored columns", () => {
    const out = typeDeclarations(tablesOf("games"));
    expect(out).toContain(`export type Game = {`);
    expect(out).toContain(`  status: "Draft" | "Playtested" | "Polished";`);
    expect(out).toContain(`  description: string | null;`);
    expect(out).toContain(`  person: string; // a Story profile id`);
  });


  test("`path` names rows by a required text field", () => {
    const ok = compileSchema("table Post:\n  slug:  path Text\n  title: Text\n");
    expect(ok.diagnostics).toEqual([]);
    expect(ok.models.find((m) => m.name === "Post")!.path).toBe("slug");
    expect(compileSchema("table Post:\n  slug: path Text?\n").diagnostics.map((d) => d.code)).toEqual(["path-field"]);
    expect(compileSchema("table Post:\n  a: path Text\n  b: path Text\n").diagnostics.map((d) => d.code)).toEqual(["duplicate-path"]);
  });

  test("Int is a whole number, stored as INTEGER and bigint", () => {
    const tables = layoutOf(compileSchema("table Count:\n  n: Int\n"));
    expect(setupSql(tables, "sqlite")).toContain(`"n" INTEGER NOT NULL`);
    expect(setupSql(tables, "postgres")).toContain(`"n" bigint NOT NULL`);
    expect(compileSchema('table C:\n  name: Text\n  n:    Int\n  seed:\n    A { name: "A", n: 1.5 }\n').diagnostics.map((d) => d.code)).toContain("bad-value");
  });

  test("limits stop a hostile schema", () => {
    expect(compileSchema("x".repeat(1_100_000)).diagnostics.map((d) => d.code)).toEqual(["limit"]);
  });
});

describe("tables: for apps", () => {
  const source = `table Game:
  name    Text
  status  Status
  tags    Text[]
  done    Bool
  due     Date?
  authors Person[]

  @index(status, modified)

table List:
  name  Text
  owner Person
  games Game[]

table Note (game, id):
  game Game
  body Markdown

Game.authors[] @fold <-> Person.games[]
ordered List.games[] @fold <-> Game.lists[]
List.owner <-> Person.lists[]
Note.game <-> Game.notes[]
Game.status <-> Status.games[]

enum Status:
  Draft
  Done
`;
  const result = compileSchema(source);
  const tables = layoutOf(result);

  test("@index is resolved", () => {
    expect(result.diagnostics).toEqual([]);
    const game = result.models.find((m) => m.name === "Game")!;
    expect(game.indexes).toEqual([["status", "modified"]]);
    expect(game.fields.map((f) => f.name)).toEqual(["name", "status", "tags", "done", "due", "authors", "lists", "notes"]);
    const many = compileSchema("table A:\n  tags: Text[]\n  @index(tags)\n  @index(nope)\n").diagnostics.map((d) => d.code);
    expect(many).toEqual(["index-many", "unknown-field"]);
  });

  test("references and @index are indexed", () => {
    const indexes = Object.fromEntries(tables.map((t) => [t.name, t.indexes]));
    expect(indexes).toEqual({
      Game: [["status", "modified"]],
      List: [["owner"]],
      Note: [],
      Game_authors: [["person"]],
      List_games: [["game"]],
    });
    expect(setupSql(tables, "postgres")).toContain('CREATE INDEX IF NOT EXISTS "List_owner_idx" ON "List" ("owner");');
    expect(layoutOf(result, { store: "files" }).every((t) => t.indexes.length === 0)).toBe(true);
    const qualified = setupSql(tables, "postgres", { schema: "remake" });
    expect(qualified).toStartWith('CREATE SCHEMA IF NOT EXISTS "remake";');
    expect(qualified).toContain('CREATE TABLE IF NOT EXISTS "remake"."List_games"');
    expect(qualified).toContain('REFERENCES "remake"."List" ("id") ON DELETE CASCADE');
    expect(qualified).not.toMatch(/(?<!"remake"\.)"Game" \(/);
  });

  test("records round-trip through SQLite tables", () => {
    const records = {
      Game: [
        { id: "g1", name: "Chess", status: "Done", tags: ["old"], done: true, due: "2026-10-14", authors: ["tr_pa", "tr_pb"] },
        { id: "g2", name: "Go", status: "Draft", tags: [], done: false, due: null, authors: [] },
      ],
      List: [{ id: "l1", name: "Favorites", owner: "tr_pa", games: ["g2", "g1"] }],
      Note: [{ game: "g1", id: "n1", body: "Opening" }],
    };
    const rows = rowsFromRecords(tables, records);
    expect(rows.List_games).toEqual([
      { list: "l1", game: "g2", games_position: 0 },
      { list: "l1", game: "g1", games_position: 1 },
    ]);
    const db = new Database(":memory:");
    db.exec(setupSql(tables, "sqlite"));
    for (const table of tables) {
      for (const row of rows[table.name] ?? []) {
        const names = Object.keys(row);
        const values = names.map((n) => {
          const v = row[n];
          return Array.isArray(v) ? JSON.stringify(v) : typeof v === "boolean" ? Number(v) : (v as any);
        });
        db.prepare(`INSERT INTO "${table.name}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...values);
      }
    }
    const read = Object.fromEntries(tables.map((t) => [t.name, db.query(`SELECT * FROM "${t.name}" ORDER BY rowid DESC`).all() as Record<string, unknown>[]]));
    const back = recordsFromRows(tables, read);
    const byId = (rs: Record<string, unknown>[]) => [...rs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    // Game.authors isn't ordered, so its members come back in no particular order.
    const games = byId(back.Game!).map((g) => ({ ...g, authors: [...(g.authors as string[])].sort() }));
    expect(games).toEqual(records.Game);
    expect(back.List).toEqual(records.List);
    expect(back.Note).toEqual(records.Note);
    expect(Object.keys(recordsFromRows(tables, read, { timestamps: true }).List![0]!)).toContain("modified");
  });
});
