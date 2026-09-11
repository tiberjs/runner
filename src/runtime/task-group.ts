import { combinedError } from "../lifecycle/errors.js";

interface FulfilledOutcome<T> {
  readonly status: "fulfilled";
  readonly value: T;
}
interface RejectedOutcome {
  readonly status: "rejected";
  readonly reason: unknown;
}
type TaskOutcome<T> = FulfilledOutcome<T> | RejectedOutcome;

/**
 * A managed unit of concurrent work started by {@link fork}. A Task is awaitable
 * and carries its own {@link AbortSignal} derived from the parent execution.
 */
export class Task<T> implements PromiseLike<T> {
  private readonly promise: Promise<T>;
  private readonly controller: AbortController;
  private readonly outcomePromise: Promise<TaskOutcome<T>>;
  private wasObserved = false;
  private observationListeners: Set<() => void> | undefined;

  constructor(promise: Promise<T>, controller: AbortController) {
    this.promise = promise;
    this.controller = controller;

    // Observe settlement without ever rejecting, so an un-awaited task never
    // triggers an unhandled-rejection and can be joined safely. This internal
    // handler does NOT mark the task observed — only user awaits do.
    this.outcomePromise = promise.then(
      (value): TaskOutcome<T> => ({ status: "fulfilled", value }),
      (reason): TaskOutcome<T> => ({ status: "rejected", reason }),
    );
  }

  // oxlint-disable-next-line unicorn/no-thenable -- Task deliberately implements PromiseLike; awaiting transfers ownership of its outcome.
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    // Awaiting/chaining a task means its outcome is owned by the caller.
    this.wasObserved = true;
    const listeners = this.observationListeners;
    this.observationListeners = undefined;
    if (listeners) {
      for (const listener of listeners) {
        listener();
      }
    }
    return this.promise.then(onfulfilled, onrejected);
  }

  /** This task's cancellation signal (a child of the parent execution). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether anyone awaited/chained this task (owns its result/error). */
  get observed(): boolean {
    return this.wasObserved;
  }

  /** @internal Release retained ownership when this task is first awaited/chained. */
  onObserved(listener: () => void): void {
    if (this.wasObserved) {
      listener();
      return;
    }
    (this.observationListeners ??= new Set()).add(listener);
  }

  /** Request cancellation of this task. */
  cancel(reason?: unknown): void {
    this.controller.abort(reason);
  }

  /** @internal Resolves with the settled outcome; never rejects (for join). */
  outcome(): Promise<TaskOutcome<T>> {
    return this.outcomePromise;
  }
}

/**
 * Owns concurrent tasks until an execution boundary closes.
 *
 * Closing cancels and joins active tasks. A failure from a task that was never
 * awaited is surfaced at the boundary; an awaited task leaves error handling to
 * its awaiter.
 */
export class TaskGroup {
  // Avoid allocating task bookkeeping for executions that never fork.
  private tasks: Set<Task<unknown>> | null = null;
  private failures: Set<{
    readonly reason: unknown;
  }> | null = null;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private failureListeners: Set<() => void> | undefined;

  /** @internal Observe unowned failures without changing sibling cancellation. */
  onFailure(listener: () => void): () => void {
    (this.failureListeners ??= new Set()).add(listener);
    if (this.failed) {
      queueMicrotask(() => {
        if (this.failureListeners?.has(listener) && this.failed) {
          listener();
        }
      });
    }

    return () => this.failureListeners?.delete(listener);
  }

  /** @internal Reject work submitted after the execution boundary closed. */
  assertOpen(): void {
    if (this.closing) {
      throw new Error("TaskGroup is closed.");
    }
  }

  add(task: Task<unknown>): void {
    this.assertOpen();
    (this.tasks ??= new Set()).add(task);
    void task.outcome().then(() => {
      this.tasks?.delete(task);
    });
  }

  /**
   * Record a genuine (non-cancellation) failure from a member task. Called by
   * {@link fork} at throw time so the classification is race-free. Only unobserved
   * failures are retained; observing a task releases its failure immediately.
   */
  reportFailure(task: Task<unknown>, reason: unknown): void {
    if (task.observed) {
      return;
    }
    const failures = (this.failures ??= new Set());
    const failure = { reason };
    failures.add(failure);
    task.onObserved(() => {
      failures.delete(failure);
    });
    if (this.failureListeners?.size) {
      queueMicrotask(() => {
        if (this.failed) {
          for (const listener of this.failureListeners ?? []) {
            listener();
          }
        }
      });
    }
  }

  cancel(reason?: unknown): void {
    if (!this.tasks) {
      return;
    }

    for (const task of this.tasks) {
      task.cancel(reason);
    }
  }

  async join(): Promise<void> {
    if (!this.tasks) {
      return;
    }

    let pending = [...this.tasks];
    while (pending.length > 0) {
      await Promise.all(pending.map((task) => task.outcome()));
      pending = this.tasks ? [...this.tasks] : [];
    }
  }

  close(reason?: unknown): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closing = true;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.closePromise = promise;

    this.cancel(reason);
    void this.join().then(resolve, reject);

    return promise;
  }

  /** Whether an un-awaited member task failed with a genuine error. */
  get failed(): boolean {
    return (this.failures?.size ?? 0) > 0;
  }

  /** Unobserved failures, preserving every cause when several tasks fail. */
  get failure(): unknown {
    let errors: unknown[] | undefined;
    for (const failure of this.failures ?? []) {
      (errors ??= []).push(failure.reason);
    }

    return errors ? combinedError(errors, "Concurrent tasks failed.") : undefined;
  }

  get size(): number {
    return this.tasks?.size ?? 0;
  }
}
