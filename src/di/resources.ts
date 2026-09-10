import { combinedError } from "../lifecycle/errors.js";
import { activeScope } from "./active-scope.js";
import { ScopeClosedError, ScopeDisposalConflictError, ScopeStartupError } from "./errors.js";
import type { Scope } from "./scope.js";

type Startup = () => void | PromiseLike<void>;
type Cleanup = () => unknown | Promise<unknown>;
type StartupPhase = "disabled" | "collecting" | "starting" | "started" | "failed";

/** Structural resource hooks. Do not combine onClose with a symbol disposer. */
export interface ScopeObject {
  onStart?(): void | PromiseLike<void>;
  onClose?(): unknown | Promise<unknown>;
}

/** Startup transactions and LIFO resource ownership; no dependency resolution. */
export class ResourceLifecycle {
  #startups: Startup[] | undefined;
  #disposers: Cleanup[] | undefined;
  #pendingStartups: Startup[] | undefined;
  /** Disposal ownership across the whole scope tree; keyed at the root lifecycle. */
  #ownership: WeakMap<object, ResourceLifecycle | { rejected: unknown }> | undefined;
  #starting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #disposed = false;
  #startupPhase: StartupPhase;

  constructor(
    private readonly scope: Scope,
    startup: boolean,
    private readonly parent?: ResourceLifecycle,
  ) {
    this.#startupPhase = startup ? "collecting" : "disabled";
  }

  get #owners(): WeakMap<object, ResourceLifecycle | { rejected: unknown }> {
    return this.parent ? this.parent.#owners : (this.#ownership ??= new WeakMap());
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Queued initialization exists and no startup barrier has run yet. */
  get startupPending(): boolean {
    return this.#startupPhase === "collecting" && (this.#startups?.length ?? 0) > 0;
  }

  assertOpen(): void {
    if (this.#closing) {
      throw new ScopeClosedError(this.#disposed ? "disposed" : "closing");
    }
  }

  assertNotDisposed(): void {
    if (this.#disposed) {
      throw new ScopeClosedError("disposed");
    }
  }

  defer(cleanup: Cleanup): void {
    this.assertNotDisposed();
    (this.#disposers ??= []).push(cleanup);
  }

  addStartup(callback: Startup): void {
    this.assertOpen();
    if (this.#startupPhase !== "collecting" && this.#startupPhase !== "starting") {
      throw new ScopeStartupError(this.#startupPhase);
    }
    (this.#pendingStartups ?? (this.#startups ??= [])).push(callback);
  }

  /** Commit startup only for successfully constructed resources, dependencies first. */
  construct<T>(factory: () => T, dispose?: (value: T) => unknown | Promise<unknown>): T {
    const parentStartups = this.#pendingStartups;
    this.#pendingStartups = [];

    try {
      const value = activeScope.run(this.scope, factory);
      this.#adopt(value, dispose);

      if (this.#pendingStartups.length > 0) {
        this.assertOpen();
        // A running startup callback would use this resource before its own
        // initialization; only construction-time resolution orders correctly.
        if (this.#startupPhase === "starting" && !parentStartups) {
          throw new ScopeStartupError("late");
        }
        (this.#startups ??= []).push(...this.#pendingStartups);
      }

      return value;
    } finally {
      // Partial construction retains cleanup but must not initialize a failed resource.
      this.#pendingStartups = parentStartups;
    }
  }

  /** Close startup admission without an asynchronous barrier only when nothing is pending. */
  sealStartup(): void {
    this.assertOpen();
    if (this.#startupPhase === "disabled" || this.#startupPhase === "started") {
      return;
    }
    if (this.#startupPhase !== "collecting") {
      throw new ScopeStartupError(this.#startupPhase);
    }
    if (this.#startups?.length || this.#pendingStartups) {
      throw new ScopeStartupError("pending");
    }
    this.#startupPhase = "started";
  }

  start(): Promise<void> {
    if (this.#closing) {
      return Promise.reject(new ScopeClosedError(this.#disposed ? "disposed" : "closing"));
    }
    if (this.#starting) {
      return this.#starting;
    }
    if (this.#startupPhase === "disabled") {
      return Promise.reject(new ScopeStartupError("disabled"));
    }
    if (this.#pendingStartups) {
      return Promise.reject(new ScopeStartupError("pending"));
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#starting = promise;
    this.#startupPhase = "starting";
    void this.#runStartups().then(resolve, reject);

    return promise;
  }

  close(): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#closing = promise;
    void this.#dispose().then(resolve, reject);

    return promise;
  }

  async #runStartups(): Promise<void> {
    let index = 0;
    try {
      while (!this.#closing && index < (this.#startups?.length ?? 0)) {
        await activeScope.run(this.scope, this.#startups![index++]!);
      }
      // Seal in the same continuation that observes the drained queue, not a later .then().
      this.#startupPhase = "started";
    } catch (error) {
      this.#startupPhase = "failed";
      throw error;
    } finally {
      this.#startups = undefined;
    }
  }

  async #dispose(): Promise<void> {
    const errors: unknown[] = [];
    try {
      // Yield past a synchronous factory that initiated disposal before returning its resource.
      await this.#starting;
    } catch (error) {
      errors.push(error);
    }

    while (this.#disposers?.length) {
      try {
        await activeScope.run(this.scope, this.#disposers.pop()!);
      } catch (error) {
        errors.push(error);
      }
    }

    this.#disposed = true;
    this.#startups = undefined;
    this.#disposers = undefined;

    if (errors.length) {
      throw combinedError(errors, "Errors during disposal.");
    }
  }

  #adopt<T>(value: T, explicitDispose?: (value: T) => unknown | Promise<unknown>): void {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      if (explicitDispose) {
        this.defer(() => explicitDispose(value));
      }
      return;
    }

    const owners = this.#owners;
    const owner = owners.get(value);
    if (owner) {
      if (!(owner instanceof ResourceLifecycle)) {
        throw owner.rejected;
      }
      if (!owner.#disposed) {
        if (explicitDispose) {
          throw new ScopeDisposalConflictError("already-owned");
        }
        return;
      }
    }

    const asyncDispose = (value as Partial<AsyncDisposable>)[Symbol.asyncDispose];
    const dispose = (value as Partial<Disposable>)[Symbol.dispose];
    const onClose = (value as ScopeObject).onClose;
    const symbolDispose = typeof asyncDispose === "function" ? asyncDispose : dispose;
    // Preserve cleanup even if hook admission fails. On a conflicting shape the symbol
    // protocol wins solely for rollback; the object is never returned to its consumer.
    const cleanup = explicitDispose
      ? () => explicitDispose(value)
      : typeof symbolDispose === "function"
        ? () => symbolDispose.call(value)
        : typeof onClose === "function"
          ? () => onClose.call(value)
          : undefined;
    if (cleanup) {
      this.defer(cleanup);
      owners.set(value, this);
    }

    try {
      // An explicit disposer is the caller's override for third-party shapes.
      if (
        !explicitDispose &&
        typeof onClose === "function" &&
        typeof symbolDispose === "function"
      ) {
        throw new ScopeDisposalConflictError("multiple-hooks");
      }
      const onStart = (value as ScopeObject).onStart;
      if (typeof onStart === "function") {
        this.addStartup(() => onStart.call(value));
      }
    } catch (error) {
      owners.set(value, { rejected: error });
      throw error;
    }
  }
}
