import { ContextFrame } from "../context/frame.js";
import type { ContextEntry } from "../context/key.js";
import { activeScope } from "../di/active-scope.js";
import type { Scope } from "../di/scope.js";
import { begin, execute } from "../runtime/execution.js";
import { fork } from "../runtime/fork.js";
import { currentState, runWith, type RuntimeState } from "../runtime/state.js";
import type { Task } from "../runtime/task-group.js";
import { LifecycleStateError, setWaitingFor, withoutDependencies } from "./diagnostics.js";

/** Only explicitly supplied values cross into a background execution. */
export interface BackgroundSeed {
  readonly values?: ContextFrame | readonly ContextEntry[];
}

type Handler<T> = () => T | Promise<T>;

/**
 * Owns process-local executions independently of their submitting execution.
 * The supplied scope is borrowed; every task owns and disposes a child of it.
 */
export class TaskSupervisor implements AsyncDisposable {
  #owner: RuntimeState | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;

  /** The optional admission gate runs before each handler (for application startup). */
  constructor(
    private readonly scope: Scope,
    private readonly admit?: () => void | Promise<void>,
  ) {}

  /** Start an isolated execution; its Task settles only after child work and resource cleanup. */
  run<T>(handler: Handler<T>): Task<T>;
  run<T>(seed: BackgroundSeed, handler: Handler<T>): Task<T>;
  run<T>(seedOrHandler: BackgroundSeed | Handler<T>, suppliedHandler?: Handler<T>): Task<T> {
    if (this.#closing) {
      throw new LifecycleStateError("TaskSupervisor", "run", this.#closed ? "closed" : "closing");
    }
    const handler = typeof seedOrHandler === "function" ? seedOrHandler : suppliedHandler;
    if (typeof handler !== "function") {
      throw new TypeError("TaskSupervisor.run() requires a handler.");
    }
    const entries = typeof seedOrHandler === "function" ? undefined : seedOrHandler.values;
    // Materialize before admission: callers may reuse or mutate the binding list.
    const values =
      entries === undefined
        ? ContextFrame.empty
        : entries instanceof ContextFrame
          ? entries
          : ContextFrame.from(entries);
    // Getters and binding iterators can reenter close() during materialization.
    if (this.#closing) {
      throw new LifecycleStateError("TaskSupervisor", "run", this.#closed ? "closed" : "closing");
    }
    const owner = (this.#owner ??= begin({ scope: this.scope }));

    // Neither a submitting execution nor an active DI construction owns this task.
    return activeScope.exit(() =>
      withoutDependencies(() =>
        runWith(owner, () =>
          fork(async () => {
            const signal = currentState().context.signal;
            // Mark a known gate before invoking it: admission can synchronously
            // start hooks which try to join this very first submission.
            setWaitingFor(this.admit);
            try {
              const admission = this.admit?.();
              if (admission) {
                setWaitingFor(admission);
                await admission;
              }
            } finally {
              setWaitingFor(undefined);
            }
            signal.throwIfAborted();

            const result = await execute({ parentScope: this.scope, signal, values }, handler);
            signal.throwIfAborted();
            return result;
          }),
        ),
      ),
    );
  }

  /** @internal Check a parent barrier before it commits shutdown/admission state. */
  assertCanJoin(operation: string, owner = "TaskSupervisor"): void {
    this.#owner?.tasks.assertCanJoin(operation, owner);
  }

  /**
   * Wait without cancellation, including work admitted while waiting.
   * Unobserved failures remain owned here and surface again on close.
   * Do not await this barrier from a task it must join.
   */
  async flush(): Promise<void> {
    this.assertCanJoin("flush");
    await this.#owner?.tasks.join();
    if (this.#owner?.tasks.failed) {
      throw this.#owner.tasks.failure;
    }
  }

  /**
   * Stop admission, cancel all active tasks, and join their cleanup. Idempotent.
   * Do not await close from a task it must join.
   */
  close(): Promise<void> {
    try {
      this.assertCanJoin("close");
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#closing) {
      return this.#closing;
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#closing = promise;
    void this.#shutdown().then(resolve, reject);
    return promise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #shutdown(): Promise<void> {
    try {
      await this.#owner?.tasks.close();
      if (this.#owner?.tasks.failed) {
        throw this.#owner.tasks.failure;
      }
    } finally {
      this.#closed = true;
    }
  }
}
