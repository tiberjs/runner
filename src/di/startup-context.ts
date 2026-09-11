import { LifecycleStateError } from "../lifecycle/diagnostics.js";
import { execute } from "../runtime/execution.js";
import { withoutExecution } from "../runtime/state.js";
import type { Scope } from "./scope.js";

/** Explicit managed work within a resource's startup hook. */
export interface StartupContext {
  /**
   * Run with fresh execution context and cancellation, borrowing the startup scope.
   * Await or return this promise: it joins forked work but never closes the scope.
   * Available only until the owning startup hook settles.
   */
  execute<T>(handler: () => T | PromiseLike<T>): Promise<T>;
}

/** @internal A hook-scoped capability that releases its resource owner on retirement. */
export class HookStartupContext implements StartupContext {
  #scope: Scope | undefined;

  constructor(scope: Scope) {
    this.#scope = scope;
  }

  readonly execute = <T>(handler: () => T | PromiseLike<T>): Promise<T> => {
    const scope = this.#scope;
    if (!scope) {
      return Promise.reject(new LifecycleStateError("StartupContext", "execute", "closed"));
    }

    return withoutExecution(() => execute({ scope }, async () => handler()));
  };

  release(): void {
    this.#scope = undefined;
  }
}
