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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, logicalRowsByKey, StoreSchema } from "@ovst/beetle";
import { readDatabaseRows, SQLiteStore } from "@ovst/beetle/sqlite";
import {
  decodeProtocolDirectory,
  decodeProtocolLog,
  LtHash,
  logicalRowKey,
  rowHashElement,
  type LogicalRow,
  type ObjectHash,
  type ProtocolDirectory,
  type ProtocolLog,
  type RowChange,
} from "@ovst/protocol";
import { directoryCollectionSchema, plainRows, treeTables, type CollectionSchemaCache, type LogicalSchema } from "@ovst/collection-schema";
import { logicalFromRows, rowsFromLogical, setupSql, type LogicalTables, type RowsByTable, type Table } from "@ovst/usl";
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
            db.prepare(`delete from ${quote(join.name)} where ${where(sourceColumns)}`).run(...sourceValues.map(stored) as never[]);
            const insert = this.insert(join, db);
            for (const j of rows[join.name] ?? []) if (sourceColumns.every((c, i) => canonical(j[c] ?? null) === canonical(sourceValues[i]))) insert(j);
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
  /** Each tree's newest accepted update still being applied to its databases. */
  private readonly advancing = new Map<string, Promise<void>>();

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
   * Apply an accepted update to the databases of the collections it moved, as it is
   * accepted. Anything that reads a database of the tree waits for this first.
   */
  accepted(update: { tree: string; root: string; previous?: { root: string } | null }): Promise<void> {
    const prior = this.advancing.get(update.tree) ?? Promise.resolve();
    const next = prior.then(async () => {
      const folders = await changedCollectionFolders((update.previous?.root ?? null) as ObjectHash | null, update.root as ObjectHash, this.read);
      for (const names of folders) {
        const path = `/${names.join("/")}`;
        await this.turn(CollectionDatabases.key(update.tree, path), () => this.catchUp(update.tree, path, update.root as ObjectHash));
      }
    }).catch((error) => {
      console.error(`overstoryd: a collection database of ${update.tree} could not follow its log`, error);
    });
    this.advancing.set(update.tree, next);
    void next.finally(() => { if (this.advancing.get(update.tree) === next) this.advancing.delete(update.tree); });
    return next;
  }

  /**
   * The database of the collection at `path`, at `root`'s entry of its log: reopened,
   * moved forward by the entries after the one it is at, or rebuilt from the newest snapshot
   * and the entries after it. Null when there is no collection there. `held` when the
   * caller already holds its turn.
   */
  async at(tree: string, path: string, root: ObjectHash, held = false): Promise<CollectionAt | null> {
    await this.advancing.get(tree);
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

  /** Forget a database whose rows a failed write left unknown; it is reopened or rebuilt when next asked for. */
  forget(tree: string, path: string): void {
    const key = CollectionDatabases.key(tree, path);
    this.open.get(key)?.close();
    this.open.delete(key);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.advancing.values(), ...this.turns.values()]);
    for (const database of this.open.values()) database.close();
    this.open.clear();
  }
}

export type { RowsByTable };
