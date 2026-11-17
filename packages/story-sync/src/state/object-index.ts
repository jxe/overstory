import { Database } from "bun:sqlite";
import type { BigIntStats } from "node:fs";

/**
 * The per-workspace object index: `objects` maps every absolute path the
 * snapshot walk encodes to the hash of its wire object, for files, pages
 * (a Markdown file's page object) and directories alike. The index is an optimization, never authority: a file
 * row counts only while the complete stat tuple (size, mtime, ctime, inode,
 * device) still matches, directory rows carry no validity tuple and are
 * trusted only by callers that verify the re-encoded object's hash
 * afterwards, the workspace revalidates every row with an uncached walk at
 * open, after watcher gaps, and on a slow timer, and every object served by
 * hash is verified before it leaves the daemon. A stale row can therefore
 * delay a push but never produce a wrong object.
 */
type ObjectKind = "file" | "page" | "directory";

export class ObjectIndex {
  private database: Database;
  constructor(databasePath: string) {
    this.database = new Database(databasePath, { create: true });
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.database.exec("CREATE TABLE IF NOT EXISTS objects(path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER, mtime_ns INTEGER, ctime_ns INTEGER, ino INTEGER, dev INTEGER, hash TEXT NOT NULL);");
    this.database.exec("CREATE INDEX IF NOT EXISTS objects_hash ON objects(hash);");
    // Directory objects by hash: their entry times are in no file, so a
    // directory cannot be rebuilt from the folder (data model §6).
    this.database.exec("CREATE TABLE IF NOT EXISTS directories(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);");
  }

  /** A directory object's bytes, as a scan or a write of the folder left them. */
  directoryBytes(hash: string): Uint8Array | undefined {
    const row = this.database.query("SELECT bytes FROM directories WHERE hash = ?").get(hash) as { bytes: Uint8Array } | null;
    return row ? new Uint8Array(row.bytes) : undefined;
  }

  /** Drop directory objects no path names any more. */
  pruneDirectories(): void {
    this.database.exec("DELETE FROM directories WHERE hash NOT IN (SELECT hash FROM objects WHERE kind = 'directory')");
  }

  /** The cached hash of a `file` or `page` row when its full stat tuple still matches. */
  objectRow(absolute: string, info: BigIntStats, kind: "file" | "page" = "file"): { hash: string } | undefined {
    const row = this.database.query(
      "SELECT hash FROM objects WHERE path = ? AND kind = ? AND size = ? AND mtime_ns = ? AND ctime_ns = ? AND ino = ? AND dev = ?",
    ).get(absolute, kind, info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev) as { hash: string } | null;
    return row ?? undefined;
  }

  /** Record a row; one that already says the same is not rewritten. */
  rememberObject(absolute: string, kind: ObjectKind, info: BigIntStats | undefined, hash: string, bytes?: Uint8Array): void {
    if (kind === "directory" || !info) {
      if (kind === "directory") this.rememberDirectory(absolute, hash, bytes);
      return;
    }
    // Compared in SQL: nanosecond times don't fit a double.
    if (this.database.query("SELECT 1 FROM objects WHERE path = ? AND kind = ? AND size = ? AND mtime_ns = ? AND ctime_ns = ? AND ino = ? AND dev = ? AND hash = ?")
      .get(absolute, kind, info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev, hash)) return;
    this.database.query(
      "INSERT INTO objects(path, kind, size, mtime_ns, ctime_ns, ino, dev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,size=excluded.size,mtime_ns=excluded.mtime_ns,ctime_ns=excluded.ctime_ns,ino=excluded.ino,dev=excluded.dev,hash=excluded.hash",
    ).run(absolute, kind, info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev, hash);
  }

  rememberDirectory(absolute: string, hash: string, bytes?: Uint8Array): void {
    const row = this.database.query("SELECT kind, hash FROM objects WHERE path = ?").get(absolute) as { kind: string; hash: string } | null;
    if (row?.kind === "directory" && row.hash === hash) return;
    if (bytes) this.database.query("INSERT OR IGNORE INTO directories(hash, bytes) VALUES (?, ?)").run(hash, bytes);
    this.database.query(
      "INSERT INTO objects(path, kind, size, mtime_ns, ctime_ns, ino, dev, hash) VALUES (?, 'directory', NULL, NULL, NULL, NULL, NULL, ?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,size=NULL,mtime_ns=NULL,ctime_ns=NULL,ino=NULL,dev=NULL,hash=excluded.hash",
    ).run(absolute, hash);
  }

  /**
   * Run `run` (one walk) with its writes in one transaction. Walks can
   * overlap, so the transaction spans from the first to start until the last
   * to finish; a failure still commits, since every row is only a cache.
   */
  async scan<T>(run: () => Promise<T>): Promise<T> {
    if (this.scans++ === 0) this.database.exec("BEGIN");
    try {
      return await run();
    } finally {
      if (--this.scans === 0) this.database.exec("COMMIT");
    }
  }
  private scans = 0;

  forgetObject(absolute: string): void {
    this.database.query("DELETE FROM objects WHERE path = ?").run(absolute);
  }

  /** Forget directory rows at `absolute` and beneath it. */
  forgetDirectoriesBeneath(absolute: string): void {
    const beneath = absolute.endsWith("/") ? absolute : `${absolute}/`;
    this.database.query("DELETE FROM objects WHERE kind = 'directory' AND (path = ? OR substr(path, 1, ?) = ?)")
      .run(absolute, beneath.length, beneath);
  }

  /** The stored hash for a path regardless of validity; used by revalidation. */
  storedObjectHash(absolute: string): { kind: ObjectKind; hash: string } | undefined {
    const row = this.database.query("SELECT kind, hash FROM objects WHERE path = ?").get(absolute) as { kind: ObjectKind; hash: string } | null;
    return row ?? undefined;
  }

  /** Every stored path of one kind; revalidation drops rows whose files vanished. */
  storedObjectPaths(kind: ObjectKind): string[] {
    return (this.database.query("SELECT path FROM objects WHERE kind = ?").all(kind) as Array<{ path: string }>).map((row) => row.path);
  }

  lookupHash(hash: string): { path: string; kind: ObjectKind } | undefined {
    const row = this.database.query("SELECT path, kind FROM objects WHERE hash = ? ORDER BY path LIMIT 1").get(hash) as { path: string; kind: ObjectKind } | null;
    return row ?? undefined;
  }

  close(): void { this.database.close(); }
}
