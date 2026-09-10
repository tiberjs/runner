/**
 * Link a child controller to a parent signal so that parent cancellation
 * propagates downward (architecture §8). The child may additionally be aborted
 * on its own (e.g. by a timeout) without affecting the parent.
 */
export function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }

  const abort = () => child.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });

  return () => parent.removeEventListener("abort", abort);
}
