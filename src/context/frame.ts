/**
 * An immutable chain of execution-context bindings.
 *
 * Derived frames shadow matching parent keys without changing the parent, so
 * sibling executions can safely share their inherited context.
 */
export class ContextFrame {
  private constructor(
    private readonly parent: ContextFrame | null,
    private readonly own: ReadonlyMap<PropertyKey, unknown>,
  ) {}

  /** The empty root frame shared by new executions. */
  static readonly empty: ContextFrame = new ContextFrame(null, new Map());

  get(key: PropertyKey): unknown {
    // oxlint-disable-next-line typescript/no-this-alias -- The cursor walks this frame's parent chain without copying it.
    for (let frame: ContextFrame | null = this; frame !== null; frame = frame.parent) {
      if (frame.own.has(key)) {
        return frame.own.get(key);
      }
    }

    return undefined;
  }

  has(key: PropertyKey): boolean {
    // oxlint-disable-next-line typescript/no-this-alias -- The cursor walks this frame's parent chain without copying it.
    for (let frame: ContextFrame | null = this; frame !== null; frame = frame.parent) {
      if (frame.own.has(key)) {
        return true;
      }
    }

    return false;
  }

  /** Return a child frame containing the supplied bindings. */
  with(values: Record<PropertyKey, unknown>): ContextFrame {
    const own = new Map<PropertyKey, unknown>();
    for (const key of Reflect.ownKeys(values)) {
      own.set(key, (values as Record<PropertyKey, unknown>)[key]);
    }

    return new ContextFrame(this, own);
  }

  keys(): IterableIterator<PropertyKey> {
    const seen = new Set<PropertyKey>();
    // oxlint-disable-next-line typescript/no-this-alias -- The cursor visits this frame and every ancestor to collect visible keys.
    for (let frame: ContextFrame | null = this; frame !== null; frame = frame.parent) {
      for (const key of frame.own.keys()) {
        seen.add(key);
      }
    }

    return seen.values();
  }
}
