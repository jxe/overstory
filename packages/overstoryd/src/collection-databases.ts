// The host's database of each collection (Performance 007): its rows in the schema's
// database layout, at `<dataRoot>/collections/<tree>/<path>/_store.sqlite3`. It is the
// collection's log applied, and records the entry it is at, its row count and its rows hash
// state. Every accepted update that moves a collection's log applies the new entries to its
// database as it is accepted; views, mutations, path reads and snapshots read it there.
//
// The log is what the tree holds, so a database is rebuilt from it when it is missing,
// unreadable, from another schema, or doesn't follow: from the newest snapshot entry's file
// (checked against its rows hash once), then the entries after it. Nothing replays a whole
// log into memory.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, logicalRowsByKey, StoreSchema } from "@ovst/beetle";
import { readDatabaseRows, SQLiteStore } from "@ovst/beetle/sqlite";
import {
  decodeProtocolDirectory,
  decodeProtocolLog,
  encodedRow,
  encodeProtocolDirectory,
  hashObject,
  LtHash,
  logicalRowKey,
  rowHashElement,
  type Hash,
  type LogicalRow,
  type ObjectHash,
  type ProtocolDirectory,
  type ProtocolLog,
  type RowChange,
  type RowOperation,
} from "@ovst/protocol";
import {
  applyRowOperations,
  checkChangedRowNames,
  checkChangedRows,
  collectionRowName,
  directoryCollectionSchema,
  encodedLogEntry,
  LogicalCollectionError,
  nameCollectionRows,
  plainRows,
  ProtocolCollectionError,
  treeTables,
  type ChangedRow,
  type ChangedRowLookup,
  type CollectionRowNode,
  type CollectionSchemaCache,
  type LogicalSchema,
} from "@ovst/collection-schema";
import { logicalFromRows, rowsFromLogical, setupSql, type LogicalTables, type RowsByTable, type Table } from "@ovst/beetle/tables";
import { changedCollectionFolders } from "./collection-snapshots.ts";

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

/** A collection's changed logical rows by model: each one before (absent if new) and after (absent if deleted). */
export type LogicalChanges = Record<string, { before: LogicalTables[string]; after: LogicalTables[string] }>;

