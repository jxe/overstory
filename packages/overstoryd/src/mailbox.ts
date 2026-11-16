/**
 * Performance 010: a turn-taking queue. Work runs one at a time, in arrival
 * order within a priority; `low` work (the host's own updates, such as a
 * collection snapshot) waits while any `normal` work (a client's update) is
 * waiting. It reports how deep it was and how long the work waited.
 */
export type MailboxPriority = "normal" | "low";

interface Letter {
  priority: MailboxPriority;
  start: () => void;
}

export class Mailbox {
  private busy = false;
  private readonly waiting: Letter[] = [];

  /** Work waiting for its turn, not counting the one running. */
  get depth(): number {
    return this.waiting.length;
  }

  get idle(): boolean {
    return !this.busy && this.waiting.length === 0;
  }

  /** Run `work` in its turn. `waited` is told how deep the mailbox was on arrival and how long the work waited. */
  async run<T>(work: () => Promise<T>, options: { priority?: MailboxPriority; waited?: (depth: number, ms: number) => void } = {}): Promise<T> {
    const depth = this.waiting.length + (this.busy ? 1 : 0);
    const arrived = performance.now();
    if (this.busy) await new Promise<void>((start) => this.enqueue({ priority: options.priority ?? "normal", start }));
    else this.busy = true;
    options.waited?.(depth, performance.now() - arrived);
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next.start();
      else this.busy = false;
    }
  }

  private enqueue(letter: Letter): void {
    if (letter.priority === "low") { this.waiting.push(letter); return; }
    // Normal work goes ahead of every low letter, behind normal ones.
    const at = this.waiting.findIndex((waiting) => waiting.priority === "low");
    if (at < 0) this.waiting.push(letter);
    else this.waiting.splice(at, 0, letter);
  }
}
