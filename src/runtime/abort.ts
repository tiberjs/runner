/** Propagate parent cancellation to a child controller until unlinked. */
export function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }

  const abort = () => child.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });

  return () => parent.removeEventListener("abort", abort);
}

/**
 * Whether `error` is this signal's cancellation rather than a genuine failure.
 *
 * Node core APIs such as `timers/promises` and `fs/promises` reject with their
 * own `AbortError` whose `cause` is the signal reason, so one level of `cause`
 * is accepted alongside the reason itself. Compound failures are cancellation
 * only when all their leaves match; their own `cause` cannot hide a failure.
 */
export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }

  return matchesCancellation(error, signal.reason);
}

function matchesCancellation(
  error: unknown,
  reason: unknown,
  seen?: Map<object, boolean>,
): boolean {
  if (Object.is(error, reason)) {
    return true;
  }

  if (typeof error !== "object" || error === null) {
    return false;
  }

  const aggregate = error instanceof AggregateError;
  // The bundled TypeScript disposal helper uses this Error fallback on Node
  // versions without native SuppressedError. Do not trust name-shaped objects.
  const suppressed =
    typeof SuppressedError === "function"
      ? error instanceof SuppressedError
      : error instanceof Error &&
        Object.hasOwn(error, "name") &&
        error.name === "SuppressedError" &&
        Object.hasOwn(error, "error") &&
        Object.hasOwn(error, "suppressed");

  if (!aggregate && !suppressed) {
    return "cause" in error && Object.is(error.cause, reason);
  }

  const known = seen?.get(error);
  if (known !== undefined) {
    // An unfinished node is a cycle, not evidence of cancellation. Completed
    // nodes may be shared by multiple branches without rewalking their leaves.
    return known;
  }
  seen ??= new Map();
  seen.set(error, false);

  if (aggregate) {
    const errors: unknown = error.errors;
    if (!Array.isArray(errors) || errors.length === 0) {
      return false;
    }
    for (const child of errors) {
      if (!matchesCancellation(child, reason, seen)) {
        return false;
      }
    }
  } else {
    const compound = error as SuppressedError;
    if (
      !matchesCancellation(compound.error, reason, seen) ||
      !matchesCancellation(compound.suppressed, reason, seen)
    ) {
      return false;
    }
  }

  seen.set(error, true);
  return true;
}
