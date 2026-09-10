/** Create an async disposable that runs `callback` when its lexical scope exits. */
export function defer(callback: () => void | PromiseLike<void>): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      await callback();
    },
  };
}
