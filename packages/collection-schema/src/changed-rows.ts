// Checking a collection's changed rows against the rest of it held in memory (Performance
// 007): the same checks a host makes against its database. A change to a few rows of a
// large collection is checked by those rows, not by validating, naming and re-encoding
// every row.

import { CBORTag, logicalRowKey, type LogicalRow } from "@ovst/protocol";
import type { CollectionState } from "./collection-log.ts";
import { checkChangedRowNames, checkCollectionNames, collectionRowName, ProtocolCollectionError } from "./directory-collection.ts";
import { checkChangedRows, checkLogicalTables, LogicalCollectionError, plainTables, type ChangedRow, type ChangedRowLookup, type LogicalSchema } from "./logical.ts";

/** A value as plain JSON: a tagged Date as its text. */
function plain(value: unknown): unknown {
  if (value instanceof CBORTag) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  return value;
}
const text = (value: unknown) => JSON.stringify(plain(value));

/** States whose every row was checked, directly or by checking each change that made them. */
const checked = new WeakSet<CollectionState>();

/** Record that `state`'s rows have been checked. */
export function markChecked(state: CollectionState): void {
  checked.add(state);
}

/**
 * Require `state`'s rows to satisfy the schema and name distinct children beside
 * `entries`: once per state, since a state made by checked changes on a checked one is
 * checked. Throws {@link ProtocolCollectionError}.
 */
export function requireChecked(schema: LogicalSchema, state: CollectionState, entries: Iterable<string>): void {
  if (checked.has(state)) return;
  const tables = plainTables(schema, state);
  const diagnostics = checkLogicalTables(schema, tables);
  if (diagnostics.length > 0) throw new ProtocolCollectionError("constraint", new LogicalCollectionError(diagnostics).message);
  checkCollectionNames(entries, schema, tables);
  checked.add(state);
}

/**
 * What a check of changed rows asks, answered from `state` with `changes` (plain rows, a
 * null row removed) in place of the rows they name.
 */
export function stateLookup(schema: LogicalSchema, state: CollectionState, changes: readonly ChangedRow[]): ChangedRowLookup & { named(model: string, name: string): string[] } {
  const overlay = new Map<string, LogicalRow | null>();
  for (const change of changes) overlay.set(`${change.model}\0${logicalRowKey(change)}`, change.row);
  const model = (name: string) => schema.models.find((m) => m.name === name);
  /** Each row of `name` as of the changes, with its stable key. */
  function* rows(name: string): Generator<[string, LogicalRow]> {
    for (const [key, row] of state.tables.get(name) ?? []) if (!overlay.has(`${name}\0${key}`)) yield [key, row];
    for (const [at, row] of overlay) {
      const [rowModel, key] = at.split("\0") as [string, string];
      if (rowModel === name && row) yield [key, row];
    }
  }
  const exists = (name: string, stableKey: string) => {
    const changed = overlay.get(`${name}\0${stableKey}`);
    return changed !== undefined ? changed !== null : state.tables.get(name)?.has(stableKey) ?? false;
  };
  return {
    hasKey: (name, reference) => {
      const target = model(name);
      if (!target) return false;
      const value = JSON.parse(reference) as unknown;
      const key = target.keyFields.length === 1 ? [[target.keyFields[0]!.name, value]] : value;
      return Array.isArray(key) && exists(name, logicalRowKey({ key: key as LogicalRow["key"] }));
    },
    holding: (name, field, value) => {
      const wanted = text(value), out: string[] = [];
      for (const [key, row] of rows(name)) if (field in row.fields && text(row.fields[field]) === wanted) out.push(key);
      return out;
    },
    referrers: (name, stableKey) => {
      const target = model(name);
      if (!target) return [];
      const key = JSON.parse(stableKey) as LogicalRow["key"];
      const reference = text(target.keyFields.length === 1 ? key[0]![1] : key);
      const out: Array<{ model: string; row: string }> = [];
      for (const referring of schema.models) {
        const fields = referring.fields.filter((f) => f.type === name && f.kind !== "value");
        const keyFields = referring.keyFields.filter((f) => f.type === name && f.kind === "reference");
        if (!fields.length && !keyFields.length) continue;
        for (const [rowKey, row] of rows(referring.name)) {
          const refers = fields.some((f) => {
            const held = row.fields[f.name];
            return Array.isArray(held) && f.arity === "many" ? held.some((member) => text(member) === reference) : held !== undefined && text(held) === reference;
          }) || keyFields.some((f) => text(row.key.find(([field]) => field === f.name)?.[1]) === reference);
          if (refers && !overlay.has(`${referring.name}\0${rowKey}`)) out.push({ model: referring.name, row: rowKey });
        }
      }
      return out;
    },
    named: (name, childName) => {
      const target = model(name);
      if (!target) return [];
      const named = (row: LogicalRow) => {
        try { return collectionRowName(target, { key: row.key.map(([k, v]) => [k, plain(v)]) as LogicalRow["key"], fields: Object.fromEntries(Object.entries(row.fields).map(([k, v]) => [k, plain(v)])) as LogicalRow["fields"] }) === childName; } catch { return false; }
      };
      if (target.path && !target.key.includes(target.path)) {
        const out: string[] = [];
        for (const [key, row] of rows(name)) if (named(row)) out.push(key);
        return out;
      }
      // Named by its key: the row with that key, if it is named so.
      const keys: string[] = [];
      if (childName.startsWith("~row-")) {
        try {
          keys.push(new TextDecoder().decode(Uint8Array.from(atob(childName.slice(5).replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))));
        } catch { /* not a key's name */ }
      } else if (target.keyFields.length === 1) {
        keys.push(logicalRowKey({ key: [[target.keyFields[0]!.name, childName]] as LogicalRow["key"] }));
      }
      return keys.filter((key) => {
        const changed = overlay.get(`${name}\0${key}`);
        const row = changed !== undefined ? changed : state.tables.get(name)?.get(key);
        return row ? named(row) : false;
      });
    },
  };
}

/**
 * Require `changes` (plain rows) to leave the collection at `state` valid: each changed row
 * against the schema and the rest of the collection, and row names beside `entries` (the
 * folder's entry names, or null when they didn't change). Throws
 * {@link ProtocolCollectionError}.
 */
export function checkStateChanges(schema: LogicalSchema, state: CollectionState, entries: Iterable<string> | null, changes: readonly ChangedRow[]): void {
  const lookup = stateLookup(schema, state, changes);
  const diagnostics = checkChangedRows(schema, changes, lookup);
  if (diagnostics.length > 0) throw new ProtocolCollectionError("constraint", new LogicalCollectionError(diagnostics).message);
  checkChangedRowNames(entries, schema, changes.flatMap((c) => (c.row ? [{ model: c.model, row: c.row }] : [])), lookup.named);
}
