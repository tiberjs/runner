import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "../context/execution-context.js";
import type { Scope } from "../di/scope.js";
import type { TaskGroup } from "./task-group.js";

/**
 * State available to code running inside one managed execution.
 *
 * Context values and cancellation are inherited by child work. The task group
 * owns concurrent work, the scope owns resources, and the attachment carries
 * transport-specific data.
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
      "No active execution. This API must run inside execute(), runWith(), or fork().",
    );
  }

  return state;
}

export function peekState(): RuntimeState | undefined {
  return storage.getStore();
}

/** Return the transport attachment for the current execution. */
export function currentAttachment<T>(): T {
  return currentState().attachment as T;
}
