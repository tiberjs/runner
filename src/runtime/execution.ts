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
 * `execute` owns a fresh root or a child of `parentScope` and disposes it at
 * completion. A supplied `scope` remains owned by the caller.
 */
export type ExecutionSeed = {
  /** Defaults to a fresh, non-aborted signal. */
  readonly signal?: AbortSignal;
  /** Opaque transport data; defaults to undefined. */
  readonly attachment?: unknown;
  /** A prepared frame or bindings materialized into a root frame. */
  readonly values?: ContextFrame | readonly ContextEntry[];
  readonly deadline?: number;
} & (
  | {
      /** Borrow this resource owner without disposing it at execution completion. */
      readonly scope?: Scope;
      readonly parentScope?: never;
    }
  | {
      readonly scope?: never;
      /** Create an execution-owned child that inherits this scope's providers. */
      readonly parentScope: Scope;
    }
);

/** Reason used to close a TaskGroup after its execution completes normally. */
export const COMPLETED = new DOMException("Execution completed", "AbortError");

function materializeValues(values: ExecutionSeed["values"]): ContextFrame {
  if (values === undefined) {
    return ContextFrame.empty;
  }

  return values instanceof ContextFrame ? values : ContextFrame.from(values);
}

function createState(
  seed: ExecutionSeed,
  scope: Scope | undefined,
  parentScope: Scope | undefined,
): RuntimeState {
  if (scope !== undefined && parentScope !== undefined) {
    throw new TypeError("ExecutionSeed.scope and parentScope are mutually exclusive.");
  }

  // Read caller-controlled inputs before acquiring an owned scope.
  const values = materializeValues(seed.values);
  const signal = seed.signal ?? new AbortController().signal;
  const deadline = seed.deadline;
  const attachment = seed.attachment;

  return {
    context: { values, signal, deadline },
    tasks: new TaskGroup(),
    scope: scope ?? parentScope?.child() ?? new Scope(),
    attachment,
  };
}

/**
 * Create runtime state without running or closing it.
 *
 * Transport bindings use this when the execution must remain alive after the
 * initial handler returns, such as while streaming a response. The caller owns
 * task shutdown and disposal of any root or child scope created here. Without
 * either scope field, the root is disjoint from any ambient application scope.
 */
export function begin(seed: ExecutionSeed): RuntimeState {
  return createState(seed, seed.scope, seed.parentScope);
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
  // Snapshot ownership once: accessors must not change which scope is disposed.
  const scope = seed.scope;
  const parentScope = seed.parentScope;
  const state = createState(seed, scope, parentScope);
  const executionSignal = state.context.signal;
  const ownsScope = scope === undefined;
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
