// Performance 007: Story Sync reads a projection's changes by changed row, for linked
// layouts too (join tables, ordered members). Each read must give the root that reading the
// whole projection afresh gives.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeTree, resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { useSnapshotDatabase } from "@ovst/collection-schema";
import { sqliteSnapshots } from "@ovst/beetle/sqlite";
import type { ObjectHash } from "@ovst/protocol";
import { CollectionProjections, type CollectionProjectionForm } from "@ovst/story-sync/state";
import { collectionBasis, collectionTree, idRow } from "../support/collection-trees.ts";

useSnapshotDatabase(sqliteSnapshots);
const GAMES = `main table Game:
  name  Text
  tags  Text[]
  lists List[]

table List:
  name  Text
  games Game[]

ordered List.games[] <-> Game.lists[]
`;
const NOW = "2026-10-24T12:00:00.000Z";
let sandbox: string;
beforeAll(async () => { sandbox = await mkdtemp(join(tmpdir(), "story-changed-rows-")); });
afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

type Edit = { name: string; jsonl: (dir: string) => Promise<void>; sqlite: (db: Database) => void };

const lines = async (path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const writeLines = (path: string, rows: Record<string, unknown>[]) => writeFile(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
const time = { created: NOW, modified: NOW };

const EDITS: Edit[] = [
  { name: "a game's own field",
    jsonl: async (dir) => writeLines(join(dir, "Game.jsonl"), (await lines(join(dir, "Game.jsonl"))).map((r) => (r.id === "g2" ? { ...r, name: "Weiqi" } : r))),
    sqlite: (db) => db.query("update Game set name = 'Weiqi' where id = 'g2'").run() },
  { name: "a game added to a list",
    jsonl: async (dir) => writeLines(join(dir, "List_games.jsonl"), [...await lines(join(dir, "List_games.jsonl")), { ...time, list: "l1", game: "g3", games_position: 2 }]),
    sqlite: (db) => db.query(`insert into List_games (list, game, games_position, created, modified) values ('l1', 'g3', 2, '${NOW}', '${NOW}')`).run() },
  { name: "a list reordered",
    jsonl: async (dir) => writeLines(join(dir, "List_games.jsonl"), (await lines(join(dir, "List_games.jsonl"))).map((r) => ({ ...r, games_position: r.game === "g1" ? 0 : r.game === "g2" ? 1 : r.games_position }))),
    sqlite: (db) => { db.query("update List_games set games_position = 0 where game = 'g1'").run(); db.query("update List_games set games_position = 1 where game = 'g2'").run(); } },
  { name: "a game taken off a list",
    jsonl: async (dir) => writeLines(join(dir, "List_games.jsonl"), (await lines(join(dir, "List_games.jsonl"))).filter((r) => r.game !== "g2")),
    sqlite: (db) => db.query("delete from List_games where game = 'g2'").run() },
  { name: "a new game and a new list holding it",
    jsonl: async (dir) => {
      await writeLines(join(dir, "Game.jsonl"), [...await lines(join(dir, "Game.jsonl")), { id: "g4", name: "Hex", ...time }]);
      await writeLines(join(dir, "List.jsonl"), [...await lines(join(dir, "List.jsonl")), { id: "l2", name: "New", ...time }]);
      await writeLines(join(dir, "List_games.jsonl"), [...await lines(join(dir, "List_games.jsonl")), { ...time, list: "l2", game: "g4", games_position: 0 }]);
    },
    sqlite: (db) => {
      db.query(`insert into Game (id, name, tags, created, modified) values ('g4', 'Hex', '[]', '${NOW}', '${NOW}')`).run();
      db.query(`insert into List (id, name, created, modified) values ('l2', 'New', '${NOW}', '${NOW}')`).run();
      db.query(`insert into List_games (list, game, games_position, created, modified) values ('l2', 'g4', 0, '${NOW}', '${NOW}')`).run();
    } },
  { name: "a game removed with its places in lists",
    jsonl: async (dir) => {
      await writeLines(join(dir, "Game.jsonl"), (await lines(join(dir, "Game.jsonl"))).filter((r) => r.id !== "g1"));
      await writeLines(join(dir, "List_games.jsonl"), (await lines(join(dir, "List_games.jsonl"))).filter((r) => r.game !== "g1"));
    },
    sqlite: (db) => { db.query("delete from List_games where game = 'g1'").run(); db.query("delete from Game where id = 'g1'").run(); } },
];

for (const form of [{ kind: "files", format: "jsonl" }, { kind: "sqlite" }] as CollectionProjectionForm[]) {
  test(`${form.kind === "sqlite" ? "SQLite" : "JSONL"}: each read by changed row gives the root a whole read gives`, async () => {
    const tree = collectionTree(GAMES, {
      Game: [idRow("g1", { name: "Chess", tags: ["board"] }), idRow("g2", { name: "Go" }), idRow("g3", { name: "Shogi" })],
      List: [idRow("l1", { name: "Favorites", games: ["g2", "g1"] })],
    });
    const root = join(sandbox, form.kind);
    const objects = new Map(tree.objects);
    const load = async (hash: ObjectHash) => objects.get(hash) ?? Promise.reject(new Error(`missing ${hash}`));
    const projections = new CollectionProjections({ form: () => form, now: () => NOW });
    await materializeTree(root, tree.root, load, undefined, [], undefined, (directory, object, read) => projections.write(directory, object, read));
    const scan = async (with_: CollectionProjections) => {
      const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], (directory, names) => with_.read(directory, names)));
      for (const [hash, bytes] of snapshot.objects) objects.set(hash, bytes);
      return snapshot.root;
    };
    let accepted = await scan(projections);
    expect(accepted).toBe(tree.root);
    for (const edit of EDITS) {
      if (form.kind === "sqlite") {
        const db = new Database(join(root, "items", "_store.sqlite3"));
        try { edit.sqlite(db); } finally { db.close(); }
      } else {
        await edit.jsonl(join(root, "items"));
      }
      const before = projections.counts.byChangedRow;
      const changed = await scan(projections);
      expect(projections.counts.byChangedRow, edit.name).toBe(before + 1);
      // The whole projection read afresh, against the same basis.
      const basis = await collectionBasis(accepted as ObjectHash, objects);
      const whole = await scan(new CollectionProjections({ basis: async () => basis, now: () => NOW }));
      expect(changed, edit.name).toBe(whole);
      expect(changed, edit.name).not.toBe(accepted);
      accepted = changed;
    }
  });
}

