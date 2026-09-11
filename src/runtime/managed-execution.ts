import { ContextFrame } from "../context/frame.js";
import type { ExecutionContext } from "../context/execution-context.js";
import { activeScope } from "../di/active-scope.js";
import type { Scope } from "../di/scope.js";
import { combinedError } from "../lifecycle/errors.js";
import { runWith, type RuntimeState } from "./state.js";
import { TaskGroup } from "./task-group.js";

/** Reason used to close a TaskGroup after its execution completes normally. */
export const COMPLETED = new DOMException("Execution completed", "AbortError");

/** @internal Build execution state around an already selected resource owner. */
export function createExecutionState(
  scope: Scope,
  context: ExecutionContext = { values: ContextFrame.empty, signal: new AbortController().signal },
  attachment?: unknown,
): RuntimeState {
  return { context, tasks: new TaskGroup(), scope, attachment };
}

/** @internal Execute and join work without choosing or constructing a Scope. */
export async function runExecution<T>(
  state: RuntimeState,
  handler: () => T | PromiseLike<T>,
  ownsScope: boolean,
): Promise<T> {
  const executionSignal = state.context.signal;
  let errors: unknown[] | undefined;
  let result!: T;

  try {
    executionSignal.throwIfAborted();
    // This execution resolves in its own scope, not in the one that started it.
    result = await activeScope.exit(() => runWith(state, async () => handler()));
    executionSignal.throwIfAborted();
  } catch (error) {
    (errors ??= []).push(error);
  }

  await state.tasks.close(errors ? errors[0] : COMPLETED);
  if (state.tasks.failed) {
    (errors ??= []).push(state.tasks.failure);
  }

  if (ownsScope) {
    try {
      if (!state.scope.disposeSync()) {
        await activeScope.exit(() => runWith(state, () => state.scope[Symbol.asyncDispose]()));
      }
    } catch (error) {
      (errors ??= []).push(error);
    }
  }

  if (errors) {
    throw combinedError(errors, "Execution and cleanup failed.");
  }
  return result;
}
