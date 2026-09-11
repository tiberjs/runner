import { peekState } from "../runtime/state.js";
import { activeScope } from "./active-scope.js";
import type { Scope } from "./scope.js";
import type { StartupContext } from "./startup-context.js";
import type { InjectionToken } from "./tokens.js";

/** Construction scope first, otherwise the current execution's resource scope. */
export function currentScope(): Scope {
  const scope = activeScope.getStore() ?? peekState()?.scope;
  if (!scope) {
    throw new Error("No active scope. This API requires construction or a managed execution.");
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
export function onStart(callback: (context: StartupContext) => void | PromiseLike<void>): void {
  currentScope().addStartup(callback);
}

/** Register LIFO cleanup in the construction or execution resource scope. */
export function onDispose(cleanup: () => unknown | Promise<unknown>): void {
  currentScope().defer(cleanup);
}
