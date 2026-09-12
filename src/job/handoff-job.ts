import type { ExecutionSeed } from "../execution/context/execution-context.js";
import { HandoffState, type Handoff } from "./handoff.js";
import { Job } from "./job.js";

/**
 * A Job whose body hands one value to a consumer mid-execution and suspends
 * until that consumer answers, while the Job's lifetime still settles only
 * after its body and descendants finish.
 */
export class HandoffJob<Result, Offered, Resumed> extends Job<Result> {
  private readonly rendezvous: HandoffState<Offered, Resumed>;

  constructor(
    body: (handoff: Handoff<Offered, Resumed>) => Result | PromiseLike<Result>,
    seed?: ExecutionSeed,
  ) {
    if (typeof body !== "function") {
      throw new TypeError("HandoffJob requires a body.");
    }
    const rendezvous = new HandoffState<Offered, Resumed>();
    super(() => body(rendezvous), seed);
    this.rendezvous = rendezvous;
    this.attach(rendezvous);
  }

  /**
   * Observe the offered value without joining the Job's descendants.
   *
   * Rejects with the Job's failure when it closes without offering.
   */
  receive(): Promise<Offered> {
    const dependency = this.dependency("receive");
    if (dependency) {
      throw dependency;
    }
    return this.rendezvous.receive();
  }

  /** Answer the offer once. An answer after cancellation released the body is discarded. */
  resume(value: Resumed): void {
    this.rendezvous.resume(value);
  }
}
