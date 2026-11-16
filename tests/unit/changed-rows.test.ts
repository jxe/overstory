// Performance 007: row replay checks and appends only the rows its operations change. Its
// log entry must be the one encoding the whole collection afresh gives, and it must refuse
// what validating the whole collection refuses.

import { expect, test } from "bun:test";
import { applyRowOperations, compileLogicalSchema, encodeCollection, loadDirectoryCollection, replayCollectionRows } from "@ovst/collection-schema";
import { decodeProtocolDirectory, type ObjectHash, type RowOperation } from "@ovst/protocol";
import { collectionDirectory, idRow } from "../support/collection-trees.ts";

const SCHEMA = [
  "main table Author:",
  "  name unique Text",
  "  born Date?",
  "",
  "table Book:",
  "  title  Text",
  "  author Author",
  "",
  "Book.author <-> Author.books[]",
  "",
].join("\n");
const AT = Date.parse("2026-11-16T12:00:00.000Z");
const key = (id: string) => JSON.stringify([["id", id]]);
const material = { material: { kind: "basis" as const, path: "/library", object: "sha256:0" } };

function library() {
  const objects = new Map<ObjectHash, Uint8Array>();
  const directory = collectionDirectory(SCHEMA, {
    Author: [idRow("le-guin", { name: "Ursula K. Le Guin", born: "1929-10-21" }), idRow("calvino", { name: "Italo Calvino" })],
    Book: [idRow("dispossessed", { title: "The Dispossessed", author: "le-guin" }), idRow("cities", { title: "Invisible Cities", author: "calvino" })],
  }, objects);
  const read = async (hash: ObjectHash) => objects.get(hash)!;
  return { objects, directory, read };
}

const op = (fields: Record<string, unknown>) => ({ key: "op", ...material, ...fields }) as unknown as RowOperation;

test("a replayed change appends the entry encoding the whole collection afresh would", async () => {
  const { objects, directory, read } = library();
  const operations = [
    op({ key: "a", kind: "set", model: "Author", row: key("calvino"), field: "name", before: "Italo Calvino", value: "I. Calvino" }),
    op({ key: "b", kind: "rowCreate", model: "Book", row: key("lathe"), values: { id: "lathe", title: "The Lathe of Heaven", author: "le-guin" } }),
    op({ key: "c", kind: "rowDelete", model: "Book", row: key("cities") }),
    op({ key: "d", kind: "set", model: "Author", row: key("le-guin"), field: "born", before: "1929-10-21", value: "1929-10-22" }),
  ];
  const replayed = await replayCollectionRows(directory, operations, read, AT);
  for (const [hash, bytes] of replayed.generated) objects.set(hash, bytes);
  // The same change, as the whole collection: its rows with the operations applied, encoded on the old log.
  const before = (await loadDirectoryCollection(decodeProtocolDirectory(objects.get(directory)!), read))!;
  const tables = applyRowOperations(before.schema, before.tables, operations, AT);
  const expected = encodeCollection(compileLogicalSchema(SCHEMA), tables, before.state);
  expect(decodeProtocolDirectory(objects.get(replayed.directory)!).collection).toEqual(expected.reference);
  const after = (await loadDirectoryCollection(decodeProtocolDirectory(objects.get(replayed.directory)!), read))!;
  expect(after.tables).toEqual(tables);
});

test("replay refuses what validating the whole collection refuses", async () => {
  const { directory, read } = library();
  const refused = (operations: RowOperation[]) => replayCollectionRows(directory, operations, read, AT).then(() => "accepted", (error: Error) => error.message);
  expect(await refused([op({ kind: "rowCreate", model: "Book", row: key("nowhere"), values: { id: "nowhere", title: "Nowhere", author: "borges" } })])).toMatch(/unknown-row/);
  expect(await refused([op({ kind: "rowDelete", model: "Author", row: key("le-guin") })])).toMatch(/unknown-row/);
  expect(await refused([op({ kind: "set", model: "Author", row: key("calvino"), field: "name", before: "Italo Calvino", value: "Ursula K. Le Guin" })])).toMatch(/duplicate-value/);
  expect(await refused([op({ kind: "set", model: "Author", row: key("calvino"), field: "born", before: null, value: "not a date" })])).toMatch(/type-mismatch/);
  // Removing a book and its author together is fine.
  expect(await refused([
    op({ key: "a", kind: "rowDelete", model: "Book", row: key("dispossessed") }),
    op({ key: "b", kind: "rowDelete", model: "Author", row: key("le-guin") }),
  ])).toBe("accepted");
});
