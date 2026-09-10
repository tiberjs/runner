import { ContextFrame } from "../context/frame.js";
import type { ContextEntry } from "../context/key.js";
import { activeScope } from "../di/active-scope.js";
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
  /** Defaults to a fresh, non-aborted signal. */
  readonly signal?: AbortSignal;
  /** Opaque transport data; defaults to undefined. */
  readonly attachment?: unknown;
  /**
   * Resource owner and dependency root for this execution.
   *
   * An omitted scope is a disjoint root: application providers are unreachable
   * and an unregistered class token is constructed locally instead of shared.
   */
  readonly scope?: Scope;
  /** A prepared frame or bindings materialized into a root frame. */
  readonly values?: ContextFrame | readonly ContextEntry[];
  readonly deadline?: number;
}

/** Reason used to close a TaskGroup after its execution completes normally. */
export const COMPLETED = new DOMException("Execution completed", "AbortError");

function materializeValues(values: ExecutionSeed["values"]): ContextFrame {
  if (values === undefined) {
    return ContextFrame.empty;
  }

  return values instanceof ContextFrame ? values : ContextFrame.from(values);
}

/**
 * Create runtime state without running or closing it.
 *
 * Transport bindings use this when the execution must remain alive after the
 * initial handler returns, such as while streaming a response.
 */
export function begin(seed: ExecutionSeed): RuntimeState {
  return {
    context: {
      values: materializeValues(seed.values),
      signal: seed.signal ?? new AbortController().signal,
      deadline: seed.deadline,
    },
    tasks: new TaskGroup(),
    scope: seed.scope ?? new Scope(),
    attachment: seed.attachment,
  };
}

type ExecutionHandler<T> = () => T | Promise<T>;

/**
 * Run a managed execution, then cancel and join its tasks. Unobserved task
 * failures are surfaced, and a scope created by this call is disposed. Pass a
 * handler directly to use the default signal and attachment.
 */
export function execute<T>(handler: ExecutionHandler<T>): Promise<T>;
export function execute<T>(seed: ExecutionSeed, handler: ExecutionHandler<T>): Promise<T>;
export async function execute<T>(
  seedOrHandler: ExecutionSeed | ExecutionHandler<T>,
  suppliedHandler?: ExecutionHandler<T>,
): Promise<T> {
  const handler = typeof seedOrHandler === "function" ? seedOrHandler : suppliedHandler;
  if (typeof handler !== "function") {
    throw new TypeError("execute() requires a handler.");
  }

  const seed = typeof seedOrHandler === "function" ? {} : seedOrHandler;
  const state = begin(seed);
  const executionSignal = state.context.signal;
  const ownsScope = seed.scope === undefined;
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
      await activeScope.exit(() => runWith(state, () => state.scope[Symbol.asyncDispose]()));
    } catch (error) {
      (errors ??= []).push(error);
    }
  }

  if (errors) {
    throw combinedError(errors, "Execution and cleanup failed.");
  }

  return result;
}
