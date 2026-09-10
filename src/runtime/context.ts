import type { ContextEntry, ContextKey } from "../context/key.js";
import { currentState, runWith } from "./state.js";

/** Return the value bound to `key` in the current execution, if present. */
export function use<T>(key: ContextKey<T>): T | undefined {
  return currentState().context.values.get(key.id) as T | undefined;
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
