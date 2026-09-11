import { addAbortListener } from "node:events";
import { activeScope } from "../di/active-scope.js";
import { combinedError } from "../lifecycle/errors.js";
import { currentState, peekState, runWith, withoutExecution, type RuntimeState } from "./state.js";

type CancelHandler = (reason: unknown) => void | PromiseLike<void>;

/** Register native cancellation actions for the duration of one call. */
export interface CallContext {
  readonly onCancel: (handler: CancelHandler) => void;
}

/** An opt-in cancellation capability, independent of construction and resource disposal. */
export abstract class Cancelable {
  #binding: CancellationBinding | undefined;

  abstract cancel(reason: unknown): void | PromiseLike<void>;

  /**
   * Bind this instance to an explicit signal, or the current Runner execution.
   * Dispose the returned registration to disconnect and join any invoked cancel.
   * One registration at a time; disposing it never disposes or cancels this instance.
   */
  cancelable(signal: AbortSignal = currentState().context.signal): AsyncDisposable {
    if (this.#binding) {
      throw new Error("This instance already has a cancellation registration.");
    }
    const binding = new CancellationBinding(signal, () => {
      this.#binding = undefined;
    });
    this.#binding = binding;
    binding.onCancel((reason) => this.cancel(reason));
    return binding;
  }
}

/**
 * Connect explicitly registered cancellation actions while awaiting a native operation.
 * This does not fork, create a scope, or settle before the handler actually finishes.
 */
export async function call<T>(handler: (context: CallContext) => T | PromiseLike<T>): Promise<T> {
  if (typeof handler !== "function") {
    throw new TypeError("call() requires a handler.");
  }
  const signal = currentState().context.signal;
  signal.throwIfAborted();
  let result: T;
  {
    await using binding = new CancellationBinding(signal);
    result = await handler({ onCancel: (cancel) => binding.onCancel(cancel) });
    signal.throwIfAborted();
  }
  signal.throwIfAborted();
  return result;
}

/** Owns cancellation delivery and its completion, but never the native operation itself. */
class CancellationBinding implements AsyncDisposable {
  #state: RuntimeState | undefined = peekState();
  #subscription: Disposable | undefined;
  #handlers: CancelHandler[] | undefined;
  #pending: Promise<void>[] | undefined;
  #errors: unknown[] | undefined;
  #aborted = false;
  #reason: unknown;
  #closing: Promise<void> | undefined;
  #release: (() => void) | undefined;

  constructor(signal: AbortSignal, release?: () => void) {
    this.#release = release;
    if (signal.aborted) {
      this.#aborted = true;
      this.#reason = signal.reason;
    } else {
      // Unlike an ordinary abort listener, this cannot be suppressed by another
      // listener calling stopImmediatePropagation().
      this.#subscription = addAbortListener(signal, () => this.#abort(signal.reason));
    }
  }

  onCancel(handler: CancelHandler): void {
    if (this.#closing) {
      throw new Error("Cancellation registration is closed.");
    }
    if (typeof handler !== "function") {
      throw new TypeError("onCancel() requires a handler.");
    }
    if (this.#aborted) {
      this.#invoke(handler);
    } else {
      (this.#handlers ??= []).push(handler);
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }
    // A retained, closed registration must not retain its disposing execution.
    return activeScope.exit(() =>
      withoutExecution(() => {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        this.#closing = promise;
        this.#subscription?.[Symbol.dispose]();
        this.#subscription = undefined;
        this.#handlers = undefined;
        void this.#finish().then(resolve, reject);
        return promise;
      }),
    );
  }

  #abort(reason: unknown): void {
    if (this.#closing || this.#aborted) {
      return;
    }
    this.#aborted = true;
    this.#reason = reason;
    const handlers = this.#handlers;
    this.#handlers = undefined;
    if (handlers) {
      // Start all admitted actions before joining any: one may unblock another.
      for (const handler of handlers) {
        this.#invoke(handler);
      }
    }
  }

  #invoke(handler: CancelHandler): void {
    // Neither completion bookkeeping nor native promise observation may retain
    // the execution/factory that happened to call AbortController.abort().
    activeScope.exit(() =>
      withoutExecution(() => {
        const { promise, resolve } = Promise.withResolvers<void>();
        (this.#pending ??= []).push(promise);
        try {
          // Reserve completion before user code can dispose this registration.
          const result = this.#state
            ? runWith(this.#state, () => handler(this.#reason))
            : handler(this.#reason);
          if (result === undefined) {
            resolve();
          } else {
            void Promise.resolve(result).then(resolve, (error: unknown) => {
              (this.#errors ??= []).push(error);
              resolve();
            });
          }
        } catch (error) {
          (this.#errors ??= []).push(error);
          resolve();
        }
      }),
    );
  }

  async #finish(): Promise<void> {
    try {
      // A reentrant disposer may start during the first cancellation action.
      // Re-read the length so it also joins later actions from that same abort.
      for (let index = 0; index < (this.#pending?.length ?? 0); index++) {
        await this.#pending![index];
      }
      if (this.#errors) {
        throw combinedError(this.#errors, "Cancellation actions failed.");
      }
    } finally {
      this.#state = undefined;
      this.#reason = undefined;
      this.#pending = undefined;
      this.#errors = undefined;
      const release = this.#release;
      this.#release = undefined;
      release?.();
    }
  }
}
