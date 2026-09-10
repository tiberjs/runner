/**
 * Schedule arbitrary cleanup tied to a lexical scope via `await using`
 * (architecture §9). Resource lifetime is delegated to the JavaScript language
 * rather than owned by the TaskGroup or ExecutionContext.
 *
 * @example
 * await using _ = defer(async () => { await audit.flush(); });
 */
export function defer(callback: () => void | PromiseLike<void>): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      await callback();
    },
  };
}
