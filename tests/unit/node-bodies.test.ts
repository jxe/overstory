// Data model §8: which entry supplies a node's body, from the shared vectors
// (docs/overstory-spec/conformance/node-bodies.json) that Swift ports too.
import { expect, test } from "bun:test";
import { canonicalNodePath, encodeProtocolDirectory, encodeProtocolPage, hashObject, parsePage, resolveProtocolLogicalNode, type ObjectHash, type ProtocolDirectoryEntry } from "@ovst/protocol";

const vectors = await Bun.file(new URL("../../docs/overstory-spec/conformance/node-bodies.json", import.meta.url)).json();
const objects = new Map<ObjectHash, Uint8Array>();
const put = (bytes: Uint8Array) => { const hash = hashObject(bytes) as ObjectHash; objects.set(hash, bytes); return hash; };
function directory(value: Record<string, unknown>): ObjectHash {
  const entries: ProtocolDirectoryEntry[] = [];
  for (const [name, item] of Object.entries(value)) {
    if (name === "collection") continue;
    if (typeof item === "object") entries.push({ name, directory: directory(item as Record<string, unknown>) });
    else if (name.endsWith(".md")) entries.push({ name, page: put(encodeProtocolPage(parsePage(new TextEncoder().encode(item as string))!)), created: 0, modified: 0 });
    else entries.push({ name, file: put(new TextEncoder().encode(item as string)), created: 0, modified: 0 });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const collection = value.collection ? { collection: { version: 2 as const, modelFingerprint: `sha256:${"a".repeat(64)}` as const, log: `sha256:${"b".repeat(64)}` as const } } : {};
  return put(encodeProtocolDirectory({ type: "directory", entries, ...collection }));
}
const root = directory(vectors.tree);

test.each(vectors.nodes as Array<Record<string, any>>)("node $path", async (c) => {
  const node = await resolveProtocolLogicalNode(root, c.path, async (hash) => objects.get(hash)!);
  if (c.node === null) { expect(node).toBeNull(); return; }
  expect(node?.kind).toBe(c.kind);
  if (c.objectName) expect(node!.objectName).toBe(c.objectName);
  expect(node!.bodyName).toBe(c.bodyName);
  expect(node!.bodyOrigin).toBe(c.bodyOrigin);
  const diagnostics = [...(node!.shadowedBody ? ["shadowed-body"] : []), ...(node!.duplicateRepresentation ? ["duplicate-node-representation"] : [])];
  expect(diagnostics).toEqual(c.diagnostics);
});

test.each(vectors.canonical as Array<{ spelling: string; node: string }>)("$spelling names $node", ({ spelling, node }) => {
  expect(canonicalNodePath(spelling)).toBe(node);
});
