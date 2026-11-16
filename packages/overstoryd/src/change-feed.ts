import type { AcceptedUpdate } from "@ovst/protocol";

/**
 * Performance 010 step 3: one record per accepted update, published once after
 * its commit, and consumers that read the feed at their own pace.
 *
 * Immediate listeners (authorization invalidation, watch streams) run as the
 * record is published. A consumer instead keeps a cursor, takes every record
 * past it as one batch (so a consumer that falls behind coalesces), and moves
 * its cursor once the batch is handled. A failed batch is handed again later
 * from the same cursor, or skipped where the consumer says its work rebuilds
 * itself. No consumer can slow down or fail an update. Cursors are in memory:
 * after a restart each consumer starts at the head, which is right for the
 * host's consumers, whose state rebuilds from the tree on demand.
 */
export interface ChangeRecord {
  /** The accepted update's server-wide position (its id). */
  ordinal: number;
  update: AcceptedUpdate;
  /** The collection folders whose log the update moved, as path names, when acceptance found them. */
  collections?: string[][];
}

export interface ConsumerOptions {
  /** What a failed batch does: `retry` hands it again after a pause; `skip` logs it and moves on. */
  onFailure: "retry" | "skip";
  /** Log a batch that leaves the consumer at least this many records behind, or takes longer than `slowMs`. */
  lagWarning?: number;
  slowMs?: number;
  /** Only records this matches reach the consumer; its cursor still moves past the rest. */
  match?: (record: ChangeRecord) => boolean;
  /** Start after this ordinal instead of at the head. */
  from?: number;
}

/** Records kept beyond what every consumer has passed, so a new consumer and a log of lag have some history. */
const KEEP = 64;
/** Retry pauses after a failed batch, growing to the last. */
const RETRY_MS = [100, 500, 2_000, 10_000];

export class ChangeFeed {
  private records: ChangeRecord[] = [];
  private readonly listeners = new Set<(record: ChangeRecord) => void>();
  private readonly consumers = new Set<FeedConsumer>();
  /** The newest ordinal published. */
  head = 0;
  private disposed = false;

  publish(record: ChangeRecord): void {
    if (this.disposed) return;
    if (record.ordinal <= this.head) return;
    this.head = record.ordinal;
    this.records.push(record);
    for (const listener of [...this.listeners]) {
      try { listener(record); } catch (error) { console.error("overstoryd change-feed listener failed", error); }
    }
    for (const consumer of this.consumers) consumer.wake();
    this.trim();
  }

  /** Run `listener` as each record is published, before any consumer. */
  listen(listener: (record: ChangeRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A consumer that hands `handle` every record past its cursor, starting at the head. */
  consume(name: string, handle: (batch: readonly ChangeRecord[]) => Promise<void>, options: ConsumerOptions): FeedConsumer {
    const consumer = new FeedConsumer(this, name, handle, options);
    this.consumers.add(consumer);
    return consumer;
  }

  /** Records after `cursor`, oldest first. */
  after(cursor: number): ChangeRecord[] {
    let start = this.records.length;
    while (start > 0 && this.records[start - 1]!.ordinal > cursor) start--;
    return this.records.slice(start);
  }

  /** Drop records every consumer has passed, keeping a few. */
  trim(): void {
    let floor = this.head;
    for (const consumer of this.consumers) floor = Math.min(floor, consumer.cursor);
    let drop = 0;
    while (drop < this.records.length - KEEP && this.records[drop]!.ordinal <= floor) drop++;
    if (drop) this.records = this.records.slice(drop);
  }

  /** Stop delivering, and wait for batches in progress. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.consumers].map((consumer) => consumer.stop()));
  }
}

export class FeedConsumer {
  /** The newest ordinal this consumer has handled (or skipped). */
  cursor: number;
  private running: Promise<void> | undefined;
  private waiters: Array<{ ordinal: number; resolve: () => void }> = [];
  private failures = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly feed: ChangeFeed,
    readonly name: string,
    private readonly handle: (batch: readonly ChangeRecord[]) => Promise<void>,
    private readonly options: ConsumerOptions,
  ) {
    this.cursor = options.from ?? feed.head;
  }

  /** How many records this consumer is behind the head. */
  get lag(): number {
    return this.feed.head - this.cursor;
  }

  /** Resolves once the consumer has handled every record published before the call (read-your-writes). */
  caughtUp(): Promise<void> {
    return this.reached(this.feed.head);
  }

  /** Resolves once the cursor is at `ordinal` or past it. */
  reached(ordinal: number): Promise<void> {
    if (this.cursor >= ordinal || this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ ordinal, resolve }));
  }

  wake(): void {
    if (this.stopped || this.running || this.timer) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      // A record published after the drain's last look, before this ran.
      if (!this.stopped && !this.timer && this.cursor < this.feed.head) this.wake();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    this.release(Infinity);
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.cursor < this.feed.head) {
      const records = this.feed.after(this.cursor);
      const through = records.length ? records[records.length - 1]!.ordinal : this.feed.head;
      const batch = this.options.match ? records.filter(this.options.match) : records;
      if (!batch.length) { this.advance(through); continue; }
      const last = through;
      const started = performance.now();
      try {
        await this.handle(batch);
        this.failures = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.options.onFailure === "retry") {
          const pause = RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)]!;
          console.warn(`overstoryd ${this.name}: records ${batch[0]!.ordinal}-${last} failed, retrying in ${pause} ms: ${message}`);
          if (!this.stopped) this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, pause);
          return;
        }
        console.error(`overstoryd ${this.name}: records ${batch[0]!.ordinal}-${last} skipped: ${message}`);
      }
      this.advance(last);
      const ms = performance.now() - started;
      if ((this.options.lagWarning !== undefined && this.lag >= this.options.lagWarning) || (this.options.slowMs !== undefined && ms >= this.options.slowMs))
        console.info(`overstoryd ${this.name}: ${batch.length} records in ${Math.round(ms)} ms, ${this.lag} behind`);
    }
  }

  private advance(ordinal: number): void {
    this.cursor = Math.max(this.cursor, ordinal);
    this.release(this.cursor);
    this.feed.trim();
  }

  private release(through: number): void {
    const ready = this.waiters.filter((waiter) => waiter.ordinal <= through);
    if (!ready.length) return;
    this.waiters = this.waiters.filter((waiter) => waiter.ordinal > through);
    for (const waiter of ready) waiter.resolve();
  }
}
