import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileSchema } from "@ovst/beetle";
import { modelLayer } from "@ovst/beetle/tables";

// The table checker (packages/beetle/src/tables), reached through compileSchema.
const fixtures = join(import.meta.dir, "../fixtures/tables");
const beetle = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".beetle")).sort();

describe("tables: examples", () => {
  for (const name of beetle(fixtures)) {
    test(`${name} checks clean`, () => {
      expect(compileSchema(readFileSync(join(fixtures, name), "utf8")).diagnostics).toEqual([]);
    });
  }
});

describe("tables: broken examples", () => {
  const dir = join(fixtures, "invalid");
  for (const name of beetle(dir)) {
    test(`${name} reports exactly what it expects`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const expected = [...source.matchAll(/^\s*\/\/ expect: ([a-z-]+)$/gm)].map((m) => m[1]!).sort();
      expect(expected.length).toBeGreaterThan(0);
      expect(compileSchema(source).diagnostics.map((d) => d.code).sort()).toEqual(expected);
    });
  }
});

describe("tables: resolution", () => {
  test("a connection table is keyed by its ends and gives each side a field", () => {
    const { models } = compileSchema(`table Game:
  name Text

table Rating:
  Person.ratings[]
  Game.ratings[]
  stars Number
`);
    const rating = models.find((m) => m.name === "Rating")!;
    expect(rating.key).toEqual(["person", "game"]);
    const game = models.find((m) => m.name === "Game")!;
    expect(game.fields.find((f) => f.name === "ratings")).toMatchObject({ type: "Rating", arity: "many", origin: "connection" });
  });

  test("storage: 1:n is a column on the single side, n:m an array on the first end with a table", () => {
    const { connections } = compileSchema(`table Episode:
  title Text

table Series:
  title Text

Series.episodes[] <-> Episode.series
Person.games[] <-> Game.authors[]

table Game:
  name Text
`);
    expect(connections.map((c) => c.storage)).toEqual([
      { kind: "column", on: "Episode", field: "series" },
      { kind: "array", on: "Game", field: "authors", sqlite: "join table" },
    ]);
  });
});

describe("tables: model layer", () => {
  const layer = (source: string) => modelLayer(compileSchema(source));
  const base = `main table Game:
  name   Text
  status Status

Game.authors[] <-> Person.games[]
Game.status <-> Status.games[]

enum Status:
  B
  A
`;

  test("leaves out storage", () => {
    const decorated = `main table Game:
  name   Text @column("title")
  status Status
  @table("games")
  @index(name)

Game.authors[] @fold <-> Person.games[]
Game.status <-> Status.games[]

enum Status:
  B
  A

re Status:
  A @stored("a")
`;
    expect(layer(decorated)).toEqual(layer(base));
  });

  test("is ordered by name, whatever order the schema uses", () => {
    const reordered = `enum Status:
  A
  B

Game.status <-> Status.games[]

main table Game:
  status Status
  name   Text

Game.authors[] <-> Person.games[]
`;
    expect(layer(reordered)).toEqual(layer(base));
    expect(layer(base).models.map((m) => m.name)).toEqual(["Game", "Person", "Status"]);
  });

  test("changes with the model", () => {
    expect(layer(base.replace("name   Text", "name   unique Text"))).not.toEqual(layer(base));
    expect(layer(base.replace("main table", "table"))).not.toEqual(layer(base));
  });
});