// The rehearsal for the flag day found a row's `modified` going backwards: a folder that
// keeps row times holds the time the row had before an edit until the projection is rewritten, so a
// second edit of the same row must still be stamped with its own time, not the file's stale one.
for (const form of [{ kind: "files", format: "jsonl" }, { kind: "sqlite" }] as CollectionProjectionForm[]) {
  test(`${form.kind === "sqlite" ? "SQLite" : "JSONL"}: a row edited twice is modified at the second edit, and connection rows keep their own times`, async () => {
    const T1 = "2026-11-16T10:00:00.000Z", T2 = "2026-11-16T11:00:00.000Z";
    const tree = collectionTree(GAMES, {
      Game: [idRow("g1", { name: "Chess" }), idRow("g2", { name: "Go" })],
      List: [idRow("l1", { name: "Favorites", games: ["g2", "g1"] })],
    });
    const root = join(sandbox, `twice-${form.kind}`);
    const objects = new Map(tree.objects);
    const load = async (hash: ObjectHash) => objects.get(hash) ?? Promise.reject(new Error(`missing ${hash}`));
    let now = NOW;
    const projections = new CollectionProjections({ form: () => form, now: () => now });
    await materializeTree(root, tree.root, load, undefined, [], undefined, (directory, object, read) => projections.write(directory, object, read));
    const scan = async () => {
      const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], (directory, names) => projections.read(directory, names)));
      for (const [hash, bytes] of snapshot.objects) objects.set(hash, bytes);
      return snapshot.root as ObjectHash;
    };
    const rename = async (id: string, name: string) => {
      if (form.kind === "sqlite") {
        const db = new Database(join(root, "items", "_store.sqlite3"));
        try { db.query("update Game set name = ? where id = ?").run(name, id); } finally { db.close(); }
      } else {
        await writeLines(join(root, "items", "Game.jsonl"), (await lines(join(root, "items", "Game.jsonl"))).map((r) => (r.id === id ? { ...r, name } : r)));
      }
    };
    const game = async (at: ObjectHash, id: string) => (await collectionBasis(at, objects)).tables.Game!.find((r) => r.key[0]![1] === id)!;
    expect(await scan()).toBe(tree.root);
    // Edit g2, and let the host accept it: the folder already holds what was accepted, so it isn't rewritten.
    now = T1;
    await rename("g2", "Weiqi");
    const first = await scan();
    expect((await game(first, "g2")).modified).toBe(Date.parse(T1));
    now = T2;
    await rename("g2", "Baduk");
    if (form.kind === "sqlite") {
      const db = new Database(join(root, "items", "_store.sqlite3"));
      try { db.query("update List set name = 'Best' where id = 'l1'").run(); } finally { db.close(); }
    } else {
      await writeLines(join(root, "items", "List.jsonl"), (await lines(join(root, "items", "List.jsonl"))).map((r) => ({ ...r, name: "Best" })));
    }
    const second = await scan();
    expect((await game(second, "g2")).created).toBe(Date.parse("2026-10-24T09:00:00.000Z"));
    expect((await game(second, "g2")).modified).toBe(Date.parse(T2));
    // Written back from the tree (as after another device's edit), the list's connection rows keep their times.
    const listGames = async () => form.kind === "sqlite"
      ? (() => { const db = new Database(join(root, "items", "_store.sqlite3"), { readonly: true }); try { return db.query("select game, created from List_games order by game").all(); } finally { db.close(); } })()
      : (await lines(join(root, "items", "List_games.jsonl"))).map((r) => ({ game: r.game, created: r.created })).sort((a, b) => String(a.game).localeCompare(String(b.game)));
    const was = await listGames();
    await materializeTree(root, second, load, undefined, [], undefined, (directory, object, read) => projections.write(directory, object, read));
    expect(await listGames()).toEqual(was);
    now = "2026-11-16T12:00:00.000Z";
    await rename("g2", "Go again");
    const third = await scan();
    expect((await game(third, "g2")).modified).toBe(Date.parse(now));
  });
}
