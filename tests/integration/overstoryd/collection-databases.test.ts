// Performance 007: the host's database of a collection is where its rows are. Accepting row
// changes reads only the rows they name from it and checks them against the rest there; the
// database follows each accepted entry, and a restarted host opens it rather than replaying
// the log.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHost } from "@ovst/overstoryd";
import { StoreSchema } from "@ovst/beetle";
import { loadDirectoryCollection } from "@ovst/collection-schema";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, ProtocolClient, type DerivableCandidateUpdate, type ProtocolDirectory, type SourceOperation } from "@ovst/protocol";
import { rowsFromLogical } from "@ovst/usl";
import { CollectionDatabase } from "../../../packages/overstoryd/src/collection-databases.ts";
import { collectionDirectory, idRow } from "../../support/collection-trees.ts";
import { deviceClient, testAccount } from "../../helpers/devices.ts";

const TEST_TIME = new Date(Date.UTC(2026, 10, 11)).toISOString();
const SCHEMA = [
  "main table Author:",
  "  name unique Text",
  "",
  "table Book:",
  "  title  Text",
  "  author Author",
  "",
  "Book.author <-> Author.books[]",
  "",
].join("\n");
const token = "db-owner";

let dir: string, running: Awaited<ReturnType<typeof serveHost>>, client: ProtocolClient;
let tree: string, objects: Map<string, Uint8Array>;

