import { expect, test } from "bun:test";
import { Mailbox } from "../../../packages/overstoryd/src/mailbox.ts";

test("work takes turns in arrival order, and low-priority work waits for normal work that arrives after it", async () => {
  const mailbox = new Mailbox();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const depths: number[] = [];
  const first = mailbox.run(async () => { order.push("first"); await gate; });
  const low = mailbox.run(async () => { order.push("snapshot"); }, { priority: "low", waited: (depth) => depths.push(depth) });
  const second = mailbox.run(async () => { order.push("second"); }, { waited: (depth) => depths.push(depth) });
  const third = mailbox.run(async () => { order.push("third"); });
  expect(mailbox.depth).toBe(3);
  release();
  await Promise.all([first, low, second, third]);
  expect(order).toEqual(["first", "second", "third", "snapshot"]);
  expect(depths).toEqual([2, 1]);
  expect(mailbox.idle).toBe(true);
});

test("a failed turn passes the turn on", async () => {
  const mailbox = new Mailbox();
  const failed = mailbox.run(async () => { throw new Error("no"); });
  const next = mailbox.run(async () => "ran");
  await expect(failed).rejects.toThrow("no");
  expect(await next).toBe("ran");
  expect(mailbox.idle).toBe(true);
});