const FILE = "_store.sqlite3";
/** The database's own record, which no view reads and no snapshot carries. */
const META = "__overstory_collection";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A row value as SQLite stores it: flags as 0/1, value arrays as JSON text. */
function stored(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/** An empty value array is absent from a row, and stored as `[]`. */
const emptyOf = (column: Table["columns"][number]): unknown => (column.array && !column.nullable ? [] : null);

/** Where a database is: the log entry it is at, its rows, and the collection directory it was last recorded at. */
export interface CollectionPosition {
  /** The log entry the rows are; null before a log's first entry. */
  head: ObjectHash | null;
  rows: number;
  lthash: LtHash;
  /** The collection directory's hash the rows were last recorded at. */
  directory: string;
}

/** One collection's database. */
export class CollectionDatabase implements CollectionPosition {
  head: ObjectHash | null = null;
  rows = 0;
  lthash = new LtHash();
  directory = "";

  private constructor(
    readonly database: Database,
    /** The hash of the schema.beetle the layout is from. */
    readonly schema: string,
  ) {}

  /** The database left in `folder`, when it opens and says where it is. */
  static reopen(folder: string): CollectionDatabase | null {
    let database: Database | undefined;
    try {
      database = new Database(join(folder, FILE), { create: false, strict: true });
      const meta = Object.fromEntries((database.query(`select key, value from ${META}`).all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
      if (!meta.schema || meta.rows === undefined || !meta.lthash || meta.head === undefined) throw new Error("no record");
      configure(database);
      const db = new CollectionDatabase(database, meta.schema);
      db.head = (meta.head || null) as ObjectHash | null;
      db.rows = Number(meta.rows);
      db.lthash = LtHash.fromBytes(Buffer.from(meta.lthash, "hex"));
      db.directory = meta.directory ?? "";
      return db;
    } catch {
      database?.close();
      return null;
    }
  }

  /** An empty database in `layout`, in `folder`, replacing whatever was there. */
  static create(folder: string, layout: readonly Table[], schema: string): CollectionDatabase {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const database = new Database(join(folder, FILE), { create: true, strict: true });
    configure(database);
    database.exec(setupSql([...layout], "sqlite"));
    return CollectionDatabase.adopt(database, schema);
  }

  /** A database of `rows` (in `layout`), in `folder`, replacing whatever was there: what applying a log to it would make. */
  static withRows(folder: string, layout: readonly Table[], rows: RowsByTable, schema: string): CollectionDatabase {
    const db = CollectionDatabase.create(folder, layout, schema);
    db.database.transaction(() => {
      for (const table of layout) {
        const insert = db.insert(table);
        for (const row of rows[table.name] ?? []) insert(row);
      }
    })();
    return db;
  }

  /** A snapshot entry's file as the database, in `folder`, replacing whatever was there. */
  static fromFile(folder: string, bytes: Uint8Array, schema: string): CollectionDatabase {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, FILE), bytes);
    const database = new Database(join(folder, FILE), { create: false, strict: true });
    configure(database);
    return CollectionDatabase.adopt(database, schema);
  }

  private static adopt(database: Database, schema: string): CollectionDatabase {
    database.exec(`create table if not exists ${META} (key text primary key, value text not null)`);
    const db = new CollectionDatabase(database, schema);
    db.record({ head: null, rows: 0, lthash: new LtHash(), directory: "" });
    return db;
  }

  /** Record where the rows are, in the same transaction as the writes that put them there. */
  record(position: CollectionPosition, db = this.database): void {
    const set = db.prepare(`insert into ${META} (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`);
    set.run("schema", this.schema);
    set.run("head", position.head ?? "");
    set.run("rows", String(position.rows));
    set.run("lthash", hex(position.lthash.bytes()));
    set.run("directory", position.directory);
    this.head = position.head;
    this.rows = position.rows;
    this.lthash = position.lthash;
    this.directory = position.directory;
  }

  /** The rows of `keys` as the database holds them, plain (dates as text), each read from its neighborhood alone. */
  rowsByKey(schema: StoreSchema, keys: Readonly<Record<string, ReadonlyArray<LogicalRow["key"]>>>, db = this.database): LogicalTables {
    return logicalRowsByKey(new SQLiteStore(schema, db), keys as never);
  }

  /** Every row, plain. Only a database started from a snapshot reads them all, once, to check its rows hash. */
  allRows(schema: StoreSchema): LogicalTables {
    return logicalFromRows(schema.result, schema.layout, readDatabaseRows(schema.layout, this.database), { now: 0 });
  }

  /** A snapshot's file: this database's rows, without its own record (`VACUUM INTO`). */
  snapshotFile(folder: string): Uint8Array {
    const path = join(folder, `snapshot-${process.pid}-${Date.now()}.sqlite3`);
    rmSync(path, { force: true });
    try {
      this.database.prepare("vacuum into ?").run(path);
      const copy = new Database(path, { create: false, strict: true });
      try {
        copy.exec(`drop table if exists ${META}`);
        copy.exec("pragma journal_mode = delete");
      } finally {
        copy.close();
      }
      return new Uint8Array(readFileSync(path));
    } finally {
      rmSync(path, { force: true });
    }
  }

  private insert(table: Table, db = this.database): (row: Record<string, unknown>) => void {
    const columns = table.columns.map((c) => c.name);
    const statement = db.prepare(`insert into ${quote(table.name)} (${columns.map(quote).join(", ")}) values (${columns.map(() => "?").join(", ")})`);
    return (row) => statement.run(...table.columns.map((c) => stored(row[c.name] ?? emptyOf(c))) as never[]);
  }

  /** A second connection, for a mutation's writes, with SQLite's own foreign key checks off. */
  private writer: Database | null = null;

  /**
   * Open a write transaction on the database's second connection: what `SQLiteWriteStore`
   * writes a mutation into. Views keep reading the rows as they were until it commits.
   */
  beginWrite(): Database {
    if (!this.writer) {
      this.writer = new Database(this.database.filename, { create: false, strict: true });
      this.writer.exec("pragma busy_timeout = 5000");
      this.writer.exec("pragma synchronous = normal");
      this.writer.exec("pragma foreign_keys = off");
    }
    if (!this.writer.inTransaction) this.writer.exec("begin immediate");
    return this.writer;
  }

  /**
   * Commit the open write transaction once its update is accepted: the changed rows are
   * written as the accepted log holds them (with their stamped times), and the database
   * records the accepted entry, so it is what applying that entry would make.
   */
  commitWrite(schema: StoreSchema, changes: LogicalChanges, position: CollectionPosition): void {
    const db = this.writer;
    if (!db?.inTransaction) throw new Error("No write is open");
    try {
      this.writeChanges(db, schema, changes);
      this.record(position, db);
      db.exec("commit");
    } catch (error) {
      this.rollbackWrite();
      throw error;
    }
  }

  /** Discard the open write transaction, if any. */
  rollbackWrite(): void {
    if (this.writer?.inTransaction) this.writer.exec("rollback");
  }

  /**
   * Write a collection's changed logical rows. Each changed row rewrites what it owns in the
   * database layout: its own row (whose position columns its holder writes), its join rows,
   * and the positions of the rows it holds in order. Every other row is the same before and after.
   */
  writeChanges(db: Database, schema: StoreSchema, changes: LogicalChanges): void {
    db.exec("pragma defer_foreign_keys = on");
    const own = (model: string, row: LogicalTables[string][number]) => rowsFromLogical(schema.result, schema.layout, { [model]: [row] } as LogicalTables);
    const where = (columns: readonly string[]) => columns.map((c) => `${quote(c)} is ?`).join(" and ");
    const values = (row: Record<string, unknown>, columns: readonly string[]) => columns.map((c) => stored(row[c])) as never[];
    const tableOf = (model: string) => {
      const name = schema.tableOf(model);
      const table = name ? schema.byName.get(name) : undefined;
      if (!table) throw new Error(`${model} has no table`);
      return table;
    };
    const keyOf = (row: LogicalTables[string][number]) => JSON.stringify(row.key);
    // Deleted rows first.
    for (const [model, { before, after }] of Object.entries(changes)) {
      const table = tableOf(model);
      const kept = new Set(after.map(keyOf));
      const remove = db.prepare(`delete from ${quote(table.name)} where ${where(table.primaryKey)}`);
      for (const row of before) {
        if (kept.has(keyOf(row))) continue;
        // What refers to it goes with it, as the layout's foreign keys say.
        remove.run(...values(own(model, row)[table.name]![0]!, table.primaryKey));
      }
    }
    // Then each row as it is now, its join rows, and the order of the rows it holds.
    const positions: Array<() => void> = [];
    for (const [model, { before, after }] of Object.entries(changes)) {
      const table = tableOf(model);
      const prior = new Map(before.map((row) => [keyOf(row), row]));
      const held = new Set(table.columns.filter((c) => c.type === "position").map((c) => c.name));
      const columns = table.columns.map((c) => c.name);
      const settable = columns.filter((c) => !table.primaryKey.includes(c) && !held.has(c));
      const upsert = db.prepare(
        `insert into ${quote(table.name)} (${columns.map(quote).join(", ")}) values (${columns.map(() => "?").join(", ")})` +
        ` on conflict (${table.primaryKey.map(quote).join(", ")}) do ${settable.length ? `update set ${settable.map((c) => `${quote(c)} = excluded.${quote(c)}`).join(", ")}` : "nothing"}`,
      );
      for (const row of after) {
        const rows = own(model, row);
        const storedRow = rows[table.name]![0]!;
        upsert.run(...table.columns.map((c) => (held.has(c.name) && (storedRow[c.name] ?? null) === null ? 0 : stored(storedRow[c.name] ?? emptyOf(c)))) as never[]);
        for (const r of schema.relationships) {
          if (r.source !== table.name) continue;
          if (r.through) {
            if (!(r.name in row.fields) && !(r.name in (prior.get(keyOf(row))?.fields ?? {}))) continue;
            const join = schema.byName.get(r.through.relation)!;
            const sourceColumns = r.through.source.map((p) => p.through);
            const sourceValues = r.through.source.map((p) => storedRow[p.source] ?? null);
            // The holder's join rows as they are now. A join row that stays keeps its times: they
            // aren't logical (a new one takes its holder's), so they change only with the row.
            const wanted = (rows[join.name] ?? []).filter((j) => sourceColumns.every((c, i) => canonical(j[c] ?? null) === canonical(sourceValues[i])));
            const keep = new Set(wanted.map((j) => canonical(join.primaryKey.map((k) => stored(j[k] ?? null)))));
            const present = db.prepare(`select ${join.primaryKey.map(quote).join(", ")} from ${quote(join.name)} where ${where(sourceColumns)}`).all(...sourceValues.map(stored) as never[]) as Array<Record<string, unknown>>;
            const removeJoin = db.prepare(`delete from ${quote(join.name)} where ${where(join.primaryKey)}`);
            for (const p of present) if (!keep.has(canonical(join.primaryKey.map((k) => p[k] ?? null)))) removeJoin.run(...join.primaryKey.map((k) => p[k]) as never[]);
            const joinColumns = join.columns.map((c) => c.name);
            const joinSettable = joinColumns.filter((c) => !join.primaryKey.includes(c) && c !== "created" && c !== "modified");
            const upsertJoin = db.prepare(
              `insert into ${quote(join.name)} (${joinColumns.map(quote).join(", ")}) values (${joinColumns.map(() => "?").join(", ")})` +
              ` on conflict (${join.primaryKey.map(quote).join(", ")}) do ${joinSettable.length ? `update set ${joinSettable.map((c) => `${quote(c)} = excluded.${quote(c)}`).join(", ")}` : "nothing"}`,
            );
            for (const j of wanted) upsertJoin.run(...join.columns.map((c) => stored(j[c.name] ?? emptyOf(c))) as never[]);
          } else if (r.direct && r.cardinality === "many") {
            const position = schema.positionOf(r);
            const members = row.fields[r.name];
            if (position?.table !== "target" || !Array.isArray(members)) continue;
            const target = schema.byName.get(r.target)!;
            const update = db.prepare(`update ${quote(target.name)} set ${quote(position.column)} = ? where ${where(target.primaryKey)}`);
            const member = schema.modelOfTable(target.name);
            members.forEach((key, i) => {
              const keyRow = own(member, { key, fields: {}, created: 0, modified: 0 } as never)[target.name]![0]!;
              positions.push(() => update.run(i as never, ...values(keyRow, target.primaryKey)));
            });
          }
        }
      }
    }
    for (const set of positions) set();
  }

  close(): void {
    this.rollbackWrite();
    this.writer?.close();
    this.database.close();
  }
}

function configure(database: Database): void {
  database.exec("pragma journal_mode = wal");
  // The log is what the tree holds: a commit doesn't wait on the disk, and a database that
  // lost one is behind its log, which applying the entries after it repairs.
  database.exec("pragma synchronous = normal");
  database.exec("pragma foreign_keys = on");
  database.exec("pragma busy_timeout = 5000");
}

/** A collection's schema as the host reads it: logical, and as its database's store. */
export interface CollectionSchemas {
  logical: LogicalSchema;
  store: StoreSchema;
}

/**
 * The plain changes that `changes` (rows as the log holds them) make to `before` (plain rows
 * the database holds), and the position after them, checked as collections §1 says: a
 * removed row is present, and the row count and rows hash are the entry's when given.
 */
export function positionAfter(
  schemas: CollectionSchemas,
  at: CollectionPosition,
  before: LogicalTables,
  changes: readonly RowChange[],
): { changes: LogicalChanges; rows: number; lthash: LtHash } {
  const { logical } = schemas;
  const previous = new Map<string, LogicalRow>();
  for (const [model, rows] of Object.entries(treeTables(logical, before))) {
    for (const row of rows) previous.set(`${model}\0${logicalRowKey(row)}`, row);
  }
  const plainBefore = new Map<string, LogicalTables[string][number]>();
  for (const [model, rows] of Object.entries(before)) for (const row of rows) plainBefore.set(`${model}\0${logicalRowKey(row as LogicalRow)}`, row);
  const lthash = at.lthash.clone();
  let rows = at.rows;
  const out: LogicalChanges = {};
  for (const change of changes) {
    const plainKey = plainRows(logical, change.model, [{ key: change.key, fields: {}, created: 0, modified: 0 } as LogicalRow])[0]!.key;
    const id = `${change.model}\0${logicalRowKey({ key: plainKey as LogicalRow["key"] })}`;
    const old = previous.get(id);
    const entry = (out[change.model] ??= { before: [], after: [] });
    if (old) {
      lthash.remove(rowHashElement(change.model, old));
      rows--;
      entry.before.push(plainBefore.get(id)!);
    } else if (!change.row) {
      throw new TypeError(`${change.model} ${logicalRowKey(change)} is removed but isn't there`);
    }
    if (change.row) {
      lthash.add(rowHashElement(change.model, change.row));
      rows++;
      entry.after.push(...plainRows(logical, change.model, [change.row]));
    }
  }
  return { changes: out, rows, lthash };
}

/** The plain keys of `changes`, by model: what the database is asked for before they apply. */
export function changedKeys(logical: LogicalSchema, changes: readonly RowChange[]): Record<string, LogicalRow["key"][]> {
  const keys: Record<string, LogicalRow["key"][]> = {};
  for (const change of changes) {
    const [row] = plainRows(logical, change.model, [{ key: change.key, fields: {}, created: 0, modified: 0 } as LogicalRow]);
    (keys[change.model] ??= []).push(row!.key as LogicalRow["key"]);
  }
  return keys;
}

/** How many log entries the host built or checked and hasn't yet seen accepted are kept. */
const PENDING = 64;
/** How far back a candidate's new log entries are followed to an entry the host holds. */
const NEW_ENTRIES = 1_000;

/** A row as one of a tree's entries in the log: its form there, by model and stable key. */
const id = (model: string, stableKey: string) => `${model}\0${stableKey}`;

/**
 * A collection as of one log entry: its database, at that entry or one before it in the
 * same chain, and the rows the entries after that changed (plain, null when removed).
 * Valid only while the database is at an entry in `chain`.
 */
class CollectionView {
  constructor(
    readonly database: CollectionDatabase,
    readonly schemas: CollectionSchemas,
    readonly head: ObjectHash | null,
    readonly position: { rows: number; lthash: LtHash },
    readonly overlay: ReadonlyMap<string, LogicalRow | null>,
    readonly chain: ReadonlySet<ObjectHash | null>,
  ) {}

  get valid(): boolean {
    return this.chain.has(this.database.head);
  }

  private get logical(): LogicalSchema {
    return this.schemas.logical;
  }

  private model(name: string) {
    return this.logical.models.find((m) => m.name === name);
  }

  /** The rows of `keys` (plain) as of this view: changed ones from the overlay, the rest from the database. */
  rowsByKey(keys: Readonly<Record<string, ReadonlyArray<LogicalRow["key"]>>>): LogicalTables {
    const out: LogicalTables = {};
    const wanted: Record<string, LogicalRow["key"][]> = {};
    for (const [model, list] of Object.entries(keys)) {
      for (const key of list) {
        const changed = this.overlay.get(id(model, logicalRowKey({ key })));
        if (changed === undefined) (wanted[model] ??= []).push(key);
        else if (changed) (out[model] ??= []).push(changed as LogicalTables[string][number]);
      }
    }
    for (const [model, list] of Object.entries(this.database.rowsByKey(this.schemas.store, wanted))) (out[model] ??= []).push(...list);
    return out;
  }

  /** The stored primary key values of a row of `model` with `key`. */
  private storedKey(model: string, key: LogicalRow["key"]): { table: Table; values: unknown[] } | null {
    const name = this.schemas.store.tableOf(model);
    const table = name ? this.schemas.store.byName.get(name) : undefined;
    if (!table) return null;
    const row = rowsFromLogical(this.schemas.store.result, this.schemas.store.layout, { [model]: [{ key, fields: {}, created: 0, modified: 0 }] } as LogicalTables)[table.name]?.[0];
    if (!row) return null;
    return { table, values: table.primaryKey.map((c) => stored(row[c] ?? null)) };
  }

  /** A stable key from a model table's row, whose key columns are the key fields'. */
  private stableKeyOf(model: string, row: Record<string, unknown>): string | null {
    const logical = this.model(model);
    if (!logical) return null;
    const key = logical.keyFields.map((f) => [f.name, row[f.name] ?? null] as [string, unknown]);
    return logicalRowKey({ key: key as LogicalRow["key"] });
  }

  /** Whether a row of `model` with `key` is there. */
  exists(model: string, key: LogicalRow["key"]): boolean {
    const changed = this.overlay.get(id(model, logicalRowKey({ key })));
    if (changed !== undefined) return changed !== null;
    const found = this.storedKey(model, key);
    if (!found) return false;
    return this.database.database.query(`select 1 from ${quote(found.table.name)} where ${found.table.primaryKey.map((c) => `${quote(c)} is ?`).join(" and ")} limit 1`).get(...found.values as never[]) !== null;
  }

  /** The stable keys of `model`'s rows whose stored `column` holds `value`, as of this view. */
  private rowsWhere(model: string, column: string, value: unknown, matches: (row: LogicalRow) => boolean): string[] {
    const name = this.schemas.store.tableOf(model);
    const table = name ? this.schemas.store.byName.get(name) : undefined;
    const out = new Set<string>();
    if (table) {
      const rows = this.database.database.query(`select ${table.primaryKey.map(quote).join(", ")} from ${quote(table.name)} where ${quote(column)} is ?`).all(stored(value) as never) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const key = this.stableKeyOf(model, row);
        if (key !== null && this.overlay.get(id(model, key)) === undefined) out.add(key);
      }
    }
    for (const [at, row] of this.overlay) {
      const [rowModel, key] = at.split("\0") as [string, string];
      if (rowModel === model && row && matches(row)) out.add(key);
    }
    return [...out];
  }

  /** The column a model's own `field` is stored in, and the value it stores for `value`. */
  private storedField(model: string, field: string, value: unknown): { column: string; value: unknown } | null {
    const logical = this.model(model);
    const name = this.schemas.store.tableOf(model);
    const table = name ? this.schemas.store.byName.get(name) : undefined;
    const columns = table?.fields.find((f) => f.name === field)?.columns;
    if (!logical || !table || columns?.length !== 1) return null;
    const row = { key: logical.keyFields.map((f) => [f.name, null]), fields: { [field]: value }, created: 0, modified: 0 };
    const storedRow = rowsFromLogical(this.schemas.store.result, this.schemas.store.layout, { [model]: [row] } as unknown as LogicalTables)[table.name]?.[0];
    return { column: columns[0]!, value: storedRow?.[columns[0]!] ?? null };
  }

  lookup(): ChangedRowLookup & { named(model: string, name: string): string[] } {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    return {
      hasKey: (model, reference) => {
        const logical = this.model(model);
        if (!logical) return false;
        const value = JSON.parse(reference) as unknown;
        const key = (logical.keyFields.length === 1 ? [[logical.keyFields[0]!.name, value]] : value) as LogicalRow["key"];
        return Array.isArray(key) && this.exists(model, key);
      },
      holding: (model, field, value) => {
        const where = this.storedField(model, field, value);
        if (!where) return [];
        return this.rowsWhere(model, where.column, where.value, (row) => same(row.fields[field], value));
      },
      referrers: (model, stableKey) => this.referrers(model, JSON.parse(stableKey) as LogicalRow["key"]),
      named: (model, name) => {
        const logical = this.model(model);
        if (!logical) return [];
        const matches = (row: LogicalRow) => {
          try { return collectionRowName(logical, row) === name; } catch { return false; }
        };
        if (logical.path && !logical.key.includes(logical.path)) {
          const where = this.storedField(model, logical.path, name);
          return where ? this.rowsWhere(model, where.column, where.value, matches) : [];
        }
        // Named by a key: the row with that key, if there is one and it is named so.
        const keys: LogicalRow["key"][] = [];
        if (name.startsWith("~row-")) {
          try {
            const text = new TextDecoder().decode(Uint8Array.from(atob(name.slice(5).replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)));
            keys.push(JSON.parse(text) as LogicalRow["key"]);
          } catch { /* not a key's name */ }
        } else if (logical.keyFields.length === 1) {
          keys.push([[logical.keyFields[0]!.name, name]] as LogicalRow["key"]);
        }
        const out: string[] = [];
        for (const key of keys) {
          const [row] = this.rowsByKey({ [model]: [key] })[model] ?? [];
          if (row && matches(row as LogicalRow)) out.push(logicalRowKey({ key }));
        }
        return out;
      },
    };
  }

  /**
   * The rows that still refer to the row of `model` with `key`, as of this view: rows of a
   * table whose foreign key names it, and the rows that hold it as a member through a join
   * table. A row the overlay changed is checked in its own new form instead.
   */
  private referrers(model: string, key: LogicalRow["key"]): Array<{ model: string; row: string }> {
    const target = this.storedKey(model, key);
    if (!target) return [];
    const store = this.schemas.store;
    const out = new Map<string, { model: string; row: string }>();
    for (const table of store.layout) {
      for (const fk of table.foreignKeys) {
        if (fk.table !== target.table.name) continue;
        const values = fk.refColumns.map((c) => target.values[target.table.primaryKey.indexOf(c)] ?? null);
        const where = fk.columns.map((c) => `${quote(c)} is ?`).join(" and ");
        if (table.ends) {
          // A join row: its other end's row holds this one as a member, if that end holds the field.
          const end = table.ends.find((e) => e.columns.length === fk.columns.length && e.columns.every((c, i) => c === fk.columns[i]));
          const other = end && table.ends.find((e) => e !== end);
          if (!other || !this.model(other.model)?.fields.some((f) => f.name === other.field)) continue;
          const holderTable = store.byName.get(store.tableOf(other.model) ?? "");
          if (!holderTable) continue;
          for (const row of this.database.database.query(`select ${other.columns.map(quote).join(", ")} from ${quote(table.name)} where ${where}`).all(...values as never[]) as Array<Record<string, unknown>>) {
            const holder: Record<string, unknown> = {};
            holderTable.primaryKey.forEach((c, i) => { holder[c] = row[other.columns[i]!]; });
            const stableKey = this.stableKeyOf(other.model, holder);
            if (stableKey !== null && this.overlay.get(id(other.model, stableKey)) === undefined) out.set(id(other.model, stableKey), { model: other.model, row: stableKey });
          }
          continue;
        }
        const referring = store.modelOfTable(table.name);
        if (!this.model(referring)) continue;
        for (const row of this.database.database.query(`select ${table.primaryKey.map(quote).join(", ")} from ${quote(table.name)} where ${where}`).all(...values as never[]) as Array<Record<string, unknown>>) {
          const stableKey = this.stableKeyOf(referring, row);
          if (stableKey !== null && this.overlay.get(id(referring, stableKey)) === undefined) out.set(id(referring, stableKey), { model: referring, row: stableKey });
        }
      }
    }
    return [...out.values()];
  }
}

