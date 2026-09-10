/** A typed identity for a value carried by an execution context. */
export interface ContextKey<T> {
  readonly id: symbol;
  readonly description: string;
  /** Phantom carrier; never present at runtime. */
  readonly _type?: T;
}

/** A context binding used to derive a downstream execution. */
export type ContextEntry = readonly [ContextKey<unknown>, unknown];

export function contextKey<T>(description: string): ContextKey<T> {
  return { id: Symbol(description), description };
}

/** Create a downstream binding for `key`. */
export function provide<T>(key: ContextKey<T>, value: T): ContextEntry {
  return [key, value];
}
