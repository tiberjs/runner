import type { ContextEntry, ContextKey } from "./key.js";
import { currentState, runWith } from "../state.js";

/** A required binding is absent; no bound context values are retained. */
export class MissingContextError extends Error {
  constructor(readonly key: ContextKey<unknown>) {
    super(`No context value bound for "${key.description}".`);
    this.name = "MissingContextError";
  }
}

/** Return the value bound to `key` in the current execution, if present. */
export function use<T>(key: ContextKey<T>): T | undefined {
  return currentState().context.values.get(key.id) as T | undefined;
}

/** Whether the active frame binds `key`, including an explicit undefined value. */
export function hasContext<T>(key: ContextKey<T>): boolean {
  return currentState().context.values.has(key.id);
}

/** Return a required binding, throwing only when the key is absent. */
export function requireContext<T>(key: ContextKey<T>): T {
  const values = currentState().context.values;
  const value = values.get(key.id) as T | undefined;
  if (value === undefined && !values.has(key.id)) {
    throw new MissingContextError(key);
  }
  return value as T;
}

/** Run a call chain with immutable context bindings derived from the active execution. */
export function withContext<T>(entries: readonly ContextEntry[], handler: () => T): T {
  const state = currentState();
  if (entries.length === 0) {
    return handler();
  }
  return runWith(
    {
      ...state,
      context: {
        ...state.context,
        values: state.context.values.withEntries(entries),
      },
    },
    handler,
  );
}

/** The currently executing Job's cancellation signal. */
export function signal(): AbortSignal {
  return currentState().context.signal;
}

/** The current execution's deadline (epoch millis), if any. */
export function deadline(): number | undefined {
  return currentState().context.deadline;
}
