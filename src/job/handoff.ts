export interface Handoff<Offered, Resumed> {
  /** Hand over one value and suspend until resumed. Rejects with the Job's cancellation reason. */
  offer(value: Offered): Promise<Resumed>;
}

export interface OwnedHandoff {
  readonly offered: boolean;
  release(reason: unknown): void;
  settle(failure: unknown): void;
}

/** The Job whose cancellation state an offer consults before suspending. */
export interface CancellationOwner {
  recheckCancellation(): void;
}

export class HandoffState<Offered, Resumed> implements Handoff<Offered, Resumed>, OwnedHandoff {
  private readonly value = Promise.withResolvers<Offered>();
  private readonly answer = Promise.withResolvers<Resumed>();
  /** @internal Set by HandoffJob before activation. */
  owner: CancellationOwner | undefined;
  offered = false;
  private resumed = false;
  private received = false;
  private released = false;
  private releaseReason: unknown;

  offer(value: Offered): Promise<Resumed> {
    if (this.offered) {
      throw new TypeError("Handoff.offer() may only be called once.");
    }
    // A source that already aborted releases this handoff before the body suspends;
    // a later abort reaches it only through the Job's own cancellation.
    this.owner?.recheckCancellation();
    this.offered = true;
    this.value.resolve(value);
    if (this.released) {
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

  settle(failure: unknown): void {
    this.offered = true;
    this.value.reject(failure);
    if (!this.received) {
      void this.value.promise.catch(() => {});
    }
  }
}
