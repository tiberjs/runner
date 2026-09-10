import { ResolutionError } from "./errors.js";
import { ResourceLifecycle } from "./resources.js";
import { ResolutionTracker, type ResolutionGraph } from "./resolution-graph.js";
import type { Factory, InjectionToken } from "./tokens.js";

export interface ScopeOptions {
  /** The owner promises to await start() before admitting work. Never inherited. */
  startup?: boolean;
}

/**
 * A hierarchical dependency container and resource owner.
 *
 * Child scopes resolve ancestor providers while retaining ownership of their
 * own resources.
 */
export class Scope {
  readonly #parent: Scope | undefined;
  readonly #root: Scope;
  #graph: ResolutionTracker | undefined;
  #resources: ResourceLifecycle | undefined;
  #instances: Map<InjectionToken<unknown>, unknown> | undefined;
  #factories: Map<InjectionToken<unknown>, Factory<unknown>> | undefined;
  #resolving: Set<InjectionToken<unknown>> | undefined;
  #disposePromise: Promise<void> | undefined;
  readonly #startup: boolean;

  constructor(parent?: Scope, options?: ScopeOptions) {
    this.#parent = parent;
    this.#root = parent ? parent.#root : this;
    this.#startup = options?.startup === true;
  }

  get #resourceLifecycle(): ResourceLifecycle {
    return (this.#resources ??= new ResourceLifecycle(
      this,
      this.#startup,
      this.#parent ? this.#parent.#resourceLifecycle : undefined,
    ));
  }

  get #resolutionTracker(): ResolutionTracker | undefined {
    if (this.#root.#resources?.disposed) {
      return undefined;
    }

    return (this.#root.#graph ??= new ResolutionTracker());
  }

  /** A child scope resolves application singletons through its parent. */
  child(): Scope {
    this.#resources?.assertOpen();
    return new Scope(this);
  }

  /** Includes failed attempts and active children, but never disposed scope nodes. */
  resolutionGraph(): ResolutionGraph {
    return this.#root.#graph?.snapshot() ?? { nodes: [], edges: [] };
  }

  provide<T>(token: InjectionToken<T>, factory: Factory<T>): void {
    this.#resources?.assertOpen();
    (this.#factories ??= new Map()).set(token, factory as Factory<unknown>);
  }

  has(token: InjectionToken<unknown>): boolean {
    return (
      (this.#instances?.has(token) ?? false) ||
      (this.#factories?.has(token) ?? false) ||
      (this.#parent?.has(token) ?? false)
    );
  }

  /** Resolve local cache/provider, then ancestors; default classes live at root. */
  get<T>(token: InjectionToken<T>): T {
    this.#resources?.assertNotDisposed();
    if (this.#instances?.has(token)) {
      this.#resolutionTracker?.record(this, token);
      return this.#instances.get(token) as T;
    }

    // Ancestors own their own admission; a closing child may still read singletons.
    if (!this.#factories?.has(token) && this.#parent) {
      return this.#parent.get(token);
    }
    this.#resources?.assertOpen();

    return this.#acquire(token, () => {
      const factory = this.#factories?.get(token);
      if (factory) {
        return factory(this) as T;
      }
      if (typeof token === "function") {
        return new token();
      }

      throw new ResolutionError("missing-provider", token);
    });
  }

  /** Acquire inline resources once per scope, with explicit or automatic disposal. */
  use<T>(
    token: InjectionToken<T>,
    factory: () => T,
    dispose?: (value: T) => unknown | Promise<unknown>,
  ): T {
    this.#resources?.assertNotDisposed();
    if (this.#instances?.has(token)) {
      this.#resolutionTracker?.record(this, token);
      return this.#instances.get(token) as T;
    }

    this.#resources?.assertOpen();
    return this.#acquire(token, factory, dispose);
  }

  /** Register LIFO cleanup, including cleanup acquired during teardown itself. */
  defer(cleanup: () => unknown | Promise<unknown>): void {
    this.#resourceLifecycle.defer(cleanup);
  }

  /** @internal Startup callbacks commit only after successful construction. */
  addStartup(callback: () => void | PromiseLike<void>): void {
    this.#resourceLifecycle.addStartup(callback);
  }

  start(): Promise<void> {
    return this.#resourceLifecycle.start();
  }

  /** Whether resolved resources queued initialization that only start() can run. */
  get startupPending(): boolean {
    return this.#resourceLifecycle.startupPending;
  }

  /** Seal synchronous admission; pending hooks require awaiting start() instead. */
  sealStartup(): void {
    this.#resourceLifecycle.sealStartup();
  }

  /** Close acquisition synchronously, then clear resolution storage after teardown. */
  [Symbol.asyncDispose](): Promise<void> {
    if (this.#disposePromise) {
      return this.#disposePromise;
    }

    this.#disposePromise = this.#resourceLifecycle.close().finally(() => {
      this.#instances = undefined;
      this.#factories = undefined;
      this.#resolving = undefined;

      if (this === this.#root) {
        this.#graph = undefined;
      } else {
        this.#root.#graph?.remove(this);
      }
    });

    return this.#disposePromise;
  }

  #acquire<T>(
    token: InjectionToken<T>,
    factory: () => T,
    dispose?: (value: T) => unknown | Promise<unknown>,
  ): T {
    const graph = this.#resolutionTracker;
    const id = graph?.record(this, token);
    const resolving = (this.#resolving ??= new Set());
    if (resolving.has(token)) {
      throw new ResolutionError("circular-dependency", token);
    }

    resolving.add(token);
    if (id !== undefined) {
      graph!.stack.push(id);
    }

    try {
      const value = this.#resourceLifecycle.construct(factory, dispose);
      (this.#instances ??= new Map()).set(token, value);

      return value;
    } finally {
      resolving.delete(token);
      if (id !== undefined) {
        graph!.stack.pop();
      }
    }
  }
}
