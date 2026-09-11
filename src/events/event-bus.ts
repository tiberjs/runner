import { activeScope } from "../di/active-scope.js";
import { Scope } from "../di/scope.js";
import { LifecycleStateError, withoutDependencies } from "../lifecycle/diagnostics.js";
import { TaskSupervisor } from "../lifecycle/task-supervisor.js";
import { withoutExecution } from "../runtime/state.js";

/** A typed event identity. Equal descriptions do not imply equal events. */
export interface EventKey<T> {
  readonly id: symbol;
  readonly description: string;
  /** Phantom carrier; never present at runtime. */
  readonly _type?: T;
}

export function eventKey<T>(description: string): EventKey<T> {
  return Object.freeze({ id: Symbol(description), description });
}

/** Synchronous notifications cannot return asynchronous work. */
export type EventListener<T> = (event: T) => undefined;
/**
 * Asynchronous deliveries run in independent, bus-owned executions. Each owns a
 * scope disposed when its delivery settles.
 */
export type AsyncEventListener<T> = (event: T) => void | PromiseLike<void>;

/** Details identifying a failed event delivery. */
export interface EventErrorContext {
  readonly event: string;
}

export interface EventBusOptions {
  /** Synchronous diagnostics; any asynchronous work remains caller-owned. */
  readonly onError?: (error: unknown, context: EventErrorContext) => undefined;
}

type Subscription = {
  readonly listener: AsyncEventListener<never>;
  readonly async: boolean;
};

/**
 * Instance-local notifications started in registration order. Subscribers present
 * at emission start receive that emission; subscription changes affect the next.
 * Listener errors are reported without changing the emitting execution's result.
 */
export class EventBus {
  /** Parent of every delivery scope; owned and disposed by this bus. */
  readonly #deliveries: Scope;
  #listeners: Map<symbol, Set<Subscription>> | undefined;
  #supervisor: TaskSupervisor | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;
  readonly #onError: EventBusOptions["onError"];

  /**
   * Asynchronous deliveries resolve dependencies through `scope`. Without one,
   * a delivery owns its resources but reaches no application provider.
   */
  constructor(scope?: Scope, options?: EventBusOptions) {
    const onError = options?.onError;
    if (onError !== undefined && typeof onError !== "function") {
      throw new TypeError("EventBus onError must be a function.");
    }
    this.#onError = onError;
    this.#deliveries = scope ? scope.child() : new Scope();
  }

  on<T>(key: EventKey<T>, listener: EventListener<NoInfer<T>>): () => void {
    return this.#subscribe(key, listener, false);
  }

  onAsync<T>(key: EventKey<T>, listener: AsyncEventListener<NoInfer<T>>): () => void {
    return this.#subscribe(key, listener, true);
  }

  #subscribe<T>(key: EventKey<T>, listener: AsyncEventListener<T>, async: boolean): () => void {
    if (this.#closing) {
      throw new LifecycleStateError(
        "EventBus",
        async ? "onAsync" : "on",
        this.#closed ? "closed" : "closing",
      );
    }

    const listeners = (this.#listeners ??= new Map());
    let subscribers = listeners.get(key.id);
    if (!subscribers) {
      listeners.set(key.id, (subscribers = new Set()));
    }

    // Each subscription has its own lifetime, even for the same callback.
    const subscription: Subscription = { listener, async };
    subscribers.add(subscription);

    return () => {
      subscribers.delete(subscription);
      if (subscribers.size === 0 && listeners.get(key.id) === subscribers) {
        listeners.delete(key.id);
      }
    };
  }

  hasListeners<T>(key: EventKey<T>): boolean {
    return (this.#listeners?.get(key.id)?.size ?? 0) > 0;
  }

  emit<T>(key: EventKey<T>, event: NoInfer<T>): void {
    if (this.#closing) {
      throw new LifecycleStateError("EventBus", "emit", this.#closed ? "closed" : "closing");
    }

    const subscribers = this.#listeners?.get(key.id);
    if (!subscribers?.size) {
      return;
    }

    // Snapshot admission before user code can unsubscribe, emit, or close the bus.
    const snapshot = [...subscribers];
    let release: (() => void) | undefined;
    if (snapshot.some((subscription) => subscription.async)) {
      // Deliveries have no application startup gate: startup itself may emit.
      const supervisor = (this.#supervisor ??= new TaskSupervisor(this.#deliveries));
      const admitted = Promise.withResolvers<void>();
      release = admitted.resolve;
      // Reserve the whole emission before its first callback. A reentrant close
      // must also join async subscribers later in this already-admitted snapshot.
      supervisor.run(() => admitted.promise);
    }

    try {
      for (const subscription of snapshot) {
        if (subscription.async) {
          // Observe outside the emitter context too: a pending diagnostic
          // callback must not retain the request or its construction scope.
          void activeScope.exit(() =>
            withoutExecution(() =>
              withoutDependencies(() =>
                this.#supervisor!
                  .run(async () => subscription.listener(event as never))
                  .then(undefined, (error: unknown) => this.#report(key.description, error)),
              ),
            ),
          );
        } else {
          try {
            subscription.listener(event as never);
          } catch (error) {
            this.#report(key.description, error);
          }
        }
      }
    } finally {
      release?.();
    }
  }

  /**
   * Join admitted deliveries, including work admitted while joining, without
   * cancelling them. Do not await this barrier from a listener it must join.
   */
  async flush(): Promise<void> {
    this.assertCanJoin("flush");
    await this.#supervisor?.flush();
  }

  /** @internal Guard barriers that join this bus's listeners before changing state. */
  assertCanJoin(operation: string, owner = "EventBus"): void {
    this.#supervisor?.assertCanJoin(operation, owner);
  }

  /** Stop admission synchronously, then join deliveries. Idempotent; never cancels. */
  close(): Promise<void> {
    try {
      this.assertCanJoin("close");
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.#closing) {
      return this.#closing;
    }

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#closing = promise;
    for (const subscribers of this.#listeners?.values() ?? []) {
      subscribers.clear();
    }
    this.#listeners?.clear();
    this.#listeners = undefined;
    void this.#shutdown().then(
      () => {
        this.#closed = true;
        resolve();
      },
      (error: unknown) => {
        this.#closed = true;
        reject(error);
      },
    );
    return promise;
  }

  async #shutdown(): Promise<void> {
    await this.flush();
    if (this.#supervisor) {
      // flush() drained every admitted snapshot; close cannot cancel deliveries.
      await this.#supervisor.close();
      this.#supervisor = undefined;
    }

    await this.#deliveries[Symbol.asyncDispose]();
  }

  #report(description: string, error: unknown): void {
    activeScope.exit(() =>
      withoutExecution(() =>
        withoutDependencies(() => {
          if (!this.#onError) {
            reportListenerError(description, error);
            return;
          }
          try {
            this.#onError(error, { event: description });
          } catch (reporterError) {
            reportListenerError(description, error);
            reportListenerError(description, reporterError);
          }
        }),
      ),
    );
  }
}

function reportListenerError(description: string, error: unknown): void {
  try {
    console.error(`Event listener failed: ${description}`, error);
  } catch {
    // A broken diagnostic sink must not change the execution outcome.
  }
}
