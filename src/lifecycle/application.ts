import { Scope } from "../di/scope.js";
import { AppClosed, AppClosing, AppStarted } from "../events/application.js";
import { EventBus } from "../events/event-bus.js";
import { combinedError } from "./errors.js";

type Drain = () => void | Promise<void>;

/** Root startup, admission state, drain barrier, and singleton teardown. */
export class ApplicationLifecycle implements AsyncDisposable {
  readonly scope: Scope;
  readonly events: EventBus;
  #starting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #started = false;
  #drainers: Set<{ callback: Drain }> | undefined;

  constructor() {
    this.scope = new Scope(undefined, { startup: true });
    this.events = new EventBus(this.scope);
    this.scope.provide(EventBus, () => this.events);
  }

  get starting(): Promise<void> | undefined {
    return this.#starting;
  }

  get closing(): Promise<void> | undefined {
    return this.#closing;
  }

  get started(): boolean {
    return this.#started;
  }

  /** Register a producer shutdown hook, joined before event flushing and disposal. */
  onDrain(callback: Drain): () => void {
    if (this.#closing) {
      throw new Error("Application is closing");
    }

    const subscription = { callback };
    (this.#drainers ??= new Set()).add(subscription);

    return () => {
      this.#drainers?.delete(subscription);
    };
  }

  start(): Promise<void> {
    if (this.#closing) {
      return Promise.reject(new Error("Application is closing"));
    }
    if (this.#starting) {
      return this.#starting;
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#starting = promise;
    void this.scope.start().then(() => {
      if (!this.#closing) {
        this.#started = true;
        this.events.emit(AppStarted, undefined);
      }

      resolve();
    }, reject);

    return promise;
  }

  /** Call before serving work, including transports that do not require start(). */
  sealStartup(): void {
    if (this.#closing) {
      throw new Error("Application is closing");
    }
    this.scope.sealStartup();
  }

  /**
   * Admit work: join an in-progress or queued startup, else seal synchronously.
   * Bindings that admit lazily (fetch) use this; listen must seal explicitly.
   */
  admit(): Promise<void> | undefined {
    if (this.#closing) {
      throw new Error("Application is closing");
    }
    if (this.#starting) {
      return this.#starting;
    }
    if (this.scope.startupPending) {
      return this.start();
    }
    this.scope.sealStartup();
    return undefined;
  }

  close(): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // Publish admission closure before any notification or user callback can reenter.
    this.#closing = promise;
    void this.#shutdown().then(resolve, reject);

    return promise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #shutdown(): Promise<void> {
    this.events.emit(AppClosing, undefined);
    const draining = this.#drain();

    let startupFailed = false;
    let startupFailure: unknown;
    try {
      await this.#starting;
    } catch (error) {
      startupFailed = true;
      startupFailure = error;
    }

    const errors = await draining;
    await this.events.flush();

    try {
      await this.scope[Symbol.asyncDispose]();
    } catch (error) {
      // Scope owns its startup failure too. Do not report that same cause twice.
      if (
        startupFailed &&
        (Object.is(error, startupFailure) ||
          (error instanceof AggregateError && error.errors.includes(startupFailure)))
      ) {
        startupFailed = false;
      }

      errors.push(error);
    }
    if (startupFailed) {
      errors.push(startupFailure);
    }

    const error = errors.length ? combinedError(errors, "Application shutdown failed.") : undefined;
    this.events.emit(AppClosed, Object.freeze(errors.length ? { error } : {}));
    await this.events.close();

    if (errors.length) {
      throw error;
    }
  }

  async #drain(): Promise<unknown[]> {
    // Invoke every hook before awaiting any one: one hook may release another's work.
    const pending: Promise<void>[] = [];
    const subscriptions = this.#drainers;
    this.#drainers = undefined;
    for (const { callback } of subscriptions ?? []) {
      try {
        pending.push(Promise.resolve(callback()));
      } catch (error) {
        pending.push(Promise.reject(error));
      }
    }

    const errors: unknown[] = [];
    for (const result of await Promise.allSettled(pending)) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }

    return errors;
  }
}
