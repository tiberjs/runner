import { linkAbort } from "./abort.js";
import { scheduleDeadline } from "./deadline.js";

/** Incoming cancellation registrations, released only when their owner has drained. */
export class CancellationBindings implements Disposable {
  private links: Map<AbortSignal, () => void> | undefined;
  private timer: Disposable | undefined;

  link(source: AbortSignal, onAbort: (reason: unknown) => void): void {
    if (this.links?.has(source)) {
      return;
    }
    (this.links ??= new Map()).set(source, linkAbort(source, onAbort));
  }

  deadline(at: number, onElapsed: () => void): void {
    this.timer = scheduleDeadline(at, onElapsed);
  }

  [Symbol.dispose](): void {
    this.timer?.[Symbol.dispose]();
    this.timer = undefined;
    for (const unlink of this.links?.values() ?? []) {
      unlink();
    }
    this.links = undefined;
  }
}
