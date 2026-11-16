import { expect, test } from "bun:test";
import type { AcceptedUpdate } from "@ovst/protocol";
import { ChangeFeed, type ChangeRecord } from "../../../packages/overstoryd/src/change-feed.ts";

const record = (ordinal: number, tree = "tr_a"): ChangeRecord =>
  ({ ordinal, update: { id: String(ordinal), tree, root: `sha256:${String(ordinal).padStart(64, "0")}` } as unknown as AcceptedUpdate });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("listeners run as a record is published; a consumer takes what it fell behind on as one batch", async () => {
  const feed = new ChangeFeed();
  const heard: number[] = [], batches: number[][] = [];
  feed.listen((r) => heard.push(r.ordinal));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const consumer = feed.consume("test", async (batch) => { batches.push(batch.map((r) => r.ordinal)); if (batches.length === 1) await gate; }, { onFailure: "skip" });
  for (const ordinal of [1, 2, 3, 4]) feed.publish(record(ordinal));
  expect(heard).toEqual([1, 2, 3, 4]);
  // The first batch is in progress; the three published meanwhile wait and arrive together.
  const caughtUp = consumer.caughtUp();
  release();
  await caughtUp;
  expect(batches).toEqual([[1], [2, 3, 4]]);
  expect(consumer.cursor).toBe(4);
  expect(consumer.lag).toBe(0);
  await feed.dispose();
});

test("a consumer that fails resumes from its cursor, and readers wait until it has the record", async () => {
  const feed = new ChangeFeed();
  const seen: number[][] = [];
  let failures = 1;
  const consumer = feed.consume("retrying", async (batch) => {
    seen.push(batch.map((r) => r.ordinal));
    if (failures-- > 0) throw new Error("not yet");
  }, { onFailure: "retry" });
  feed.publish(record(1));
  const reached = consumer.reached(1);
  let done = false;
  void reached.then(() => { done = true; });
  await settle();
  expect(done).toBe(false);
  await reached;
  expect(seen).toEqual([[1], [1]]);
  await feed.dispose();
});

test("a skipping consumer moves past a failed batch; a matching consumer sees only its records but keeps pace", async () => {
  const feed = new ChangeFeed();
  const skipped: number[] = [], matched: number[] = [];
  const skipping = feed.consume("skipping", async (batch) => { skipped.push(...batch.map((r) => r.ordinal)); throw new Error("broken"); }, { onFailure: "skip" });
  const tree = feed.consume("tree b", async (batch) => { matched.push(...batch.map((r) => r.ordinal)); }, { onFailure: "skip", match: (r) => r.update.tree === "tr_b" });
  const error = console.error; console.error = () => {};
  try {
    feed.publish(record(1)); feed.publish(record(2, "tr_b")); feed.publish(record(3));
    await Promise.all([skipping.caughtUp(), tree.caughtUp()]);
  } finally { console.error = error; }
  expect(skipping.cursor).toBe(3);
  expect(tree.cursor).toBe(3);
  expect(matched).toEqual([2]);
  await feed.dispose();
});

test("a consumer started from an earlier ordinal receives the records after it", async () => {
  const feed = new ChangeFeed();
  feed.publish(record(5));
  const got: number[] = [];
  const consumer = feed.consume("late", async (batch) => { got.push(...batch.map((r) => r.ordinal)); }, { onFailure: "skip", from: 4 });
  consumer.wake();
  await consumer.caughtUp();
  expect(got).toEqual([5]);
  await feed.dispose();
});
