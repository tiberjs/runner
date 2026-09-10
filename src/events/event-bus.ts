import { begin, execute } from "../runtime/execution.js";
import { fork } from "../runtime/fork.js";
import { currentState, runWith, type RuntimeState } from "../runtime/state.js";

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
/** Asynchronous deliveries run in independent, bus-owned executions. */
export type AsyncEventListener<T> = (event: T) => void | PromiseLike<void>;

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
  #listeners: Map<symbol, Set<Subscription>> | undefined;
  #owner: RuntimeState | undefined;
  #closing: Promise<void> | undefined;

  on<T>(key: EventKey<T>, listener: EventListener<NoInfer<T>>): () => void {
    return this.#subscribe(key, listener, false);
  }

  onAsync<T>(key: EventKey<T>, listener: AsyncEventListener<NoInfer<T>>): () => void {
    return this.#subscribe(key, listener, true);
  }

  #subscribe<T>(key: EventKey<T>, listener: AsyncEventListener<T>, async: boolean): () => void {
    if (this.#closing) {
      throw new Error("Event bus is closed");
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
    const subscribers = this.#listeners?.get(key.id);
    if (!subscribers?.size) {
      return;
    }

    // Snapshot admission before user code can unsubscribe, emit, or close the bus.
    const snapshot = [...subscribers];
    let release: (() => void) | undefined;
    if (snapshot.some((subscription) => subscription.async)) {
      const owner = (this.#owner ??= begin({
        signal: new AbortController().signal,
        attachment: undefined,
      }));
      const admitted = Promise.withResolvers<void>();
      release = admitted.resolve;
      // Reserve the whole emission before its first callback. A reentrant close
      // must also join async subscribers later in this already-admitted snapshot.
      runWith(owner, () => fork(() => admitted.promise));
    }

    try {
      for (const subscription of snapshot) {
        if (subscription.async) {
          runWith(this.#owner!, () =>
            fork(async () => {
              try {
                await execute(
                  { signal: currentState().context.signal, attachment: undefined },
                  async () => subscription.listener(event as never),
                );
              } catch (error) {
                // Observe within the owned task: the long-lived bus TaskGroup must
                // not retain a failed Task for every broken notification sink.
                reportListenerError(key.description, error);
              }
            }),
          );
        } else {
          try {
            subscription.listener(event as never);
          } catch (error) {
            reportListenerError(key.description, error);
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
    await this.#owner?.tasks.join();
  }

  /** Stop admission synchronously, then join deliveries. Idempotent; never cancels. */
  close(): Promise<void> {
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
    void this.#shutdown().then(resolve, reject);
    return promise;
  }

  async #shutdown(): Promise<void> {
    await this.flush();
    if (this.#owner) {
      await this.#owner.tasks.close();
      await this.#owner.scope[Symbol.asyncDispose]();
      this.#owner = undefined;
    }
  }
}

function reportListenerError(description: string, error: unknown): void {
  try {
    console.error(`Event listener failed: ${description}`, error);
  } catch {
    // A broken diagnostic sink must not change the execution outcome.
  }
}
