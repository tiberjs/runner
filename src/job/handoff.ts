import type { JobResult } from "./job.js";

/** The body's side of a one-shot, two-way rendezvous. */
export interface Handoff<Offered, Resumed> {
  /**
   * Hand over the single value and suspend until the consumer resumes it.
   *
   * Rejects with the Job's cancellation reason when the Job is cancelled
   * while suspended, or is already cancelled when the offer is made.
   */
  offer(value: Offered): Promise<Resumed>;
}

/** What a Job needs from its rendezvous: offer bookkeeping plus release on cancellation and closure. */
export interface OwnedHandoff {
  readonly hasOffered: boolean;
  release(reason: unknown): void;
  settle(result: JobResult<unknown>): void;
}

/** Rendezvous state owned by one HandoffJob: no Job, signal, queue, or hidden work. */
export class HandoffState<Offered, Resumed> implements Handoff<Offered, Resumed> {
  private readonly offered = Promise.withResolvers<Offered>();
  private readonly resumed = Promise.withResolvers<Resumed>();
  private offering = false;
  private resuming = false;
  private observed = false;
  private released = false;
  private releaseReason: unknown;

  get hasOffered(): boolean {
    return this.offering;
  }

  offer(value: Offered): Promise<Resumed> {
    if (this.offering) {
      throw new TypeError("Handoff.offer() may only be called once.");
    }
    this.offering = true;
    this.offered.resolve(value);
    if (this.released) {
      // The consumer still receives the answer; the body is not kept waiting for it.
      this.resumed.reject(this.releaseReason);
    }
    return this.resumed.promise;
  }

  receive(): Promise<Offered> {
    this.observed = true;
    return this.offered.promise;
  }

  resume(value: Resumed): void {
    if (this.resuming) {
      throw new TypeError("Handoff.resume() may only be called once.");
    }
    this.resuming = true;
    this.resumed.resolve(value);
  }

  /** Cancellation: release a body suspended in `offer()`, now or when it offers. */
  release(reason: unknown): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.releaseReason = reason;
    if (this.offering) {
      this.resumed.reject(reason);
    }
  }

  /** Closure: a Job that closed without offering answers its consumer with its failure. */
  settle(result: JobResult<unknown>): void {
    if (this.offering) {
      return;
    }
    this.offering = true;
    this.offered.reject(
      result.ok ? new TypeError("HandoffJob closed without offering a value.") : result.error,
    );
    if (!this.observed) {
      void this.offered.promise.catch(() => {});
    }
  }
}
