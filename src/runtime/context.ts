import type { ContextKey } from "../context/key.js";
import { currentState } from "./state.js";

/**
 * Read a context value bound upstream via `provide(key, ...)` (architecture §5).
 * Returns `undefined` when the key was never provided.
 */
export function use<T>(key: ContextKey<T>): T | undefined {
  return currentState().context.values.get(key.id) as T | undefined;
}

// `params()` (route params) and `request()` live with the HTTP binding
// (http/context.ts); `use` here is the transport-agnostic context reader.
