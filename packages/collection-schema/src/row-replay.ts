// Row operations replayed on a collection's logical tables (spec 10 §4.1).

import {
  compareUTF8,
  decodeProtocolDirectory,
  encodedRow,
  encodeProtocolDirectory,
  hashObject,
  logicalRowKey,
  ROW_TIME,
  stableJSONString,
  type CollectionRowReplay,
  type JSONValue,
  type LogicalRow,
  type ObjectHash,
  type RowOperation,
} from "@ovst/protocol";
import type { LogicalField, LogicalModel, LogicalTables } from "@ovst/beetle/tables";
import { directoryCollectionSchema, ProtocolCollectionError } from "./directory-collection.ts";
import { plainRows, treeTables, type ChangedRow, type LogicalSchema } from "./logical.ts";
import { appendRowChanges, loadCollectionState, type CollectionState } from "./collection-log.ts";
import { checkStateChanges, markChecked, requireChecked } from "./changed-rows.ts";

function invalid(message: string): never {
  throw new Error(`Invalid row operation: ${message}`);
}

const json = (value: unknown) => stableJSONString(value ?? null);
const same = (left: unknown, right: unknown) => json(left) === json(right);
/** A row time in the logical form's precision: RFC 3339 UTC with milliseconds. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A set's members sorted by canonical JSON, each once. */
export function canonicalSet(values: readonly JSONValue[]): JSONValue[] {
  const byText = new Map(values.map((v) => [JSON.stringify(v), v]));
  return [...byText.keys()].sort(compareUTF8).map((k) => byText.get(k)!);
}

/** A many-valued field's value in canonical form: a set sorted, absent when empty. */
export function canonicalMany(field: Pick<LogicalField, "ordered">, values: readonly JSONValue[]): JSONValue[] | undefined {
  if (!values.length) return undefined;
  return field.ordered ? [...values] : canonicalSet(values);
}

type Rows = Map<string, LogicalRow | null>;

function fieldOf(model: LogicalModel, name: string): LogicalField {
  if (model.key.includes(name)) invalid("a key field is never set");
  if (name === "created" || name === "modified") invalid(`${name} is set only by an operation's time`);
  const field = model.fields.find((f) => f.name === name);
  if (!field) invalid(`${model.name} holds no field ${name}`);
  return field;
}

function setField(row: LogicalRow, field: LogicalField, value: JSONValue | undefined) {
  const next = value === undefined || value === null ? undefined
    : field.arity === "many" && Array.isArray(value) ? canonicalMany(field, value) : value;
  if (next === undefined) delete row.fields[field.name];
  else row.fields[field.name] = next;
}

/** Apply one operation to a model's rows by stable key, stamping its time. */
function applyRowOperation(model: LogicalModel, rows: Rows, operation: RowOperation, updateAt: number) {
  const current = rows.get(operation.row);
  if (operation.kind === "rowDelete") {
    if (!current) invalid("row is absent");
    rows.set(operation.row, null);
    return;
  }
  // An operation's own `at`, or its update's (updates and merging §2.5).
  let at = updateAt;
  if (operation.at !== undefined) {
    if (!ROW_TIME.test(operation.at) || !TIME.test(operation.at)) invalid("at is an RFC 3339 UTC time with milliseconds");
    at = Date.parse(operation.at);
    if (at > updateAt) invalid("an operation's at is later than its update's");
  }
  if (operation.kind === "rowCreate") {
    if (current) invalid("row already exists");
    const key: LogicalRow["key"] = model.keyFields.map((f) => {
      const value = operation.values[f.name];
      if (value === undefined || value === null) invalid(`values have no key field ${f.name}`);
      return [f.name, value];
    });
    if (logicalRowKey({ key }) !== operation.row) invalid("values do not have the row's key");
    const row: LogicalRow = { key, fields: {}, created: at, modified: at };
    for (const [name, value] of Object.entries(operation.values)) {
      if (model.key.includes(name)) continue;
      setField(row, fieldOf(model, name), value);
    }
    rows.set(operation.row, row);
    return;
  }
  if (!current) invalid("row is absent");
  const field = fieldOf(model, operation.field);
  const row: LogicalRow = { ...current, fields: { ...current.fields }, modified: at };
  if (operation.kind === "set") {
    if (!same(row.fields[field.name], operation.before)) invalid(`${field.name} does not have the value seen`);
    if (same(operation.before, operation.value)) invalid("set changes nothing");
    setField(row, field, operation.value);
  } else {
    if (field.arity !== "many") invalid(`${field.name} is not many-valued`);
    const list = (row.fields[field.name] ?? []) as JSONValue[];
    const index = list.findIndex((item) => same(item, operation.member));
    if (operation.kind === "connect") {
      if (index >= 0) invalid("member is already present");
      setField(row, field, [...list, operation.member]);
    } else {
      if (index < 0) invalid("member is absent");
      const rest = list.filter((_, i) => i !== index);
      if (operation.kind === "disconnect") setField(row, field, rest);
      else if (operation.kind === "move") {
        if (!field.ordered) invalid(`${field.name} is a set, so its members don't move`);
        const anchor = operation.after;
        const after = anchor === null ? -1 : rest.findIndex((item) => same(item, anchor));
        if (anchor !== null && after < 0) invalid("anchor member is absent");
        rest.splice(after + 1, 0, list[index]!);
        if (rest.every((item, i) => same(item, list[i]))) invalid("move changes nothing");
        setField(row, field, rest);
      }
    }
  }
  rows.set(operation.row, row);
}