async function start() {
  running = await serveHost({ dataRoot: dir, accounts: [testAccount("owner", token, { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  client = await deviceClient(running.url, token);
}
async function stop() { running.server.stop(true); await running.overstoryd[Symbol.asyncDispose](); }

const key = (id: string) => JSON.stringify([["id", id]]);
let clock = Date.parse("2026-10-24T09:00:00.000Z");
const now = () => new Date(clock++).toISOString();

/** The `/library` folder's hash at `root`, from the host. */
async function library(root: string): Promise<string> {
  for (const [hash, bytes] of (await client.snapshot(tree, root)).objects) objects.set(hash, bytes);
  return decodeProtocolDirectory(objects.get(root)!).entries.find((e) => e.name === "library")!.directory!;
}

/** Row operations, derived by the host on the head. */
async function change(operations: (collection: { material: { kind: "basis"; path: string; object: string } }) => SourceOperation[]) {
  const head = (await client.descriptor(tree)).tree;
  const update: DerivableCandidateUpdate = { at: TEST_TIME, change: crypto.randomUUID(), candidate: null, resolves: [], deltas: [], objects: [],
    trace: [{ operations: operations({ material: { kind: "basis", path: "/library", object: await library(head.root) } }) }] };
  return (await client.submitUpdates(tree, { base: head.update, updates: [update] })).results[0]!;
}
async function refused(operations: Parameters<typeof change>[0]): Promise<string> {
  try { await change(operations); return "accepted"; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}
const set = (model: string, row: string, field: string, before: unknown, value: unknown) => (collection: never) =>
  [{ key: "set", kind: "set", collection, model, row: key(row), field, before, value, at: now() } as SourceOperation];
const create = (model: string, row: string, values: Record<string, unknown>) => (collection: never) =>
  [{ key: "create", kind: "rowCreate", collection, model, row: key(row), values: { id: row, ...values }, at: now() } as SourceOperation];
const remove = (model: string, row: string) => (collection: never) =>
  [{ key: `delete-${model}-${row}`, kind: "rowDelete", collection, model, row: key(row) } as SourceOperation];

beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/story-collection-db-`); await start();
  tree = (await client.account()).account.community.id;
  const descriptor = await client.descriptor(tree), initial = await client.snapshot(tree, descriptor.tree.root);
  objects = new Map(initial.objects);
  const folder = collectionDirectory(SCHEMA, {
    Author: [idRow("le-guin", { name: "Ursula K. Le Guin" }), idRow("calvino", { name: "Italo Calvino" })],
    Book: [idRow("dispossessed", { title: "The Dispossessed", author: "le-guin" }), idRow("cities", { title: "Invisible Cities", author: "calvino" })],
  }, objects);
  const value = decodeProtocolDirectory(objects.get(initial.root)!) as ProtocolDirectory;
  value.entries.push({ name: "library", directory: folder });
  value.entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeProtocolDirectory(value);
  objects.set(hashObject(bytes), bytes);
  await client.submitUpdates(tree, { base: descriptor.tree.update, updates: [{ at: TEST_TIME, change: crypto.randomUUID(),
    candidate: hashObject(bytes), trace: null, resolves: [], deltas: [], objects: [...objects].map(([hash, b]) => ({ hash, bytes: b })) }] });
  await running.overstoryd.collections.at(tree, "/library", (await client.descriptor(tree)).tree.root as never);
});
afterEach(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });

/** The database's rows equal the rows the log holds, as a database built from them. */
async function expectDatabaseHoldsLog() {
  const head = (await client.descriptor(tree)).tree;
  const folder = decodeProtocolDirectory(objects.get(await library(head.root))!);
  const collection = (await loadDirectoryCollection(folder, async (hash) => objects.get(hash)!))!;
  const schema = new StoreSchema(collection.schema.result);
  const found = (await running.overstoryd.collections.at(tree, "/library", head.root as never))!;
  expect(found.database.head).toBe(folder.collection!.log);
  expect(found.database.rows).toBe(collection.state.rows);
  expect(found.database.lthash.hash()).toBe(collection.state.lthash.hash());
  const fresh = CollectionDatabase.withRows(join(dir, "fresh"), schema.layout, rowsFromLogical(schema.result, schema.layout, collection.tables), "s");
  const dump = (db: Database) => Object.fromEntries(schema.layout.map((t) => [t.name, db.query(`select * from "${t.name}" order by ${t.primaryKey.map((k) => `"${k}"`).join(", ")}`).all()]));
  try {
    expect(dump(found.database.database)).toEqual(dump(fresh.database));
  } finally {
    fresh.close();
  }
}

test("row changes are replayed and checked on the collection's database, which follows each accepted entry", async () => {
  const counts = running.overstoryd.collections.counts;
  const before = { ...counts };
  expect((await change(set("Author", "calvino", "name", "Italo Calvino", "I. Calvino") as never)).outcome).toBe("accepted");
  expect((await change(create("Book", "lathe", { title: "The Lathe of Heaven", author: "le-guin" }) as never)).outcome).toBe("accepted");
  expect((await change(remove("Book", "cities") as never)).outcome).toBe("accepted");
  expect(counts.replayed - before.replayed).toBeGreaterThanOrEqual(3);
  expect(counts.replayedFromLog - before.replayedFromLog).toBe(0);
  expect(counts.checkedWhole - before.checkedWhole).toBe(0);
  await expectDatabaseHoldsLog();
});

test("changes the rest of the collection refuses are refused, read from the database", async () => {
  const counts = running.overstoryd.collections.counts;
  const before = { ...counts };
  // A book by an author who isn't there.
  expect(await refused(create("Book", "nowhere", { title: "Nowhere", author: "borges" }) as never)).toMatch(/unknown-row/);
  // An author whose books still name them.
  expect(await refused(remove("Author", "le-guin") as never)).toMatch(/unknown-row/);
  // A name another author has.
  expect(await refused(set("Author", "calvino", "name", "Italo Calvino", "Ursula K. Le Guin") as never)).toMatch(/duplicate-value/);
  // A main row named like another.
  expect(await refused(create("Author", "le-guin-2", { name: "Ursula K. Le Guin" }) as never)).toMatch(/duplicate-value/);
  expect(counts.replayedFromLog - before.replayedFromLog).toBe(0);
  // Removing the author with their books together is fine.
  expect((await change((c) => [...remove("Book", "dispossessed")(c as never), ...remove("Author", "le-guin")(c as never)])).outcome).toBe("accepted");
  await expectDatabaseHoldsLog();
});

test("a path read of a row at the head is answered from the database, by the row's name", async () => {
  const counts = running.overstoryd.collections.counts;
  expect((await change(set("Book", "cities", "title", "Invisible Cities", "Le città invisibili") as never)).outcome).toBe("accepted");
  const head = (await client.descriptor(tree)).tree;
  const answer = await client.pathReadAnswer(tree, head.root, "/library/Book/cities");
  expect(answer.rows).toEqual([{ model: "Book", row: expect.objectContaining({ key: [["id", "cities"]], fields: { title: "Le città invisibili", author: "calvino" } }) }]);
  expect((await client.pathReadAnswer(tree, head.root, "/library/calvino")).rows?.map((r) => r.model)).toEqual(["Author"]);
  expect((await client.pathReadAnswer(tree, head.root, "/library/borges")).rows).toEqual([]);
  expect(counts.replayedFromLog).toBe(0);
});

test("a restarted host opens the database where it was, and replays nothing", async () => {
  expect((await change(set("Author", "calvino", "name", "Italo Calvino", "I. Calvino") as never)).outcome).toBe("accepted");
  await stop();
  await start();
  const counts = running.overstoryd.collections.counts;
  expect((await change(set("Book", "cities", "title", "Invisible Cities", "Le città invisibili") as never)).outcome).toBe("accepted");
  expect(counts.replayed).toBeGreaterThan(0);
  expect(counts.replayedFromLog).toBe(0);
  expect(counts.checkedWhole).toBe(0);
  await expectDatabaseHoldsLog();
});

