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
 * is accepted alongside the reason itself.
 */
export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }

  const reason = signal.reason;
  if (Object.is(error, reason)) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    Object.is(error.cause, reason)
  );
}
