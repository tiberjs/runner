import { combinedError } from "../errors.js";

/** Recorded failures and aggregate identities already represented by those failures. */
export class FailureSet {
  private errors: unknown[] | undefined;
  private combined: unknown;
  private remembered: Set<unknown> | undefined;

  constructor(private readonly message: string) {}

  get size(): number {
    return this.errors?.length ?? 0;
  }

  get value(): unknown {
    return this.combined;
  }

  hasRecorded(error: unknown): boolean {
    return this.errors?.some((known) => Object.is(known, error)) ?? false;
  }

  recognizes(error: unknown): boolean {
    return this.remembered?.has(error) === true || this.hasRecorded(error);
  }

  /** Record a new failure after the caller has checked recognition and its own policy. */
  record(error: unknown): void {
    (this.errors ??= []).push(error);
    this.combined = combinedError(this.errors, this.message);
  }

  remember(error: unknown): void {
    (this.remembered ??= new Set()).add(error);
  }

  combinedWith(error: unknown, message: string): unknown {
    return combinedError([error, ...(this.errors ?? [])], message);
  }
}
