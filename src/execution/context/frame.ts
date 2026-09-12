import type { ContextEntry } from "./key.js";

function entryMap(entries: readonly ContextEntry[]): Map<PropertyKey, unknown> {
  const values = new Map<PropertyKey, unknown>();
  for (const [key, value] of entries) {
    values.set(key.id, value);
  }

  return values;
}

/**
 * An immutable chain of execution-context bindings.
 *
 * Derived frames shadow matching parent keys without changing the parent, so
 * sibling executions can safely share their inherited context. Binding
 * structure is immutable; bound values remain the caller's objects and are not
 * cloned or frozen.
 */
export class ContextFrame {
  readonly #parent: ContextFrame | null;
  readonly #own: ReadonlyMap<PropertyKey, unknown>;

  private constructor(parent: ContextFrame | null, own: ReadonlyMap<PropertyKey, unknown>) {
    this.#parent = parent;
    this.#own = own;
  }

  /** The empty root frame shared by new executions. */
  static readonly empty: ContextFrame = new ContextFrame(null, new Map());

  /** Create a root frame containing the supplied context bindings. */
  static from(entries: readonly ContextEntry[]): ContextFrame {
    return entries.length === 0 ? ContextFrame.empty : new ContextFrame(null, entryMap(entries));
  }

  get(key: PropertyKey): unknown {
    // oxlint-disable-next-line typescript/no-this-alias -- The cursor walks this frame's parent chain without copying it.
    for (let frame: ContextFrame | null = this; frame !== null; frame = frame.#parent) {
      if (frame.#own.has(key)) {
        return frame.#own.get(key);
      }
    }

    return undefined;
  }

  has(key: PropertyKey): boolean {
    // oxlint-disable-next-line typescript/no-this-alias -- The cursor walks this frame's parent chain without copying it.
    for (let frame: ContextFrame | null = this; frame !== null; frame = frame.#parent) {
      if (frame.#own.has(key)) {
        return true;
      }
    }

    return false;
  }

  /** Return a child frame containing the supplied bindings. */
  with(values: Record<PropertyKey, unknown>): ContextFrame {
    const keys = Reflect.ownKeys(values);
    if (keys.length === 0) {
      return this;
    }

    const own = new Map<PropertyKey, unknown>();
    for (const key of keys) {
      own.set(key, (values as Record<PropertyKey, unknown>)[key]);
    }

    return new ContextFrame(this, own);
  }

  /** Return a child frame containing the supplied context bindings. */
  withEntries(entries: readonly ContextEntry[]): ContextFrame {
    return entries.length === 0 ? this : new ContextFrame(this, entryMap(entries));
  }

  keys(): IterableIterator<PropertyKey> {
    const seen = new Set<PropertyKey>();
    // oxlint-disable-next-line typescript/no-this-alias -- The cursor visits this frame and every ancestor to collect visible keys.
    for (let frame: ContextFrame | null = this; frame !== null; frame = frame.#parent) {
      for (const key of frame.#own.keys()) {
        seen.add(key);
      }
    }

    return seen.values();
  }
}
