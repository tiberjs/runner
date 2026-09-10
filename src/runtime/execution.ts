import { ContextFrame } from "../context/frame.js";
import { Scope } from "../di/scope.js";
import { combinedError } from "../lifecycle/errors.js";
import { runWith } from "./state.js";
import type { RuntimeState } from "./state.js";
import { TaskGroup } from "./task-group.js";

/**
 * Inputs supplied by a transport when starting an execution.
 *
 * `execute` owns an omitted scope and disposes it at completion. A supplied
 * scope remains owned by the caller.
 */
export interface ExecutionSeed {
  readonly signal: AbortSignal;
  readonly attachment: unknown;
  readonly scope?: Scope;
  readonly values?: ContextFrame;
  readonly deadline?: number;
}

/** Reason used to close a TaskGroup after its execution completes normally. */
export const COMPLETED = new DOMException("Execution completed", "AbortError");

/**
 * Create runtime state without running or closing it.
 *
 * Transport bindings use this when the execution must remain alive after the
 * initial handler returns, such as while streaming a response.
 */
export function begin(seed: ExecutionSeed): RuntimeState {
  return {
    context: {
      values: seed.values ?? ContextFrame.empty,
      signal: seed.signal,
      deadline: seed.deadline,
    },
    tasks: new TaskGroup(),
    scope: seed.scope ?? new Scope(),
    attachment: seed.attachment,
  };
}

/**
 * Run a managed execution, then cancel and join its tasks. Unobserved task
 * failures are surfaced, and a scope created by this call is disposed.
 */
export async function execute<T>(seed: ExecutionSeed, handler: () => T | Promise<T>): Promise<T> {
  const state = begin(seed);
  const ownsScope = seed.scope === undefined;
  let errors: unknown[] | undefined;
  let result!: T;

  try {
    seed.signal.throwIfAborted();
    result = await runWith(state, async () => handler());
    seed.signal.throwIfAborted();
  } catch (error) {
    (errors ??= []).push(error);
  }

  await state.tasks.close(errors ? errors[0] : COMPLETED);
  if (state.tasks.failed) {
    (errors ??= []).push(state.tasks.failure);
  }

  if (ownsScope) {
    try {
      await runWith(state, () => state.scope[Symbol.asyncDispose]());
    } catch (error) {
      (errors ??= []).push(error);
    }
  }

  if (errors) {
    throw combinedError(errors, "Execution and cleanup failed.");
  }

  return result;
}
