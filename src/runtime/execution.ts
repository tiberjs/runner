import { ContextFrame } from "../context/frame.js";
import { Scope } from "../di/scope.js";
import { combinedError } from "../lifecycle/errors.js";
import { runWith } from "./state.js";
import type { RuntimeState } from "./state.js";
import { TaskGroup } from "./task-group.js";

/**
 * The transport-agnostic seed for a managed execution (architecture §3, §7). A
 * binding supplies the cancellation `signal` (e.g. client disconnect), the
 * transport `attachment`, and optionally the resource {@link Scope} the
 * execution runs in. Omitting `scope` creates a throwaway one, disposed when
 * the execution ends; passing one (a connection/request scope) leaves its
 * lifetime to the caller.
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
 * Build a root {@link RuntimeState} for an execution (architecture §7). The
 * caller runs handlers under it (via {@link runWith}) and decides when to close
 * the TaskGroup — some bindings keep tasks alive past the initial handler
 * return (HTTP SSE, a WS connection).
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
 * Run `handler` as a fully managed execution (architecture §7, §10): a fresh
 * TaskGroup rooted at `seed.signal`, closed (cancel → join) when the handler
 * settles, with an un-awaited fork failure surfaced. A scope created here (none
 * passed) is disposed too; a caller-owned scope is left intact.
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
