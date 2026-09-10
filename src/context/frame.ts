/**
 * ContextFrame — an immutable scope chain of context values (architecture §4, §10).
 *
 * Implemented as a parent-linked environment (like an interpreter's lexical
 * scope): `with` prepends a node holding just that call's entries — it never
 * copies the parent, so deriving is O(entries) and sibling/forked executions
 * share the whole parent chain by reference with zero duplication. `get` walks
 * newest-first, so a later `with` of the same key shadows the older binding.
 * Reads are O(chain depth); context frames are small and shallow in practice.
 */
export class ContextFrame {
  private constructor(
    private readonly parent: ContextFrame | null,
    private readonly own: ReadonlyMap<PropertyKey, unknown>,
  ) {}

  /** The empty root frame shared by every fresh request execution. */
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

  /**
   * Derive a new frame with the given values bound, leaving this frame intact.
   * Allocates one node (no parent copy); the parent chain is shared.
   */
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