/** A row change as plain rows. */
function plainChange(logical: LogicalSchema, change: RowChange): ChangedRow {
  const key = plainRows(logical, change.model, [{ key: change.key, fields: {}, created: 0, modified: 0 } as LogicalRow])[0]!.key as LogicalRow["key"];
  return { model: change.model, key, row: change.row ? plainRows(logical, change.model, [change.row])[0] as LogicalRow : null };
}

/** A plain row change as the log holds it (Date fields tagged). */
function treeChange(logical: LogicalSchema, change: ChangedRow): RowChange {
  const [key] = treeTables(logical, { [change.model]: [{ key: change.key, fields: {}, created: 0, modified: 0 }] } as LogicalTables)[change.model]!;
  const row = change.row ? treeTables(logical, { [change.model]: [change.row] } as LogicalTables)[change.model]![0]! : null;
  return { model: change.model, key: key!.key, row };
}

/** Thrown for changes a collection's schema refuses, as row replay's own errors say. */
function refused(error: unknown): never {
  if (error instanceof ProtocolCollectionError) throw new Error(`Invalid row operation: ${error.message}`);
  throw error;
}

/** A collection's database as asked for at one root. */
export interface CollectionAt {
  database: CollectionDatabase;
  schemas: CollectionSchemas;
  /** The collection directory's hash at that root. */
  directory: ObjectHash;
  /** The database is already past that root's entry, and unchanged: ask again at the head. */
  past?: true;
}

