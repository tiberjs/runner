/**
 * A typed key for a request-scoped context value (architecture §4, §5). Mirrors
 * the DI `token()`/`inject()` pair, but for per-request execution context:
 * written by middleware via `provide(key, value)` + `next(...)`, read anywhere
 * in the execution via `use(key)`.
 */
export interface ContextKey<T> {
  readonly id: symbol;
  readonly description: string;
  /** Phantom carrier; never present at runtime. */
  readonly _type?: T;
}

/** A `[key, value]` pair passed to `next(...)` to derive downstream context. */
export type ContextEntry = readonly [ContextKey<unknown>, unknown];

export function contextKey<T>(description: string): ContextKey<T> {
  return { id: Symbol(description), description };
}

/** Bind a value to a context key for the downstream execution. */
export function provide<T>(key: ContextKey<T>, value: T): ContextEntry {
  return [key, value];
}
