import type { ContextKey } from "../context/key.js";
import { currentState } from "./state.js";

/** Return the value bound to `key` in the current execution, if present. */
export function use<T>(key: ContextKey<T>): T | undefined {
  return currentState().context.values.get(key.id) as T | undefined;
}
