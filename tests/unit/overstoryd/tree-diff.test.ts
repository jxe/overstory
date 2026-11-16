import { expect, test } from "bun:test";
import { encodeProtocolDirectory, hashObject, transitionPayload, TreeReader, walkTreeDiff, type ObjectHash, type ProtocolDirectoryEntry } from "@ovst/protocol";
import { entryChanges } from "../../../packages/overstoryd/src/updates/document-versions.ts";
import { changedCollectionFolders } from "../../../packages/overstoryd/src/collection-snapshots.ts";

function store() {
  const objects = new Map<ObjectHash, Uint8Array>();
  const put = (bytes: Uint8Array) => { const hash = hashObject(bytes) as ObjectHash; objects.set(hash, bytes); return hash; };
  const file = (text: string) => put(new TextEncoder().encode(text));
  const dir = (entries: ProtocolDirectoryEntry[]) => put(encodeProtocolDirectory({ type: "directory", entries: [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }));
  const reads = new Map<ObjectHash, number>();
  const load = async (hash: ObjectHash) => { reads.set(hash, (reads.get(hash) ?? 0) + 1); return objects.get(hash)!; };
  return { file, dir, load, reads, objects };
}

test("a shared reader reads each object once across the transition and entry-change walks", async () => {
  const s = store();
  const before = s.dir([{ name: "a.md", file: s.file("A"), created: 0, modified: 0 }, { name: "gone", directory: s.dir([{ name: "x.md", file: s.file("X"), created: 0, modified: 0 }]) }]);
  const after = s.dir([{ name: "a.md", file: s.file("A!"), created: 0, modified: 0 }, { name: "new", directory: s.dir([{ name: "y.md", file: s.file("Y"), created: 0, modified: 0 }]) }]);
  const reader = new TreeReader(s.load);
  const transition = await transitionPayload(before, after, reader);
  const changes = await entryChanges(before, after, reader);
  expect(changes.set.map((c) => c.path)).toEqual(["/a.md", "/new/y.md"]);
  expect(changes.removed).toEqual(["/gone/x.md"]);
  expect(transition.objects.length + transition.deltas.length).toBe(4);
  expect([...s.reads.values()].every((count) => count === 1)).toBe(true);
});

test("entries are skipped only when name and target match exactly", async () => {
  const s = store();
  const leaf = s.file("L"), sub = s.dir([{ name: "x.md", file: leaf, created: 0, modified: 0 }]);
  const before = s.dir([
    { name: "same.md", file: leaf, created: 0, modified: 0 },
    { name: "edited.md", file: s.file("old"), created: 0, modified: 0 },
    { name: "kind", file: leaf, created: 0, modified: 0 },
    { name: "nested", tree: "tr_a" },
  ]);
  const after = s.dir([
    { name: "same.md", file: leaf, created: 0, modified: 0 },
    { name: "edited.md", file: s.file("new"), created: 0, modified: 0 },
    { name: "kind", directory: sub },
    { name: "nested", tree: "tr_b" },
  ]);
  const visited: string[] = [];
  await walkTreeDiff(before, after, s.load, { entry: ({ path }) => { visited.push(path); } });
  expect(visited).toEqual(["/edited.md", "/kind", "/nested"]);
});

test("a reader refuses bytes whose hash does not match", async () => {
  const s = store();
  const root = s.dir([{ name: "a.md", file: s.file("A"), created: 0, modified: 0 }]);
  const lying = new TreeReader(async () => new TextEncoder().encode("not it"));
  await expect(walkTreeDiff(null, root, lying, { entry: () => true })).rejects.toThrow("hash mismatch");
});

test("entry changes name the collection folders whose log moved, as the separate walk finds them", async () => {
  const s = store();
  const fingerprint = `sha256:${"0".repeat(64)}` as `sha256:${string}`;
  const log = (n: number) => s.file(`log ${n}`);
  const sorted = (entries: ProtocolDirectoryEntry[]) => [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const collection = (head: ObjectHash, entries: ProtocolDirectoryEntry[] = []) => {
    const schema = { name: "schema.beetle", file: s.file("table T { name: text }"), created: 0, modified: 0 };
    const bytes = encodeProtocolDirectory({ type: "directory", entries: sorted([...entries, schema]), collection: { version: 2, modelFingerprint: fingerprint, log: head as `sha256:${string}` } });
    const hash = hashObject(bytes) as ObjectHash;
    s.objects.set(hash, bytes);
    return hash;
  };
  const at = (name: string, directory: ObjectHash): ProtocolDirectoryEntry => ({ name, directory });
  const steady = collection(log(1));
  const before = s.dir([
    at("kept", steady), at("moved", collection(log(2))), at("nested", s.dir([at("inner", collection(log(3)))])), at("gone", collection(log(4))),
  ]);
  const after = s.dir([
    at("added", collection(log(5))), at("kept", steady),
    at("moved", collection(log(6), [{ name: "note.md", file: s.file("n"), created: 0, modified: 0 }])),
    at("nested", s.dir([at("inner", collection(log(7)))])),
  ]);
  const paths = (folders: string[][]) => folders.map((names) => `/${names.join("/")}`);
  const walked = paths(await changedCollectionFolders(before, after, s.load));
  expect(walked).toEqual(["/added", "/moved", "/nested/inner"]);
  expect((await entryChanges(before, after, s.load)).collections).toEqual(walked);
  expect((await entryChanges(null, after, s.load)).collections).toEqual(paths(await changedCollectionFolders(null, after, s.load)));
});
