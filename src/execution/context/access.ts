import type { ContextEntry, ContextKey } from "./key.js";
import { currentState, runWith } from "../state.js";

/** A required binding is absent; no bound context values are retained. */
export class MissingContextError extends Error {
  constructor(readonly key: ContextKey<unknown>) {
    super(`No context value bound for "${key.description}".`);
    this.name = "MissingContextError";
  }
}

/** Return the binding or undefined when absent. Throws Error outside an active execution. */
export function use<T>(key: ContextKey<T>): T | undefined {
  return currentState().context.values.get(key.id) as T | undefined;
}

/** Whether the frame binds `key`, including undefined. Throws Error outside an active execution. */
export function hasContext<T>(key: ContextKey<T>): boolean {
  return currentState().context.values.has(key.id);
}

/** Return the binding; throws MissingContextError when absent, or Error outside an execution. */
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
  const { context } = state;
  return runWith(
    {
      job: state.job,
      context: {
        values: context.values.withEntries(entries),
        // Forwarded, not copied: reading the signal stays the Job's observation point.
        get signal() {
          return context.signal;
        },
        deadline: context.deadline,
        attachment: context.attachment,
      },
    },
    handler,
  );
}

/** The current Job's cancellation signal. Throws Error outside an active execution. */
export function signal(): AbortSignal {
  return currentState().context.signal;
}

/** The deadline (epoch millis), if any. Throws Error outside an active execution. */
export function deadline(): number | undefined {
  return currentState().context.deadline;
}
