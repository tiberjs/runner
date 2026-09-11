import { assertCanJoin, markDependency, startupDependency } from "../lifecycle/diagnostics.js";
import { combinedError } from "../lifecycle/errors.js";
import { activeScope } from "./active-scope.js";
import { ScopeClosedError, ScopeDisposalConflictError, ScopeStartupError } from "./errors.js";
import type { Scope } from "./scope.js";
import type { StartupContext } from "./startup-context.js";

type Startup = (context: StartupContext) => void | PromiseLike<void>;
type StartupRunner = (scope: Scope, hook: Startup) => Promise<void>;
type Cleanup = () => unknown | Promise<unknown>;
type StartupPhase = "disabled" | "collecting" | "starting" | "started" | "failed";

/** Structural resource hooks. Do not combine onClose with a symbol disposer. */
export interface ScopeObject {
  onStart?(context: StartupContext): void | PromiseLike<void>;
  onClose?(): unknown | Promise<unknown>;
}

type ResourceOwners = WeakMap<object, ResourceLifecycle | { rejected: unknown }>;

// Surviving children share ownership without initializing a closed parent's lifecycle.
const ownershipByRoot = new WeakMap<Scope, ResourceOwners>();

/** Startup transactions and LIFO resource ownership; no dependency resolution. */
export class ResourceLifecycle {
  #startups: Startup[] | undefined;
  #disposers: Cleanup[] | undefined;
  #pendingStartups: Startup[] | undefined;
  /** Lazily cached ownership shared by every lifecycle in the scope tree. */
  #ownership: ResourceOwners | undefined;
  #starting: Promise<void> | undefined;
  #startupPhase: StartupPhase;

  constructor(
    private readonly scope: Scope,
    startup: boolean,
    private readonly root: Scope,
  ) {
    this.#startupPhase = startup ? "collecting" : "disabled";
  }

  get #owners(): ResourceOwners {
    if (!this.#ownership) {
      let owners = ownershipByRoot.get(this.root);
      if (!owners) {
        owners = new WeakMap();
        ownershipByRoot.set(this.root, owners);
      }
      this.#ownership = owners;
    }
    return this.#ownership;
  }

  /** Queued initialization exists and no startup barrier has run yet. */
  get startupPending(): boolean {
    return this.#startupPhase === "collecting" && (this.#startups?.length ?? 0) > 0;
  }

  #assertOpen(): void {
    const state = this.scope.lifecycleState;
    if (state !== "open") {
      throw new ScopeClosedError(state);
    }
  }

  #assertNotDisposed(): void {
    if (this.scope.lifecycleState === "disposed") {
      throw new ScopeClosedError("disposed");
    }
  }

  defer(cleanup: Cleanup): void {
    this.#assertNotDisposed();
    (this.#disposers ??= []).push(cleanup);
  }

  addStartup(callback: Startup): void {
    this.#assertOpen();
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
        this.#assertOpen();
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
    this.#assertOpen();
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

  start(runHook: StartupRunner): Promise<void> {
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
    markDependency(promise, startupDependency(this.scope));
    this.#startupPhase = "starting";
    void this.#runStartups(runHook).then(resolve, reject);

    return promise;
  }

  /** Check self-joins before the scope commits admission or a closing promise. */
  assertCanJoinStartup(operation: string): void {
    if (this.#startupPhase === "starting") {
      assertCanJoin(startupDependency(this.scope), operation, "Scope");
    }
  }

  async #runStartups(runHook: StartupRunner): Promise<void> {
    let index = 0;
    try {
      while (this.scope.lifecycleState === "open" && index < (this.#startups?.length ?? 0)) {
        await runHook(this.scope, this.#startups![index++]!);
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

  /** Drain once under the scope's published close barrier, then retire its admission. */
  async dispose(finalize: () => void): Promise<void> {
    const errors: unknown[] = [];
    try {
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

      if (errors.length) {
        throw combinedError(errors, "Errors during disposal.");
      }
    } finally {
      this.#startups = undefined;
      this.#disposers = undefined;
      finalize();
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
      if (owner.scope.lifecycleState !== "disposed") {
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
        this.addStartup((context) => onStart.call(value, context));
      }
    } catch (error) {
      owners.set(value, { rejected: error });
      throw error;
    }
  }
}
