import { addAbortListener } from "node:events";

export type OverflowPolicy = "drop-oldest" | "drop-newest" | "error";

interface Receiver<T> {
  resolve(value: IteratorResult<T, void>): void;
  reject(error: unknown): void;
  registration?: Disposable;
}

/** A bounded, single-delivery queue; it owns no execution or cancellation source. */
export class Channel<T> {
  private readonly values: (T | undefined)[] = [];
  private head = 0;
  private size = 0;
  private receivers: Set<Receiver<T>> | undefined;
  private closed = false;
  private failed = false;
  private error: unknown;

  constructor(
    private readonly capacity: number,
    private readonly overflow: OverflowPolicy,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 0xffff_ffff) {
      throw new RangeError("FlexJob buffer capacity must be an integer between 1 and 4294967295.");
    }

    if (overflow !== "drop-oldest" && overflow !== "drop-newest" && overflow !== "error") {
      throw new TypeError("Unknown FlexJob overflow policy.");
    }
  }

  publish(value: T): void {
    if (this.closed) {
      throw new TypeError("Cannot publish to a closed channel.");
    }

    const receiver = this.receivers?.values().next().value;
    if (receiver) {
      this.receivers!.delete(receiver);
      receiver.registration?.[Symbol.dispose]();
      receiver.resolve({ done: false, value });
      return;
    }

    if (this.size === this.capacity) {
      switch (this.overflow) {
        case "drop-newest":
          return;
        case "error":
          throw new RangeError("FlexJob publication buffer is full.");
        case "drop-oldest":
          this.values[this.head] = value;
          this.head = (this.head + 1) % this.capacity;
          return;
      }
    }

    this.values[(this.head + this.size) % this.capacity] = value;
    this.size++;
  }

  receive(signal?: AbortSignal): Promise<IteratorResult<T, void>> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.failed) {
      return Promise.reject(this.error);
    }

    if (this.size > 0) {
      const value = this.values[this.head] as T;
      this.values[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.size--;
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<T, void>>();
    const receiver: Receiver<T> = { resolve, reject };
    (this.receivers ??= new Set()).add(receiver);

    if (signal) {
      receiver.registration = addAbortListener(signal, () => {
        this.receivers!.delete(receiver);
        receiver.registration?.[Symbol.dispose]();
        reject(signal.reason);
      });
    }

    return promise;
  }

  /** Stop publication; successful completion preserves values not yet received. */
  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const receiver of this.receivers ?? []) {
      receiver.registration?.[Symbol.dispose]();
      receiver.resolve({ done: true, value: undefined });
    }
    this.receivers?.clear();
  }

  /** Failure discards stale progress and releases all receivers, including late ones. */
  fail(error: unknown): void {
    this.closed = true;
    this.failed = true;
    this.error = error;

    this.values.length = 0;
    this.head = 0;
    this.size = 0;

    for (const receiver of this.receivers ?? []) {
      receiver.registration?.[Symbol.dispose]();
      receiver.reject(error);
    }
    this.receivers?.clear();
  }
}
