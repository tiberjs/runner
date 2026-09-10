import { AsyncLocalStorage } from "node:async_hooks";
import { peekState } from "../runtime/state.js";
import type { Scope } from "./scope.js";
import type { InjectionToken } from "./tokens.js";

/** Internal construction/startup/teardown context; never an execution owner. */
export const activeScope = new AsyncLocalStorage<Scope>();

/** Construction scope first, otherwise the current execution's resource scope. */
export function currentScope(): Scope {
  const scope = activeScope.getStore() ?? peekState()?.scope;
  if (!scope) {
    throw new Error(
      "No active scope. scoped()/onDispose() must run during construction or " +
        "inside a request/connection/message handler.",
    );
  }

  return scope;
}

/** Resolve a dependency during construction or inside a managed execution. */
export function inject<T>(token: InjectionToken<T>): T {
  return currentScope().get(token);
}

/** Acquire a resource once per scope and release it when that scope closes. */
export function scoped<T>(
  token: InjectionToken<T>,
  factory: () => T,
  dispose?: (value: T) => unknown | Promise<unknown>,
): T {
  return currentScope().use(token, factory, dispose);
}

/** Register dependency-first initialization in an owned, open startup barrier. */
export function onStart(callback: () => void | PromiseLike<void>): void {
  currentScope().addStartup(callback);
}

/** Register LIFO cleanup in the construction or execution resource scope. */
export function onDispose(cleanup: () => unknown | Promise<unknown>): void {
  currentScope().defer(cleanup);
}
