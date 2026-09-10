import { describeToken, type InjectionToken } from "./tokens.js";

/** A container resolution failure; provider exceptions propagate unchanged. */
export class ResolutionError extends Error {
  constructor(
    readonly reason: "missing-provider" | "circular-dependency",
    readonly token: InjectionToken<unknown>,
    options?: ErrorOptions,
  ) {
    super(
      reason === "missing-provider"
        ? `No provider registered for token "${describeToken(token)}". Use provide(token, factory) for values/interfaces.`
        : `Circular dependency while resolving "${describeToken(token)}".`,
      options,
    );
    this.name = "ResolutionError";
  }
}

/** Resource admission failed because this scope's teardown has begun. */
export class ScopeClosedError extends Error {
  constructor(
    readonly state: "closing" | "disposed",
    options?: ErrorOptions,
  ) {
    super(state === "closing" ? "Scope is closing." : "Scope has been disposed.", options);
    this.name = "ScopeClosedError";
  }
}

/** Startup requires an explicitly owned, still-open initialization barrier. */
export class ScopeStartupError extends Error {
  constructor(readonly state: "disabled" | "pending" | "starting" | "started" | "failed" | "late") {
    super(
      state === "disabled"
        ? "This scope has no startup owner. Initialize resources before acquiring them here."
        : state === "pending" || state === "starting"
          ? "Scope startup is pending. Await start() before admitting work."
          : state === "late"
            ? "Resources with startup hooks must be resolved during construction, not inside a running startup callback."
            : `Scope startup is ${state}; new onStart hooks cannot be registered.`,
    );
    this.name = "ScopeStartupError";
  }
}

/** An object must have exactly one disposal owner and one automatic close protocol. */
export class ScopeDisposalConflictError extends Error {
  constructor(readonly reason: "multiple-hooks" | "already-owned") {
    super(
      reason === "multiple-hooks"
        ? "ScopeObject.onClose cannot coexist with Symbol.asyncDispose or Symbol.dispose."
        : "An explicit disposer cannot take ownership of an already-owned resource.",
    );
    this.name = "ScopeDisposalConflictError";
  }
}
