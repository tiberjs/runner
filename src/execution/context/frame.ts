import type { ContextEntry } from "./key.js";

/** What a frame needs from its own bindings; `Map` satisfies it for many, one object for one. */
interface Bindings {
  has(key: PropertyKey): boolean;
  get(key: PropertyKey): unknown;
  keys(): Iterable<PropertyKey>;
}

/** The common case — one binding per frame — without a hash table. */
class SingleBinding implements Bindings {
  constructor(
    private readonly key: PropertyKey,
    private readonly value: unknown,
  ) {}

  has(key: PropertyKey): boolean {
    return key === this.key;
  }

  get(key: PropertyKey): unknown {
    return key === this.key ? this.value : undefined;
  }

  *keys(): Iterable<PropertyKey> {
    yield this.key;
  }
}

function bindingsOf(entries: readonly ContextEntry[]): Bindings {
  if (entries.length === 1) {
    const [key, value] = entries[0]!;
    return new SingleBinding(key.id, value);
  }
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
  readonly #own: Bindings;

  private constructor(parent: ContextFrame | null, own: Bindings) {
    this.#parent = parent;
    this.#own = own;
  }

  /** The empty root frame shared by new executions. */
  static readonly empty: ContextFrame = new ContextFrame(null, new Map());

  /** Create a root frame containing the supplied context bindings. */
  static from(entries: readonly ContextEntry[]): ContextFrame {
    return entries.length === 0 ? ContextFrame.empty : new ContextFrame(null, bindingsOf(entries));
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
    if (keys.length === 1) {
      const key = keys[0]!;
      return new ContextFrame(this, new SingleBinding(key, values[key]));
    }
    const own = new Map<PropertyKey, unknown>();
    for (const key of keys) {
      own.set(key, values[key]);
    }
    return new ContextFrame(this, own);
  }

  /** Return a child frame containing the supplied context bindings. */
  withEntries(entries: readonly ContextEntry[]): ContextFrame {
    return entries.length === 0 ? this : new ContextFrame(this, bindingsOf(entries));
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
