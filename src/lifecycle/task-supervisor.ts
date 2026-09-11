import { ContextFrame } from "../context/frame.js";
import type { ContextEntry } from "../context/key.js";
import { activeScope } from "../di/active-scope.js";
import type { Scope } from "../di/scope.js";
import { begin, execute } from "../runtime/execution.js";
import { fork } from "../runtime/fork.js";
import { currentState, runWith, type RuntimeState } from "../runtime/state.js";
import type { Task } from "../runtime/task-group.js";
import { combinedError } from "./errors.js";

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
      throw new Error("Task supervisor is closed.");
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
    const owner = (this.#owner ??= begin({ scope: this.scope }));

    // Neither a submitting execution nor an active DI construction owns this task.
    return activeScope.exit(() =>
      runWith(owner, () =>
        fork(async () => {
          const signal = currentState().context.signal;
          const admission = this.admit?.();
          if (admission) {
            await admission;
          }
          signal.throwIfAborted();

          const scope = this.scope.child();
          let state: RuntimeState | undefined;
          let result!: T;
          let errors: unknown[] | undefined;
          try {
            result = await execute({ scope, signal, values }, () => {
              state = currentState();
              return handler();
            });
          } catch (error) {
            (errors ??= []).push(error);
          }

          try {
            // execute() joins descendants but leaves its supplied scope to us.
            await activeScope.exit(() =>
              state
                ? runWith(state, () => scope[Symbol.asyncDispose]())
                : scope[Symbol.asyncDispose](),
            );
          } catch (error) {
            (errors ??= []).push(error);
          }
          if (errors) {
            throw combinedError(errors, "Background execution and cleanup failed.");
          }
          signal.throwIfAborted();
          return result;
        }),
      ),
    );
  }

  /**
   * Wait without cancellation, including work admitted while waiting.
   * Unobserved failures remain owned here and surface again on close.
   * Do not await this barrier from a task it must join.
   */
  async flush(): Promise<void> {
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
    await this.#owner?.tasks.close();
    if (this.#owner?.tasks.failed) {
      throw this.#owner.tasks.failure;
    }
  }
}
