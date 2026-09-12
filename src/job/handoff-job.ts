import type { ExecutionSeed } from "../execution/context/execution-context.js";
import { HandoffState, type Handoff } from "./handoff.js";
import { Job } from "./job.js";

/** A Job whose body offers one value mid-execution and suspends until the consumer resumes it. */
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

  /** The offered value, or the Job's failure if it closes without offering. */
  receive(): Promise<Offered> {
    const dependency = this.dependency("receive");
    if (dependency) {
      throw dependency;
    }
    return this.rendezvous.receive();
  }

  resume(value: Resumed): void {
    this.rendezvous.resume(value);
  }
}
