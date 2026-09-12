import { addAbortListener } from "node:events";
import { isCancellation } from "./abort.js";
import { scheduleDeadline } from "./deadline.js";

/** The Job whose subtree a delivered cancellation must reach. */
export interface CancellationTarget {
  cancel(reason: unknown): void;
}

const DEADLINE_EXCEEDED = "Job deadline exceeded";

/**
 * One Job's incoming cancellation: its own signal, the external sources it
 * follows, and the deadline it owns. Everything here is created on demand.
 *
 * - The `AbortController` exists only once something aborts or reads the signal.
 * - External sources are recorded by `follow()` and subscribed to by `observe()`,
 *   the first time the Job's cancellation becomes observable. `recheck()` honors a
 *   source that aborted while nothing observed, without subscribing.
 * - The target's `cancel()` receives every delivery, so cascades stay the Job's.
 *
 * It owns no lifetime and no completion state.
 */
export class Cancellation {
  private controller: AbortController | undefined;
  private pendingInherited: AbortSignal | undefined;
  private pendingExternal: AbortSignal | undefined;
  private links: Map<AbortSignal, Disposable | undefined> | undefined;
  private timer: Disposable | undefined;

  constructor(private readonly target: CancellationTarget) {}

  get aborted(): boolean {
    return this.controller?.signal.aborted === true;
  }

  get reason(): unknown {
    return this.controller?.signal.reason;
  }

  /** The signal only once it has been created; `undefined` means "not aborted". */
  get current(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  /** The Job's signal; reading it subscribes to the followed sources. */
  get signal(): AbortSignal {
    if (this.pendingInherited !== undefined || this.pendingExternal !== undefined) {
      this.observe();
    }
    return (this.controller ??= new AbortController()).signal;
  }

  throwIfAborted(): void {
    this.controller?.signal.throwIfAborted();
  }

  isCancellation(error: unknown): boolean {
    return this.controller !== undefined && isCancellation(error, this.controller.signal);
  }

  abort(reason: unknown): void {
    (this.controller ??= new AbortController()).abort(reason);
  }

  /**
   * Record the sources this Job follows. An already-aborted source cancels now;
   * a live one is subscribed to only when the Job's cancellation is observed.
   */
  follow(inherited: AbortSignal | undefined, external: AbortSignal | undefined): void {
    const own = this.controller?.signal;
    if (inherited !== undefined && inherited !== own) {
      this.pendingInherited = inherited;
    }
    if (external !== undefined && external !== own) {
      this.pendingExternal = external;
    }
    this.recheck();
  }

  /** Honor a followed source that aborted while nothing observed, without subscribing. */
  recheck(): void {
    if (this.aborted) {
      return;
    }
    const inherited = this.pendingInherited;
    if (inherited?.aborted) {
      this.target.cancel(inherited.reason);
      return;
    }
    const external = this.pendingExternal;
    if (external?.aborted) {
      this.target.cancel(external.reason);
    }
  }

  /** Subscribe to the followed sources now that the Job's cancellation is observable. */
  observe(): void {
    const inherited = this.pendingInherited;
    const external = this.pendingExternal;
    this.pendingInherited = undefined;
    this.pendingExternal = undefined;
    if (this.aborted) {
      return;
    }
    if (inherited !== undefined) {
      this.link(inherited);
    }
    // Linking an already-aborted inherited source cancels synchronously.
    if (external !== undefined && !this.aborted) {
      this.link(external);
    }
  }

  /** Own a deadline; the target is cancelled with a `TimeoutError` when it elapses. */
  deadline(at: number): void {
    this.timer = scheduleDeadline(at, () => {
      this.target.cancel(new DOMException(DEADLINE_EXCEEDED, "TimeoutError"));
    });
  }

  /** Release subscriptions and the timer. The signal, if any, keeps its state. */
  dispose(): void {
    this.timer?.[Symbol.dispose]();
    this.timer = undefined;
    for (const subscription of this.links?.values() ?? []) {
      subscription?.[Symbol.dispose]();
    }
    this.links = undefined;
    this.pendingInherited = undefined;
    this.pendingExternal = undefined;
  }

  private link(source: AbortSignal): void {
    const links = (this.links ??= new Map());
    if (links.has(source)) {
      return;
    }
    if (source.aborted) {
      links.set(source, undefined);
      this.target.cancel(source.reason);
      return;
    }

    let delivered = false;
    const deliver = (): void => {
      if (!delivered) {
        delivered = true;
        this.target.cancel(source.reason);
      }
    };
    const subscription = addAbortListener(source, deliver);
    links.set(source, subscription);
    // Listener installation can itself reenter source cancellation.
    if (source.aborted) {
      deliver();
    }
  }
}
