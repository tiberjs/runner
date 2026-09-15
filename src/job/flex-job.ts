import { addAbortListener } from "node:events";
import type { ExecutionSeed } from "../execution/context/execution-context.js";
import { Channel } from "./channel.js";
import type { OverflowPolicy } from "./channel.js";
import { Job } from "./job.js";

/** Synchronously send an intermediate value without waiting for a receiver. */
export type Publish<T> = (value: T) => void;

export interface FlexJobOptions {
  readonly capacity?: number;
  readonly overflow?: OverflowPolicy;
  readonly seed?: ExecutionSeed;
}

export interface ReceiveOptions {
  /** Cancels only this receive, never the Job or another receiver. */
  readonly signal?: AbortSignal;
}

type FlexBody<Result, Update> = (publish: Publish<Update>) => Result | PromiseLike<Result>;

/** A Job with a bounded channel for intermediate values, independent of its final result. */
export class FlexJob<Result, Update> extends Job<Result> {
  private readonly channel: Channel<Update>;

  constructor(body: FlexBody<Result, Update>, options: FlexJobOptions = {}) {
    if (typeof body !== "function") {
      throw new TypeError("FlexJob requires a body.");
    }

    const channel = new Channel<Update>(options.capacity ?? 1, options.overflow ?? "drop-oldest");
    super(() => this.runBody(body), options.seed);
    this.channel = channel;

    // Preparation failure and cold close can settle a Job without ever running its body.
    void super.result().then((result) => {
      if (result.ok) {
        channel.close();
      } else {
        channel.fail(result.error);
      }
    });
  }

  private async runBody(body: FlexBody<Result, Update>): Promise<Result> {
    // Observing cancellation releases receivers even if the body itself ignores its signal.
    const signal = this.signal;
    using _registration = addAbortListener(signal, () => {
      this.channel.fail(this.failed ? this.failure : signal.reason);
    });

    const publish: Publish<Update> = (value) => {
      this.recheckCancellation();
      signal.throwIfAborted();
      this.channel.publish(value);
    };

    try {
      return await body(publish);
    } catch (error) {
      this.channel.fail(error);
      throw error;
    } finally {
      this.channel.close();
    }
  }

  static withBuffer<Result, Update>(
    capacity: number,
    body: FlexBody<Result, Update>,
    options: Omit<FlexJobOptions, "capacity"> = {},
  ): FlexJob<Result, Update> {
    return new FlexJob(body, { ...options, capacity });
  }

  /** Consume the next update or channel completion; an optional signal cancels only this wait. */
  receive(options: ReceiveOptions = {}): Promise<IteratorResult<Update, void>> {
    const dependency = this.dependency("receive");
    if (dependency) {
      throw dependency;
    }

    return this.channel.receive(options.signal);
  }
}