/** Every collection's database on this host, by tree and collection path. */
export class CollectionDatabases {
  private readonly open = new Map<string, CollectionDatabase>();
  private readonly turns = new Map<string, Promise<unknown>>();
  /** Log entries this host built or checked that aren't yet a database's, by entry hash. */
  private readonly pending = new Map<ObjectHash, CollectionView>();
  /** The trees whose databases on disk have all been opened. */
  private readonly scanned = new Set<string>();
  /** How often row replay and collection checks ran on a database, and how often on a whole log instead. */
  readonly counts = { replayed: 0, replayedFromLog: 0, checked: 0, checkedWhole: 0 };

  constructor(
    private readonly root: string,
    private readonly read: Load,
    private readonly schemas?: CollectionSchemaCache,
  ) {}

  private folder(tree: string, path: string): string {
    return join(this.root, tree, encodeURIComponent(path));
  }

  /** Run `work` as the only change to one database. */
  turn<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.turns.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.turns.set(key, next);
    return next.finally(() => { if (this.turns.get(key) === next) this.turns.delete(key); });
  }

  /** Hold the databases at `keys` for `work`, one turn after another in key order. */
  holding<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const [first, ...rest] = [...new Set(keys)].sort();
    return first === undefined ? work() : this.turn(first, () => this.holding(rest, work));
  }

  static key(tree: string, path: string): string {
    return `${tree}\0${path}`;
  }

  /**
   * Apply one tree's accepted updates, in order, to the databases of the collections they
   * moved: the change feed's collections follower for that tree hands them over. Updates
   * a follower fell behind on are coalesced: each database moves once, to the last root.
   * A database that can't follow is logged and left; `at` moves it when it is read.
   */
  async followUpdates(records: ReadonlyArray<{ update: { tree: string; root: string; previous?: { root: string } | null }; collections?: string[][] }>): Promise<void> {
    const last = records[records.length - 1];
    if (!last) return;
    const paths = new Set<string>();
    for (const { update, collections } of records) {
      const folders = collections ?? await changedCollectionFolders((update.previous?.root ?? null) as ObjectHash | null, update.root as ObjectHash, this.read);
      for (const names of folders) paths.add(`/${names.join("/")}`);
    }
    const { tree, root } = last.update;
    for (const path of paths) {
      try {
        await this.turn(CollectionDatabases.key(tree, path), () => this.catchUp(tree, path, root as ObjectHash));
      } catch (error) {
        console.error(`overstoryd: the collection database at ${tree}${path} could not follow its log`, error);
      }
    }
  }

  /** What `at` waits for first: the tree's follower having applied every update published so far. */
  followed: (tree: string) => Promise<void> = async () => {};

  /**
   * The database of the collection at `path`, at `root`'s entry of its log: reopened,
   * moved forward by the entries after the one it is at, or rebuilt from the newest snapshot
   * and the entries after it. Null when there is no collection there. `held` when the
   * caller already holds its turn.
   */
  async at(tree: string, path: string, root: ObjectHash, held = false): Promise<CollectionAt | null> {
    await this.followed(tree);
    const key = CollectionDatabases.key(tree, path);
    return held ? this.catchUp(tree, path, root) : this.turn(key, () => this.catchUp(tree, path, root));
  }

  private async directoryAt(root: ObjectHash, path: string): Promise<{ directory: ProtocolDirectory; hash: ObjectHash } | null> {
    let hash = root;
    let directory = decodeProtocolDirectory(await this.read(root));
    for (const name of path.split("/").filter(Boolean)) {
      const entry = directory.entries.find((candidate) => candidate.name === name);
      if (!entry?.directory) return null;
      hash = entry.directory as ObjectHash;
      directory = decodeProtocolDirectory(await this.read(hash));
    }
    return { directory, hash };
  }

  private async catchUp(tree: string, path: string, root: ObjectHash): Promise<CollectionAt | null> {
    const at = await this.directoryAt(root, path);
    const collection = at?.directory.collection;
    if (!at || !collection) return null;
    const schemaFile = at.directory.entries.find((e) => e.name === "schema.beetle")?.file;
    if (!schemaFile) return null;
    const logical = await directoryCollectionSchema(at.directory, this.read, this.schemas);
    const schemas = { logical, store: new StoreSchema(logical.result) };
    const key = CollectionDatabases.key(tree, path);
    const folder = this.folder(tree, path);
    let database = this.open.get(key) ?? CollectionDatabase.reopen(folder) ?? undefined;
    if (database && database.schema !== schemaFile) {
      database.close();
      database = undefined;
    }
    if (database) {
      this.open.set(key, database);
      try {
        if (await this.follow(database, schemas, collection.log as ObjectHash, at.hash)) return { database, schemas, directory: at.hash };
        // A root the database has already moved past: the caller asks again at the head.
        if (await this.precedes(collection.log as ObjectHash, database.head)) return { database, schemas, directory: at.hash, past: true };
      } catch (error) {
        console.error(`overstoryd: the database of ${tree}${path} could not follow its log; rebuilding it`, error);
      }
      database.close();
      this.open.delete(key);
    }
    database = await this.build(folder, schemas, schemaFile, collection.log as ObjectHash, at.hash);
    this.open.set(key, database);
    return { database, schemas, directory: at.hash };
  }

  /**
   * Move `database` to `head` by the entries after the one it is at. False when `head`
   * doesn't follow it (a snapshot or the log's start comes first): it is rebuilt instead.
   */
  private async follow(database: CollectionDatabase, schemas: CollectionSchemas, head: ObjectHash, directory: ObjectHash): Promise<boolean> {
    if (database.head === head) {
      if (database.directory !== directory) database.record({ ...database, directory });
      return true;
    }
    const pending: Array<{ hash: ObjectHash; entry: ProtocolLog }> = [];
    for (let at: ObjectHash | null = head; at !== database.head;) {
      if (!at) return false;
      const entry = decodeProtocolLog(await this.read(at));
      if ("snapshot" in entry) {
        // The host's own snapshot of the rows the database holds changes nothing.
        if (entry.previous !== database.head || entry.rows !== database.rows || entry.rowsHash !== database.lthash.hash()) return false;
        pending.push({ hash: at, entry });
        break;
      }
      pending.push({ hash: at, entry });
      at = entry.previous as ObjectHash | null;
    }
    this.apply(database, schemas, pending.reverse(), directory);
    return true;
  }

  /** Whether `entry` comes before `head` in its log, as far back as the newest snapshot. */
  private async precedes(entry: ObjectHash, head: ObjectHash | null): Promise<boolean> {
    for (let at = head; at;) {
      const log = decodeProtocolLog(await this.read(at));
      if (log.previous === entry) return true;
      if ("snapshot" in log) return false;
      at = log.previous as ObjectHash | null;
    }
    return false;
  }

  /**
   * Commit a mutation's open write on `database` once its update is accepted with `head`
   * as the collection's new log entry: the entry's rows are written as the log holds them
   * and the database records it. False, with nothing committed, when the entry doesn't
   * follow the database or doesn't hold the rows its count and rows hash say.
   */
  async commitAccepted(database: CollectionDatabase, schemas: CollectionSchemas, head: ObjectHash, directory: ObjectHash): Promise<boolean> {
    const entry = decodeProtocolLog(await this.read(head));
    if (!("changes" in entry) || entry.previous !== database.head) return false;
    const before = database.rowsByKey(schemas.store, changedKeys(schemas.logical, entry.changes));
    const after = positionAfter(schemas, database, before, entry.changes);
    if (after.rows !== entry.rows || after.lthash.hash() !== entry.rowsHash) return false;
    database.commitWrite(schemas.store, after.changes, { head, rows: after.rows, lthash: after.lthash, directory });
    return true;
  }

  /** Apply entries in order, in one transaction, each checked against its row count and rows hash. */
  private apply(database: CollectionDatabase, schemas: CollectionSchemas, entries: ReadonlyArray<{ hash: ObjectHash; entry: ProtocolLog }>, directory: ObjectHash): void {
    database.database.transaction(() => {
      let position: CollectionPosition = { head: database.head, rows: database.rows, lthash: database.lthash, directory };
      for (const { hash, entry } of entries) {
        if (!("changes" in entry)) {
          position = { ...position, head: hash };
          continue;
        }
        const before = database.rowsByKey(schemas.store, changedKeys(schemas.logical, entry.changes));
        const after = positionAfter(schemas, position, before, entry.changes);
        if (after.rows !== entry.rows || after.lthash.hash() !== entry.rowsHash) throw new TypeError(`Log entry ${hash} doesn't hold the rows its count and rows hash say`);
        database.writeChanges(database.database, schemas.store, after.changes);
        position = { head: hash, rows: after.rows, lthash: after.lthash, directory };
      }
      database.record(position);
    })();
  }

  /** A new database at `head`: from the newest snapshot entry's file at or before it, or an empty one, then the entries after. */
  private async build(folder: string, schemas: CollectionSchemas, schemaFile: string, head: ObjectHash, directory: ObjectHash): Promise<CollectionDatabase> {
    const pending: Array<{ hash: ObjectHash; entry: ProtocolLog }> = [];
    let database: CollectionDatabase | null = null;
    for (let at: ObjectHash | null = head; at;) {
      const entry = decodeProtocolLog(await this.read(at));
      if ("snapshot" in entry) {
        database = CollectionDatabase.fromFile(folder, await this.read(entry.snapshot as ObjectHash), schemaFile);
        const lthash = new LtHash();
        let rows = 0;
        for (const [model, list] of Object.entries(treeTables(schemas.logical, database.allRows(schemas.store)))) {
          for (const row of list) { lthash.add(rowHashElement(model, row)); rows++; }
        }
        if (rows !== entry.rows || lthash.hash() !== entry.rowsHash) {
          database.close();
          throw new TypeError(`The snapshot in log entry ${at} doesn't hold the rows its entry says`);
        }
        database.record({ head: at, rows, lthash, directory });
        break;
      }
      pending.push({ hash: at, entry });
      at = entry.previous as ObjectHash | null;
    }
    database ??= CollectionDatabase.create(folder, schemas.store.layout, schemaFile);
    try {
      this.apply(database, schemas, pending.reverse(), directory);
    } catch (error) {
      database.close();
      throw error;
    }
    return database;
  }

  /** Open every database of `tree` left on disk, so that one can be found by the entry it is at. */
  private openTree(tree: string): void {
    if (this.scanned.has(tree)) return;
    this.scanned.add(tree);
    const folder = join(this.root, tree);
    if (!existsSync(folder)) return;
    for (const name of readdirSync(folder)) {
      const key = CollectionDatabases.key(tree, decodeURIComponent(name));
      if (this.open.has(key)) continue;
      const database = CollectionDatabase.reopen(join(folder, name));
      if (database) this.open.set(key, database);
    }
  }

  /**
   * The collection of `directory` as of its log entry `head`: a database of `tree` at that
   * entry, or an entry this host built or checked on one. Null when neither holds it.
   */
  private viewAt(tree: string, directory: ProtocolDirectory, head: ObjectHash | null, schemas: CollectionSchemas): CollectionView | null {
    const schemaFile = directory.entries.find((e) => e.name === "schema.beetle")?.file;
    const pending = head ? this.pending.get(head) : undefined;
    if (pending) return pending.valid && pending.database.schema === schemaFile ? pending : null;
    this.openTree(tree);
    for (const [key, database] of this.open) {
      if (!key.startsWith(`${tree}\0`) || database.head !== head || database.schema !== schemaFile || !head) continue;
      return new CollectionView(database, schemas, head, { rows: database.rows, lthash: database.lthash }, new Map(), new Set([head]));
    }
    return null;
  }

  /** Keep a view for its entry, the newest `PENDING` of them. */
  private keep(view: CollectionView): void {
    if (!view.head) return;
    this.pending.delete(view.head);
    this.pending.set(view.head, view);
    while (this.pending.size > PENDING) this.pending.delete(this.pending.keys().next().value!);
  }

  /**
   * The view after `changes` (plain, each row once) on `view`, checked as accepting them
   * requires: each changed row against the schema and the rest of the collection, row
   * names, and the row count and rows hash, which `expect` gives when the entry exists.
   * Throws {@link ProtocolCollectionError} for changes the collection refuses.
   */
  private extend(view: CollectionView, entries: Iterable<string> | null, changes: readonly ChangedRow[], expect?: { hash: ObjectHash; entry: ProtocolLog }): { view: CollectionView; entry: { hash: ObjectHash; bytes?: Uint8Array } } {
    const { logical } = view.schemas;
    const overlay = new Map(view.overlay);
    for (const change of changes) overlay.set(id(change.model, logicalRowKey(change)), change.row);
    const next = new CollectionView(view.database, view.schemas, null, view.position, overlay, view.chain);
    const lookup = next.lookup();
    const diagnostics = checkChangedRows(logical, changes, lookup);
    if (diagnostics.length > 0) throw new ProtocolCollectionError("constraint", new LogicalCollectionError(diagnostics).message);
    checkChangedRowNames(entries, logical, changes.flatMap((c) => (c.row ? [{ model: c.model, row: c.row }] : [])), lookup.named);
    const keys: Record<string, LogicalRow["key"][]> = {};
    for (const change of changes) (keys[change.model] ??= []).push(change.key);
    const before = view.rowsByKey(keys);
    const tree = changes.map((change) => treeChange(logical, change));
    const after = positionAfter(view.schemas, { head: view.head, rows: view.position.rows, lthash: view.position.lthash, directory: "" }, before, tree);
    let entry: { hash: ObjectHash; bytes?: Uint8Array };
    if (expect) {
      if (after.rows !== expect.entry.rows || after.lthash.hash() !== expect.entry.rowsHash) throw new ProtocolCollectionError("constraint", `Log entry ${expect.hash} doesn't hold the rows its count and rows hash say`);
      entry = { hash: expect.hash };
    } else {
      const encoded = encodedLogEntry({ type: "log", previous: view.head as Hash | null, rows: after.rows, rowsHash: after.lthash.hash(), changes: tree });
      entry = { hash: encoded.hash as ObjectHash, bytes: encoded.bytes };
    }
    const chain = new Set(view.chain);
    chain.add(entry.hash);
    const result = new CollectionView(view.database, view.schemas, entry.hash, { rows: after.rows, lthash: after.lthash }, overlay, chain);
    this.keep(result);
    return { view: result, entry };
  }

  /**
   * Row replay (spec 10 §4.1) over `tree`'s databases: the operations apply to just the
   * rows they name, read from the database at the directory's log entry, and are checked
   * against the rest of the collection there, so no whole collection is read. Null when no
   * database of the tree is at that entry; the caller replays from the log instead.
   */
  async replay(tree: string, directoryHash: ObjectHash, operations: readonly RowOperation[], read: Load, at: number): Promise<{ directory: ObjectHash; generated: Map<ObjectHash, Uint8Array> } | null> {
    const directory = decodeProtocolDirectory(await read(directoryHash));
    const collection = directory.collection;
    if (!collection) return null;
    let logical: LogicalSchema;
    try {
      logical = await directoryCollectionSchema(directory, read, this.schemas);
    } catch (error) {
      return refused(error);
    }
    if (logical.fingerprint !== collection.modelFingerprint) return null;
    // Everything from here runs without yielding, so no database moves under it.
    const view = this.viewAt(tree, directory, collection.log as ObjectHash, { logical, store: new StoreSchema(logical.result) });
    if (!view) {
      this.counts.replayedFromLog++;
      return null;
    }
    this.counts.replayed++;
    const keys: Record<string, LogicalRow["key"][]> = {};
    for (const operation of operations) {
      try { (keys[operation.model] ??= []).push(JSON.parse(operation.row) as LogicalRow["key"]); } catch { throw new Error("Invalid row operation: its row is not a stable key"); }
    }
    const current = view.rowsByKey(keys);
    const applied = applyRowOperations(logical, current, operations, at);
    const changes: ChangedRow[] = [];
    for (const [model, list] of Object.entries(keys)) {
      const was = new Map((current[model] ?? []).map((row) => [logicalRowKey(row as LogicalRow), row as LogicalRow]));
      const is = new Map((applied[model] ?? []).map((row) => [logicalRowKey(row as LogicalRow), row as LogicalRow]));
      for (const stableKey of new Set(list.map((key) => logicalRowKey({ key })))) {
        const before = was.get(stableKey), after = is.get(stableKey);
        if (!before && !after) continue;
        if (before && after && encodedRow(treeChange(logical, { model, key: after.key, row: after }).row!).hash === encodedRow(treeChange(logical, { model, key: before.key, row: before }).row!).hash) continue;
        changes.push({ model, key: (after ?? before)!.key, row: after ?? null });
      }
    }
    const generated = new Map<ObjectHash, Uint8Array>();
    let log = collection.log as ObjectHash;
    if (changes.length > 0) {
      let extended;
      try {
        extended = this.extend(view, null, changes);
      } catch (error) {
        return refused(error);
      }
      generated.set(extended.entry.hash, extended.entry.bytes!);
      log = extended.entry.hash;
    }
    const bytes = encodeProtocolDirectory({ ...directory, collection: { ...collection, log: log as Hash } });
    const hash = hashObject(bytes);
    generated.set(hash, bytes);
    return { directory: hash, generated };
  }

  /**
   * Check a candidate's collection directory against `tree`'s databases (collections §1):
   * each new log entry back to one the host holds is applied to the rows there and checked,
   * and the folder's entries are checked against its rows' names. False when no database or
   * entry the host holds is reached; the caller checks the whole collection instead.
   * Throws {@link ProtocolCollectionError} for a collection the host refuses.
   */
  async check(tree: string, directory: ProtocolDirectory, read: Load): Promise<boolean> {
    const collection = directory.collection;
    if (!collection) return true;
    const logical = await directoryCollectionSchema(directory, read, this.schemas);
    if (logical.fingerprint !== collection.modelFingerprint) throw new ProtocolCollectionError("source", "collection.modelFingerprint doesn't match the folder's schema.beetle");
    const schemas = { logical, store: new StoreSchema(logical.result) };
    const entries: Array<{ hash: ObjectHash; entry: ProtocolLog }> = [];
    let base: CollectionView | null = null;
    for (let at: ObjectHash | null = collection.log as ObjectHash; entries.length <= NEW_ENTRIES;) {
      base = this.viewAt(tree, directory, at, schemas);
      if (base || !at) break;
      const entry = decodeProtocolLog(await read(at));
      if (!("changes" in entry)) {
        this.counts.checkedWhole++;
        return false;
      }
      entries.push({ hash: at, entry });
      at = entry.previous as ObjectHash | null;
    }
    // Everything from here runs without yielding, so no database moves under it.
    if (!base || !base.valid || entries.some(({ entry }, i) => entry.previous !== (entries[i + 1]?.hash ?? base!.head))) {
      this.counts.checkedWhole++;
      return false;
    }
    this.counts.checked++;
    let view: CollectionView = base;
    for (const { hash, entry } of entries.reverse()) {
      if (entry.previous !== view.head) return false;
      if (entry.previous !== null && !("changes" in entry && entry.changes.length)) throw new ProtocolCollectionError("constraint", `Log entry ${hash} changes no row`);
      view = this.extend(view, null, (entry as { changes: RowChange[] }).changes.map((change) => plainChange(logical, change)), { hash, entry }).view;
    }
    checkChangedRowNames(directory.entries.map((e) => e.name), logical, [], view.lookup().named);
    return true;
  }

  /**
   * A collection's rows at `root`, named as its folder's children: read from its database
   * when that is at `root`'s entry. Null when there is no collection there; undefined when
   * the database has moved past `root`, which the caller reads from the log instead.
   */
  async namedRows(tree: string, path: string, root: ObjectHash): Promise<{ main: string | null; rows: Map<string, CollectionRowNode[]> } | null | undefined> {
    const found = await this.at(tree, path, root);
    if (!found) return null;
    if (found.past) return undefined;
    const at = await this.directoryAt(root, path);
    if (!at || found.database.head !== at.directory.collection?.log) return undefined;
    return nameCollectionRows(at.directory.entries.map((e) => e.name), found.schemas.logical, found.database.allRows(found.schemas.store));
  }

  /**
   * The row a path below a collection folder names at `root` (reading §5),
   * `rest` being the path's names below the folder: the main model's row by name, or another
   * model's row by its model and name, as the log holds it (Date fields tagged). "table" for
   * a path that names a model's table; an empty list for a name no row has. Undefined when
   * the database isn't at `root`'s entry, which the caller reads from the log instead.
   */
  async rowAt(tree: string, path: string, root: ObjectHash, rest: readonly string[]): Promise<Array<{ model: string; row: LogicalRow }> | "table" | undefined> {
    const found = await this.at(tree, path, root);
    if (!found || found.past) return undefined;
    const at = await this.directoryAt(root, path);
    const head = at?.directory.collection?.log as ObjectHash | undefined;
    if (!at || !head || found.database.head !== head) return undefined;
    const { logical } = found.schemas;
    const main = logical.result.models.find((m) => m.main)?.name ?? null;
    const tableNamed = rest[0] !== main && logical.models.some((m) => m.name === rest[0]);
    if (tableNamed && rest.length === 1) return "table";
    const [model, name] = tableNamed ? [rest[0]!, rest[1]] : [main, rest[0]];
    if (!model || name === undefined || rest.length !== (tableNamed ? 2 : 1)) return [];
    const view = new CollectionView(found.database, found.schemas, head, { rows: found.database.rows, lthash: found.database.lthash }, new Map(), new Set([head]));
    const [stableKey] = view.lookup().named(model, name);
    if (stableKey === undefined) return [];
    const [row] = view.rowsByKey({ [model]: [JSON.parse(stableKey) as LogicalRow["key"]] })[model] ?? [];
    if (!row) return [];
    return [{ model, row: treeTables(logical, { [model]: [row] } as LogicalTables)[model]![0]! }];
  }

  /** Forget a database whose rows a failed write left unknown; it is reopened or rebuilt when next asked for. */
  forget(tree: string, path: string): void {
    const key = CollectionDatabases.key(tree, path);
    this.open.get(key)?.close();
    this.open.delete(key);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.turns.values()]);
    for (const database of this.open.values()) database.close();
    this.open.clear();
  }
}

export type { RowsByTable };
