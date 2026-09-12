import { AsyncLocalStorage } from "node:async_hooks";
import type { ExecutionContext } from "./context/execution-context.js";
import type { Job } from "../job/job.js";

/**
 * The active Job and its immutable call-chain context.
 */
export interface RuntimeState {
  readonly context: ExecutionContext;
  readonly job: Job<unknown, unknown>;
}

const storage = new AsyncLocalStorage<RuntimeState>();

export function runWith<T>(state: RuntimeState, fn: () => T): T {
  return storage.run(state, fn);
}

/** @internal Run bookkeeping without retaining the submitting execution. */
export function withoutExecution<T>(fn: () => T): T {
  return storage.exit(fn);
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
  return currentState().context.attachment as T;
}
