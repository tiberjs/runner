import { addAbortListener } from "node:events";
import { scheduleDeadline } from "./deadline.js";

/** Incoming cancellation resources, released only when their owner has drained. */
export class CancellationBindings implements Disposable {
  private links: Map<AbortSignal, Disposable | undefined> | undefined;
  private timer: Disposable | undefined;

  link(source: AbortSignal, onAbort: (reason: unknown) => void): void {
    const links = (this.links ??= new Map());
    if (links.has(source)) {
      return;
    }
    if (source.aborted) {
      links.set(source, undefined);
      onAbort(source.reason);
      return;
    }

    let delivered = false;
    const deliver = (): void => {
      if (!delivered) {
        delivered = true;
        onAbort(source.reason);
      }
    };
    const subscription = addAbortListener(source, deliver);
    links.set(source, subscription);
    // Listener installation can itself reenter source cancellation.
    if (source.aborted) {
      deliver();
    }
  }

  deadline(at: number, onElapsed: () => void): void {
    this.timer = scheduleDeadline(at, onElapsed);
  }

  [Symbol.dispose](): void {
    this.timer?.[Symbol.dispose]();
    this.timer = undefined;
    for (const subscription of this.links?.values() ?? []) {
      subscription?.[Symbol.dispose]();
    }
    this.links = undefined;
  }
}
