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
 * Owns the lifecycle of the concurrent tasks belonging to an execution
 * (architecture §7). On close the group cancels remaining tasks, then joins
 * them: `cancel → join → finish`.
 *
 * Structured concurrency guarantee: a genuine failure from a task that nobody
 * awaited is not silently swallowed — it is surfaced at the scope boundary
 * (request → 500, timeout → throw). Awaited tasks are plain promises: their
 * failure belongs to the awaiter and never re-surfaces here.
 */
export class TaskGroup {
  // Lazily allocated: a request that never forks pays only for this object,
  // not a Set + array. `fork()` is uncommon relative to total requests.
  private tasks: Set<Task<unknown>> | null = null;
  private failures: Array<{
    readonly task: Task<unknown>;
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
   * {@link fork} at throw time so the classification is race-free. Whether it
   * surfaces is decided at scope close, based on whether the task was observed.
   */
  reportFailure(task: Task<unknown>, reason: unknown): void {
    (this.failures ??= []).push({ task, reason });
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
    return this.failures?.some((failure) => !failure.task.observed) ?? false;
  }

  /** Unobserved failures, preserving every cause when several tasks fail. */
  get failure(): unknown {
    let errors: unknown[] | undefined;
    for (const failure of this.failures ?? []) {
      if (!failure.task.observed) {
        (errors ??= []).push(failure.reason);
      }
    }

    return errors ? combinedError(errors, "Concurrent tasks failed.") : undefined;
  }

  get size(): number {
    return this.tasks?.size ?? 0;
  }
}
