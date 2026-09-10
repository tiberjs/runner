import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "../context/execution-context.js";
import type { Scope } from "../di/scope.js";
import type { TaskGroup } from "./task-group.js";

/**
 * The current execution carried through {@link AsyncLocalStorage} (architecture
 * §3). An execution bundles four facets, each with its own axis:
 *  - `context`  — data + cancellation (values / signal / deadline); derived
 *                 (`next(provide(...))`, `timeout`).
 *  - `tasks`    — structured concurrency: this execution's TaskGroup (fork).
 *  - `scope`    — resource ownership: the {@link Scope} the execution runs in
 *                 (app / connection / request); resources live here, not tasks.
 *  - `attachment` — the transport payload (HTTP request/params, a WS socket, a
 *                 broker message), read via a binding's accessor.
 */
export interface RuntimeState {
  context: ExecutionContext;
  tasks: TaskGroup;
  scope: Scope;
  attachment: unknown;
}

const storage = new AsyncLocalStorage<RuntimeState>();

export function runWith<T>(state: RuntimeState, fn: () => T): T {
  return storage.run(state, fn);
}

export function currentState(): RuntimeState {
  const state = storage.getStore();
  if (!state) {
    throw new Error(
      "No active execution context. Framework APIs (fork, timeout, signal, " +
        "request, use, params) must be called within a request handler or a forked task.",
    );
  }

  return state;
}

export function peekState(): RuntimeState | undefined {
  return storage.getStore();
}

/** Read the transport-specific attachment for the current execution (§14). */
export function currentAttachment<T>(): T {
  return currentState().attachment as T;
}
