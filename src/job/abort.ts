import { addAbortListener } from "node:events";

const NOOP = (): void => {};

/** Forward one source's abort reason until unlinked. */
export function linkAbort(source: AbortSignal, onAbort: (reason: unknown) => void): () => void {
  let delivered = false;
  const deliver = (): void => {
    if (!delivered) {
      delivered = true;
      onAbort(source.reason);
    }
  };
  if (source.aborted) {
    deliver();
    return NOOP;
  }

  const subscription = addAbortListener(source, deliver);
  // Listener installation can itself reenter source cancellation.
  if (source.aborted) {
    deliver();
  }
  return () => subscription[Symbol.dispose]();
}

/**
 * Whether `error` is this signal's cancellation rather than a genuine failure.
 *
 * Node core APIs such as `timers/promises` and `fs/promises` reject with an
 * AbortError carrying code ABORT_ERR and the signal reason as cause. Only that
 * native cancellation shape permits a cause hop; application error causes
 * do not define cancellation. Compound failures must match at every leaf.
 */
export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }

  try {
    return matchesCancellation(error, signal.reason);
  } catch {
    // Thrown values may have hostile accessors or proxies. Inspection must not
    // replace the original failure or turn it into expected cancellation.
    return false;
  }
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
  const suppressed = error instanceof SuppressedError;

  if (!aggregate && !suppressed) {
    return (
      error instanceof Error &&
      error.name === "AbortError" &&
      "code" in error &&
      error.code === "ABORT_ERR" &&
      "cause" in error &&
      Object.is(error.cause, reason)
    );
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
