// Collections §1.1: the tree's host snapshots a collection when the changes in its log
// since the last snapshot outgrow its rows, twice over, so a replica or a cold load applies
// at most about twice as many changes as the collection has rows. (A log's first entry
// often holds every row; it is as good as a snapshot, and doesn't call for one.) A snapshot is an entry naming a SQLite
// file of every row, with the same row count and rows hash as the entry before it, written
// in an accepted update the host makes itself with no other effect.

import { compareProtocolNames, decodeProtocolDirectory, decodeProtocolLog, encodeProtocolDirectory, hashObject, type Hash, type ObjectHash, type ProtocolDirectory } from "@ovst/protocol";
import { changesSinceSnapshot, encodedLogEntry } from "@ovst/collection-schema";

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

/** A collection is snapshotted once its log since the last snapshot holds at least this many changes, and more than twice as many as it has rows. */
export const SNAPSHOT_MIN_CHANGES = 1_000;

/** The collection folders whose log `after` changed from `before`, as path names. Only changed directories are read. */
export async function changedCollectionFolders(before: ObjectHash | null, after: ObjectHash, load: Load): Promise<string[][]> {
  const out: string[][] = [];
  const walk = async (was: ObjectHash | null, is: ObjectHash, names: string[]): Promise<void> => {
    if (was === is) return;
    const directory = decodeProtocolDirectory(await load(is));
    const old = was ? decodeProtocolDirectory(await load(was)) : null;
    if (directory.collection && directory.collection.log !== old?.collection?.log) out.push(names);
    const prior = new Map(old?.entries.map((e) => [e.name, e.directory ?? null]) ?? []);
    for (const entry of directory.entries) {
      if (entry.directory && entry.directory !== prior.get(entry.name)) await walk(prior.get(entry.name) ?? null, entry.directory, [...names, entry.name]);
    }
  };
  await walk(before, after, []);
  return out;
}

/** A collection's database as a snapshot's file, with the row count and rows hash it holds. */
export type SnapshotFile = (names: readonly string[]) => Promise<{ bytes: Uint8Array; rows: number; rowsHash: Hash } | null>;

/**
 * `root` with a snapshot entry at the head of each collection in `folders` that needs one,
 * or null when none does. The file is the collection's database (`VACUUM INTO`), which
 * must hold the rows of the entry it follows. The new objects (entries, files,
 * directories) join `objects`.
 */
export async function snapshotCollections(
  root: ObjectHash,
  folders: readonly string[][],
  load: Load,
  objects: Map<ObjectHash, Uint8Array>,
  file: SnapshotFile,
  minChanges = SNAPSHOT_MIN_CHANGES,
): Promise<ObjectHash | null> {
  const read: Load = async (hash) => objects.get(hash) ?? load(hash);
  let next = root;
  for (const names of folders) {
    const directory = await directoryAt(next, names, read);
    if (!directory?.collection) continue;
    const pending = await changesSinceSnapshot(directory.collection.log, read);
    if (pending < minChanges) continue;
    const head = decodeProtocolLog(await read(directory.collection.log as ObjectHash));
    if (pending <= 2 * head.rows) continue;
    const snapshot = await file(names);
    if (!snapshot) continue;
    if (snapshot.rows !== head.rows || snapshot.rowsHash !== head.rowsHash) throw new Error(`The database of /${names.join("/")} doesn't hold the rows of its log's head`);
    const fileHash = hashObject(snapshot.bytes);
    const entry = encodedLogEntry({ type: "log", previous: directory.collection.log as Hash, rows: head.rows, rowsHash: head.rowsHash, snapshot: fileHash as Hash });
    objects.set(fileHash, snapshot.bytes);
    objects.set(entry.hash as ObjectHash, entry.bytes);
    next = await withDirectory(next, names, { ...directory, collection: { ...directory.collection, log: entry.hash } }, read, objects);
  }
  return next === root ? null : next;
}

async function directoryAt(root: ObjectHash, names: readonly string[], load: Load): Promise<ProtocolDirectory | null> {
  let at = root;
  for (const name of names) {
    const entry = decodeProtocolDirectory(await load(at)).entries.find((e) => e.name === name);
    if (!entry?.directory) return null;
    at = entry.directory;
  }
  return decodeProtocolDirectory(await load(at));
}

/** `root` with the directory at `names` replaced by `directory`, each directory above it rewritten. */
async function withDirectory(root: ObjectHash, names: readonly string[], directory: ProtocolDirectory, load: Load, objects: Map<ObjectHash, Uint8Array>): Promise<ObjectHash> {
  if (!names.length) {
    const bytes = encodeProtocolDirectory(directory), hash = hashObject(bytes);
    objects.set(hash, bytes);
    return hash;
  }
  const parent = decodeProtocolDirectory(await load(root));
  const [name, ...rest] = names as [string, ...string[]];
  const entry = parent.entries.find((e) => e.name === name)!;
  const child = await withDirectory(entry.directory!, rest, directory, load, objects);
  const entries = parent.entries.map((e) => (e.name === name ? { name, directory: child } : e)).sort((a, b) => compareProtocolNames(a.name, b.name));
  return withDirectory(root, [], { ...parent, entries }, load, objects);
}
