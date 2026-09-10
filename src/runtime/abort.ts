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
