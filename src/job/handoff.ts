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
  readonly offered: boolean;
  release(reason: unknown): void;
  settle(failure: unknown): void;
}

/** Rendezvous state owned by one HandoffJob: no Job, signal, queue, or hidden work. */
export class HandoffState<Offered, Resumed> implements Handoff<Offered, Resumed>, OwnedHandoff {
  private readonly value = Promise.withResolvers<Offered>();
  private readonly answer = Promise.withResolvers<Resumed>();
  offered = false;
  private resumed = false;
  private received = false;
  private released = false;
  private releaseReason: unknown;

  offer(value: Offered): Promise<Resumed> {
    if (this.offered) {
      throw new TypeError("Handoff.offer() may only be called once.");
    }
    this.offered = true;
    this.value.resolve(value);
    if (this.released) {
      // The consumer still receives the answer; the body is not kept waiting for it.
      this.answer.reject(this.releaseReason);
    }
    return this.answer.promise;
  }

  receive(): Promise<Offered> {
    this.received = true;
    return this.value.promise;
  }

  resume(value: Resumed): void {
    if (this.resumed) {
      throw new TypeError("Handoff.resume() may only be called once.");
    }
    this.resumed = true;
    this.answer.resolve(value);
  }

  /** Cancellation: release a body suspended in `offer()`, now or when it offers. */
  release(reason: unknown): void {
    if (this.released) {
      return;
    }
    this.released = true;
    this.releaseReason = reason;
    if (this.offered) {
      this.answer.reject(reason);
    }
  }

  /** Closure without an offer: the consumer receives the Job's failure instead. */
  settle(failure: unknown): void {
    this.offered = true;
    this.value.reject(failure);
    if (!this.received) {
      void this.value.promise.catch(() => {});
    }
  }
}