/**
 * A collection's tables after operations, in order. Each operation names a
 * model and a row by stable key, and its `at` stamps the row's times.
 * Exposed for merge, which applies one side's operations to another side's
 * rows. Throws for an operation its rows can't take.
 */
export function applyRowOperations(schema: LogicalSchema, tables: LogicalTables, operations: readonly RowOperation[], at: number): LogicalTables {
  const byModel = new Map<string, Rows>();
  for (const operation of operations) {
    const model = schema.models.find((m) => m.name === operation.model);
    if (!model) invalid(`${operation.model} is not a model of this collection`);
    let rows = byModel.get(model.name);
    if (!rows) byModel.set(model.name, rows = new Map((tables[model.name] ?? []).map((row) => [logicalRowKey(row), row as LogicalRow])));
    applyRowOperation(model, rows, operation, at);
  }
  const result: LogicalTables = { ...tables };
  for (const [model, rows] of byModel) {
    result[model] = [...rows.values()].filter((row): row is LogicalRow => row !== null).sort((a, b) => compareUTF8(logicalRowKey(a), logicalRowKey(b)));
  }
  return result;
}

/** The collection schema package's row replay (spec 10 §4.1): apply the
 * operations to just the rows they name, check those rows against the rest of
 * the collection, and append the change to the directory's log. The rest of
 * the collection is neither validated again nor re-encoded (Performance 007). */
export const replayCollectionRows: CollectionRowReplay = async (directoryHash, operations, read, at) => {
  const directory = decodeProtocolDirectory(await read(directoryHash));
  if (!directory.collection) invalid("the directory has no collection");
  let schema: LogicalSchema, state: CollectionState;
  const entries = directory.entries.map((entry) => entry.name);
  try {
    schema = await directoryCollectionSchema(directory, read);
    if (directory.collection.modelFingerprint !== schema.fingerprint) throw new ProtocolCollectionError("source", "collection.modelFingerprint doesn't match the folder's schema.beetle");
    try {
      state = await loadCollectionState(schema, directory.collection.log, read);
    } catch (error) {
      if (error instanceof TypeError) throw new ProtocolCollectionError("source", error.message);
      throw error;
    }
    requireChecked(schema, state, entries);
  } catch (error) {
    if (error instanceof ProtocolCollectionError) invalid(error.message);
    throw error;
  }
  // The rows the operations name, as they are now.
  const keys = new Map<string, Set<string>>();
  for (const operation of operations) {
    if (!keys.has(operation.model)) keys.set(operation.model, new Set());
    keys.get(operation.model)!.add(operation.row);
  }
  const current: LogicalTables = {};
  for (const [model, rows] of keys) {
    const held = [...rows].map((key) => state.tables.get(model)?.get(key)).filter((row): row is LogicalRow => row !== undefined);
    current[model] = plainRows(schema, model, held);
  }
  const applied = applyRowOperations(schema, current, operations, at);
  const touched: ChangedRow[] = [];
  for (const [model, rows] of keys) {
    const after = new Map((applied[model] ?? []).map((row) => [logicalRowKey(row as LogicalRow), row as LogicalRow]));
    for (const key of [...rows].sort(compareUTF8)) {
      const was = state.tables.get(model)?.get(key), is = after.get(key);
      if (!was && !is) continue;
      touched.push({ model, key: (is ?? plainRows(schema, model, [was!])[0]! as LogicalRow).key, row: is ?? null });
    }
  }
  let reference = directory.collection;
  const generated = new Map<ObjectHash, Uint8Array>();
  let changes: ChangedRow[];
  try {
    // The rows are checked first, so a value the log can't hold is refused as the schema refuses it.
    checkStateChanges(schema, state, null, touched);
    changes = touched.filter((change) => {
      const was = state.tables.get(change.model)?.get(logicalRowKey(change));
      return !was || !change.row || encodedRow(was).hash !== encodedRow(treeRow(schema, change.model, change.row)).hash;
    });
  } catch (error) {
    if (error instanceof ProtocolCollectionError) invalid(error.message);
    throw error;
  }
  if (changes.length > 0 || !state.head) {
    let appended;
    try {
      appended = appendRowChanges(schema, state, changes.map((change) => ({
        model: change.model,
        key: treeRow(schema, change.model, { key: change.key, fields: {}, created: 0, modified: 0 }).key,
        row: change.row ? treeRow(schema, change.model, change.row) : null,
      })));
    } catch (error) {
      if (error instanceof ProtocolCollectionError) invalid(error.message);
      if (error instanceof TypeError) invalid(error.message);
      throw error;
    }
    markChecked(appended.state);
    generated.set(appended.hash as ObjectHash, appended.bytes);
    reference = { ...reference, log: appended.hash };
  }
  const bytes = encodeProtocolDirectory({ ...directory, collection: reference });
  const hash = hashObject(bytes);
  generated.set(hash, bytes);
  return { directory: hash, generated };
};

/** A plain row as the log holds it (Date fields tagged). */
function treeRow(schema: LogicalSchema, model: string, row: LogicalRow): LogicalRow {
  return treeTables(schema, { [model]: [row] } as LogicalTables)[model]![0]!;
}
