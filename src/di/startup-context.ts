/** Explicit managed work within a resource's startup hook. */
export interface StartupContext {
  /**
   * Run with fresh execution context and cancellation, borrowing the startup scope.
   * Await or return this promise: it joins forked work but never closes the scope.
   * Available only until the owning startup hook settles.
   */
  execute<T>(handler: () => T | PromiseLike<T>): Promise<T>;
}
