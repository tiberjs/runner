import type { Scope } from "./scope.js";

/** A zero-argument constructor usable as its own injection token. */
export type Constructor<T = object> = new (...args: never[]) => T;

/** An opaque token for values/interfaces that have no runtime class. */
export interface Token<T> {
  readonly key: symbol;
  /** Phantom carrier; never present at runtime. */
  readonly _type?: T;
}

export type InjectionToken<T> = Constructor<T> | Token<T>;
export type Factory<T> = (scope: Scope) => T;

export function token<T>(description: string): Token<T> {
  return { key: Symbol(description) };
}

export function describeToken(token: InjectionToken<unknown>): string {
  if (typeof token === "function") {
    return token.name || "anonymous class";
  }

  return token.key.description ?? "token";
}
