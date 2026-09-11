import { activeScope } from "../di/active-scope.js";
import { Scope } from "../di/scope.js";
import { AppClosed, AppClosing, AppStarted } from "../events/application.js";
import { EventBus, type EventBusOptions } from "../events/event-bus.js";
import { withoutExecution } from "../runtime/state.js";
import { combinedError } from "./errors.js";
import { TaskSupervisor } from "./task-supervisor.js";
import {
  assertCanJoin,
  dependencyFrame,
  LifecycleStateError,
  markDependency,
  releaseDependency,
  runWithDependency,
  startupDependency,
  withoutDependencies,
  type DependencyToken,
} from "./diagnostics.js";

export interface ApplicationLifecycleOptions {
  readonly events?: EventBusOptions;
}

type Drain = () => void | Promise<void>;

/** Root startup, admission state, drain barrier, and singleton teardown. */
export class ApplicationLifecycle implements AsyncDisposable {
  readonly scope: Scope;
  readonly events: EventBus;
  readonly background: TaskSupervisor;
  #starting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #started = false;
  #closed = false;
  readonly #shutdownDependency: DependencyToken = { owner: "application shutdown" };
  #drainers: Set<{ callback: Drain }> | undefined;

  constructor(options: ApplicationLifecycleOptions = {}) {
    this.scope = new Scope(undefined, { startup: true });
    this.events = new EventBus(this.scope, options.events);
    this.scope.provide(EventBus, () => this.events);
    const admit = () => this.admit();
    markDependency(admit, startupDependency(this.scope));
    this.background = new TaskSupervisor(this.scope, admit);
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
      throw new LifecycleStateError(
        "ApplicationLifecycle",
        "onDrain",
        this.#closed ? "closed" : "closing",
      );
    }

    const subscription = { callback };
    (this.#drainers ??= new Set()).add(subscription);

    return () => {
      this.#drainers?.delete(subscription);
    };
  }

  start(): Promise<void> {
    if (this.#closing) {
      return Promise.reject(
        new LifecycleStateError(
          "ApplicationLifecycle",
          "start",
          this.#closed ? "closed" : "closing",
        ),
      );
    }
    try {
      assertCanJoin(startupDependency(this.scope), "start", "ApplicationLifecycle");
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#starting) {
      return this.#starting;
    }

    // Startup belongs to the application, not the request/task/factory that
    // first admits work. Allocate the shared promise outside those contexts too.
    return withoutDependencies(() =>
      activeScope.exit(() =>
        withoutExecution(() => {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          this.#starting = promise;
          markDependency(promise, startupDependency(this.scope));
          void this.scope.start().then(() => {
            try {
              if (!this.#closing) {
                this.#started = true;
                this.events.emit(AppStarted, undefined);
              }
              resolve();
            } catch (error) {
              this.#started = false;
              reject(error);
            }
          }, reject);

          return promise;
        }),
      ),
    );
  }

  /** Call before serving work, including transports that do not require start(). */
  sealStartup(): void {
    if (this.#closing) {
      throw new LifecycleStateError(
        "ApplicationLifecycle",
        "sealStartup",
        this.#closed ? "closed" : "closing",
      );
    }
    this.scope.sealStartup();
  }

  /**
   * Admit work: join an in-progress or queued startup, else seal synchronously.
   * Bindings that admit lazily (fetch) use this; listen must seal explicitly.
   */
  admit(): Promise<void> | undefined {
    if (this.#closing) {
      throw new LifecycleStateError(
        "ApplicationLifecycle",
        "admit",
        this.#closed ? "closed" : "closing",
      );
    }
    if (this.#starting) {
      assertCanJoin(startupDependency(this.scope), "admit", "ApplicationLifecycle");
      return this.#starting;
    }
    if (this.scope.startupPending) {
      return this.start();
    }
    this.scope.sealStartup();
    return undefined;
  }

  close(): Promise<void> {
    try {
      assertCanJoin(startupDependency(this.scope), "close", "ApplicationLifecycle");
      assertCanJoin(this.#shutdownDependency, "close", "ApplicationLifecycle");
      this.background.assertCanJoin("close", "ApplicationLifecycle");
      this.events.assertCanJoin("close", "ApplicationLifecycle");
    } catch (error) {
      return Promise.reject(error);
    }
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
    try {
      // Cancel before drainers run: a drainer may be waiting for a background task.
      const background = Promise.allSettled([this.background.close()]);
      const errors: unknown[] = [];
      try {
        this.events.emit(AppClosing, undefined);
      } catch (error) {
        errors.push(error);
      }
      const draining = this.#drain();

      let startupFailed = false;
      let startupFailure: unknown;
      try {
        await this.#starting;
      } catch (error) {
        startupFailed = true;
        startupFailure = error;
      }

      errors.push(...(await draining));
      const [backgroundOutcome] = await background;
      // Startup already owns the shared admission failure; do not repeat it for submissions.
      if (
        backgroundOutcome.status === "rejected" &&
        !(
          startupFailed &&
          (Object.is(backgroundOutcome.reason, startupFailure) ||
            (backgroundOutcome.reason instanceof AggregateError &&
              backgroundOutcome.reason.errors.every((error) => Object.is(error, startupFailure))))
        )
      ) {
        errors.push(backgroundOutcome.reason);
      }
      try {
        await this.events.flush();
      } catch (error) {
        errors.push(error);
      }

      const disposal = dependencyFrame(this.#shutdownDependency);
      try {
        await runWithDependency(disposal, () => this.scope[Symbol.asyncDispose]());
      } catch (error) {
        // Scope owns its startup failure too. Preserve it once by identity.
        if (
          startupFailed &&
          (Object.is(error, startupFailure) ||
            (error instanceof AggregateError && error.errors.includes(startupFailure)))
        ) {
          startupFailed = false;
        }
        errors.push(error);
      } finally {
        releaseDependency(disposal);
      }
      if (startupFailed) {
        errors.push(startupFailure);
      }

      const count = errors.length;
      const error = count ? combinedError(errors, "Application shutdown failed.") : undefined;
      try {
        this.events.emit(AppClosed, Object.freeze(count ? { error } : {}));
      } catch (notificationError) {
        errors.push(notificationError);
      }
      try {
        await this.events.close();
      } catch (closeError) {
        errors.push(closeError);
      }
      if (errors.length) {
        throw errors.length === count
          ? error
          : combinedError(errors, "Application shutdown failed.");
      }
    } finally {
      this.#closed = true;
    }
  }

  async #drain(): Promise<unknown[]> {
    // Invoke every hook before awaiting any one: one hook may release another's work.
    const pending: Promise<void>[] = [];
    const subscriptions = this.#drainers;
    this.#drainers = undefined;
    for (const { callback } of subscriptions ?? []) {
      const frame = dependencyFrame(this.#shutdownDependency);
      pending.push(
        runWithDependency(frame, async () => {
          try {
            await callback();
          } finally {
            releaseDependency(frame);
          }
        }),
      );
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
