/** Diagnostic: K writers, each editing its own tree at once, through a
 * disposable in-process host. Shows what concurrent updates on different
 * trees cost in syncs: with group commit, edits that arrive while a sync runs
 * share the next one. Model Railway's disk with the fsync-delay shim:
 *
 *   gcc -shared -fPIC -o /tmp/fsdelay.so fsdelay.c -ldl
 *   LD_PRELOAD=/tmp/fsdelay.so TREES=8 N=30 bun tests/performance/concurrent-trees-cost.ts
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { resolveSnapshot, snapshotDirectory } from "@ovst/fs";
import { decodeProtocolDirectory, executeExactSourceEdits, type ObjectHash, type SourceOperation } from "@ovst/protocol";
import { deviceClient, testAccount } from "../helpers/devices.ts";
import { hostTree, readTreeConfig } from "../helpers/tree-config.ts";

const trees = Number(process.env.TREES ?? 8), n = Number(process.env.N ?? 30);
const TEST_AT = Date.UTC(2026, 10, 16), TEST_TIME = new Date(TEST_AT).toISOString();
const dir = await mkdtemp(join(tmpdir(), "story-concurrent-trees-"));
const lines: Array<{ total: number; fsyncs: number; lockWait: number }> = [];
const log = console.log;
console.log = (...args: unknown[]) => {
  const text = args.map(String).join(" ");
  if (!text.includes('"event":"update"')) return log(...args);
  const line = JSON.parse(text) as { total: number; fsyncs: number; "lock-wait": number; status: number };
  if (process.env.PHASES) log(text);
  if (line.status === 201) lines.push({ total: line.total, fsyncs: line.fsyncs, lockWait: line["lock-wait"] });
};
const running = await serveHost({ dataRoot: join(dir, "host"), accounts: [testAccount("owner", "cost", { communityWriter: true })],
  publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
const client = await deviceClient(running.url, "cost");
const profile = (await client.account()).account.profileTree!;
await readTreeConfig(client, profile, "person");
const folder = join(dir, "seed");
await mkdir(folder, { recursive: true });
await writeFile(join(folder, "note.md"), "# Note\n\nseed\n");
const seed = await resolveSnapshot(await snapshotDirectory(folder));
const ids: string[] = [];
for (let index = 0; index < trees; index++) ids.push(await hostTree(client, seed, { parent: { tree: profile, name: `t${index}`, kind: "person" } }));
lines.length = 0;
// The host's own count of journal syncs: a request's `fsyncs` also counts syncs it shared.
const syncs = () => (running.overstoryd as unknown as { objects: { packs: { syncs: number } } }).objects.packs.syncs;
const syncsBefore = syncs();

/** One writer: n traced one-character edits to its tree's page, each waiting for the last. */
async function writer(tree: string) {
  const head = await client.descriptor(tree);
  let root = head.tree.root as ObjectHash, update = head.tree.update;
  const objects = new Map<ObjectHash, Uint8Array>((await client.snapshot(tree, root)).objects as Map<ObjectHash, Uint8Array>);
  const ms: number[] = [];
  for (let index = 0; index < n; index++) {
    const page = decodeProtocolDirectory(objects.get(root)!).entries.find((entry) => entry.name === "note.md")!.page!;
    const operations = [{ key: "edit", kind: "editSource", source: { material: { kind: "basis", path: "/note.md", object: page }, range: [0, 0] }, text: "x" } as SourceOperation];
    const executed = await executeExactSourceEdits(root, operations, async (hash) => objects.get(hash)!, TEST_AT);
    for (const [hash, bytes] of executed.generated) objects.set(hash, bytes);
    const started = performance.now();
    const result = await client.submitUpdates(tree, { base: update, updates: [{ at: TEST_TIME, change: crypto.randomUUID(), candidate: executed.root,
      trace: [{ before: root, after: executed.root, operations }], resolves: [], deltas: [], objects: [...executed.generated].map(([hash, bytes]) => ({ hash, bytes })) }] });
    ms.push(performance.now() - started);
    ({ id: update, root } = result.results[0]!.update as { id: string; root: ObjectHash });
  }
  return ms;
}

const started = performance.now();
const ms = (await Promise.all(ids.map(writer))).flat().sort((a, b) => a - b);
const elapsed = performance.now() - started;
const fsyncs = syncs() - syncsBefore;
const quantile = (q: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * q))]!);
log(JSON.stringify({ trees, n, updates: ms.length, median: quantile(0.5), p90: quantile(0.9), updatesPerSecond: Math.round(ms.length / (elapsed / 1000)),
  syncsPerUpdate: Number((fsyncs / ms.length).toFixed(2)) }));
running.server.stop(true);
await running.overstoryd[Symbol.asyncDispose]();
await rm(dir, { recursive: true, force: true });
process.exit(0);
