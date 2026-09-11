import { ContextFrame } from "../execution/context/frame.js";
import type { ExecutionContext, ExecutionSeed } from "../execution/context/execution-context.js";
import { LifecycleDependencyError, LifecycleStateError } from "../errors.js";
import type { Supervisor } from "../supervisor/supervisor.js";
import { isCancellation } from "./abort.js";
import { CancellationBindings } from "./cancellation-bindings.js";
import { FailureSet } from "./failure-set.js";
import { peekState, runWith, withoutExecution } from "../execution/state.js";

export interface JobStartOptions {
  readonly parent?: Job<unknown>;
  readonly context?: ExecutionContext;
  readonly propagation?: "propagate" | "isolate";
}

export type JobState = "created" | "running" | "closing" | "closed";
export type JobResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

const CHILD_FAILED = new DOMException("A child job failed", "AbortError");

/** A cold, single-use execution and the lifetime of its actual descendants. */
export class Job<T> implements PromiseLike<T>, AsyncDisposable {
  private readonly controller = new AbortController();
  private readonly settled = Promise.withResolvers<JobResult<unknown>>();
  private children: Set<Job<unknown>> | undefined;
  private owner: Job<unknown> | undefined;
  private executionContext: ExecutionContext | undefined;
  private phase: JobState = "created";
  private propagation: "propagate" | "isolate" = "propagate";
  private supervisor: Supervisor<unknown> | undefined;
  private propagateFailureToParent = false;
  private failures: FailureSet | undefined;
  private cancellation: CancellationBindings | undefined;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly body: () => T | PromiseLike<T>,
    private readonly seed?: ExecutionSeed,
  ) {
    if (typeof body !== "function") {
      throw new TypeError("Job requires a body.");
    }
  }

  get parent(): Job<unknown> | undefined {
    return this.owner;
  }

  get context(): ExecutionContext {
    if (!this.executionContext) {
      throw new LifecycleStateError("Job", "context", this.phase);
    }
    return this.executionContext;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get state(): JobState {
    return this.phase;
  }

  get failed(): boolean {
    return (this.failures?.size ?? 0) > 0;
  }

  get failure(): unknown {
    return this.failures?.value;
  }

  get size(): number {
    return this.children?.size ?? 0;
  }

  owns(other: Job<unknown> | undefined): boolean {
    for (let node = other; node; node = node.owner) {
      if (node === this) {
        return true;
      }
    }
    return false;
  }

  /** Bind an optional manager before activation; ownership remains on this Job. */
  manage(supervisor: Supervisor<unknown>): void {
    if (this.phase !== "created" || this.supervisor) {
      throw new LifecycleStateError("Job", "manage", this.phase);
    }
    this.supervisor = supervisor;
  }

  start(options: JobStartOptions = {}): this {
    if (this.phase !== "created") {
      throw new LifecycleStateError("Job", "start", this.phase);
    }
    const current = peekState();
    const explicitParent = Object.hasOwn(options, "parent");
    const parent = explicitParent ? options.parent : current?.job;
    const inherited = options.context ?? (explicitParent ? parent?.context : current?.context);
    const propagation = options.propagation ?? "propagate";
    // Option accessors may have started or closed this same declaration.
    if (this.phase !== "created") {
      throw new LifecycleStateError("Job", "start", this.phase);
    }
    if (parent) {
      if (parent.phase !== "running") {
        throw new LifecycleStateError("Job", "start", parent.phase);
      }
      parent.signal.throwIfAborted();
    }
    this.owner = parent;
    this.propagation = propagation;
    this.phase = "running";
    if (parent) {
      (parent.children ??= new Set()).add(this);
    }
    withoutExecution(() => {
      void this.perform(inherited);
    });
    return this;
  }

  private prepare(inherited: ExecutionContext | undefined): void {
    // Ownership is committed; seed access and abort delivery see a base context.
    this.executionContext = {
      values: inherited?.values ?? ContextFrame.empty,
      signal: this.signal,
      deadline: inherited?.deadline,
      attachment: inherited?.attachment,
    };
    if (this.owner) {
      (this.cancellation ??= new CancellationBindings()).link(this.owner.signal, this.controller);
    }
    if (inherited?.signal) {
      (this.cancellation ??= new CancellationBindings()).link(inherited.signal, this.controller);
    }
    const entries = this.seed?.values;
    const externalSignal = this.seed?.signal;
    const requestedDeadline = this.seed?.deadline;
    const hasAttachment = this.seed !== undefined && "attachment" in this.seed;
    const attachment = hasAttachment ? this.seed!.attachment : inherited?.attachment;
    if (requestedDeadline !== undefined && !Number.isFinite(requestedDeadline)) {
      throw new RangeError("Deadline must be finite.");
    }
    const deadline =
      requestedDeadline === undefined
        ? inherited?.deadline
        : Math.min(requestedDeadline, inherited?.deadline ?? Infinity);
    const base = inherited?.values ?? ContextFrame.empty;
    this.executionContext = {
      values:
        entries instanceof ContextFrame
          ? entries
          : entries === undefined
            ? base
            : base.withEntries(entries),
      signal: this.signal,
      deadline,
      attachment,
    };
    if (externalSignal && externalSignal !== this.signal) {
      (this.cancellation ??= new CancellationBindings()).link(externalSignal, this.controller);
    }
    const ownerDeadline = this.owner?.context.deadline;
    if (deadline !== undefined && (ownerDeadline === undefined || deadline < ownerDeadline)) {
      (this.cancellation ??= new CancellationBindings()).deadline(deadline, () => {
        this.cancel(new DOMException("Job deadline exceeded", "TimeoutError"));
      });
    }
  }

  private async perform(inherited: ExecutionContext | undefined): Promise<void> {
    let value: T | undefined;
    let rejected = false;
    let rejection: unknown;
    let preserveCancellation = false;
    try {
      this.prepare(inherited);
      value = await runWith({ job: this, context: this.context }, async () => {
        try {
          this.signal.throwIfAborted();
          return await this.body();
        } catch (error) {
          // Capture before a caller can cancel with this same value.
          this.recordFailure(error);
          throw error;
        }
      });
      this.signal.throwIfAborted();
    } catch (error) {
      rejected = true;
      rejection = error;
      this.recordFailure(error);
      this.cancel(error);
      preserveCancellation =
        isCancellation(error, this.signal) &&
        this.signal.reason !== CHILD_FAILED &&
        !this.failures?.hasRecorded(error);
    }
    this.phase = "closing";
    await this.drain();
    let result: JobResult<unknown>;
    if (this.failed) {
      const failure = preserveCancellation
        ? this.failures!.combinedWith(rejection, "Cancellation and job execution failed.")
        : this.failure;
      if (preserveCancellation) {
        this.rememberFailure(failure);
      }
      result = { ok: false, error: failure };
    } else if (rejected || this.signal.aborted) {
      result = { ok: false, error: rejected ? rejection : this.signal.reason };
    } else {
      result = { ok: true, value };
    }
    this.complete(result);
  }

  private recordFailure(error: unknown): void {
    if (this.failures?.recognizes(error) || isCancellation(error, this.signal)) {
      return;
    }
    const failures = (this.failures ??= new FailureSet("Job execution failed."));
    failures.record(error);
    if (this.propagation === "propagate" && this.owner) {
      this.propagateFailureToParent = this.owner.supervisor?.childFailed(this) ?? true;
      if (this.propagateFailureToParent) {
        this.owner.recordFailure(error);
      }
    }
    // Failure identity and its ownership policy are recorded before cancellation.
    this.cancel(CHILD_FAILED);
    if (failures.size > 1) {
      this.rememberFailure(failures.value);
    }
  }

  private rememberFailure(error: unknown): void {
    (this.failures ??= new FailureSet("Job execution failed.")).remember(error);
    if (this.propagateFailureToParent && this.owner) {
      this.owner.rememberFailure(error);
    }
  }

  cancel(reason?: unknown): void {
    if (this.phase === "closed") {
      return;
    }
    this.controller.abort(reason);
    // Also reach children admitted before signal linking has finished.
    for (const child of this.children ?? []) {
      child.cancel(this.signal.reason);
    }
  }

  private dependency(operation: string): LifecycleDependencyError | undefined {
    return this.owns(peekState()?.job)
      ? new LifecycleDependencyError("Job", operation, "Job")
      : undefined;
  }

  async join(): Promise<T> {
    const dependency = this.dependency("join");
    if (dependency) {
      throw dependency;
    }
    if (this.phase === "created") {
      throw new LifecycleStateError("Job", "join", this.phase);
    }
    const result = await this.settled.promise;
    if (!result.ok) {
      throw result.error;
    }
    return result.value as T;
  }

  // oxlint-disable-next-line unicorn/no-thenable -- Job deliberately implements PromiseLike.
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.join().then(onfulfilled, onrejected);
  }

  /** Observe complete success or failure as a value, without unwrapping it. */
  result(): Promise<JobResult<T>> {
    const dependency = this.dependency("result");
    if (dependency) {
      throw dependency;
    }
    return this.settled.promise as Promise<JobResult<T>>;
  }

  joinChildren(): Promise<void> {
    const current = peekState()?.job;
    if (current !== this && this.owns(current)) {
      return Promise.reject(new LifecycleDependencyError("Job", "joinChildren", "Job"));
    }
    return this.drain();
  }

  private async drain(): Promise<void> {
    while (this.children?.size) {
      await Promise.all([...this.children].map((child) => child.settled.promise));
    }
  }

  finish(): Promise<T> {
    const dependency = this.dependency("finish");
    if (dependency) {
      return Promise.reject(dependency);
    }
    if (this.phase === "running") {
      this.phase = "closing";
    }
    return this.join();
  }

  close(reason?: unknown): Promise<void> {
    const dependency = this.dependency("close");
    if (dependency) {
      return Promise.reject(dependency);
    }
    if (this.closing) {
      return this.closing;
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.closing = promise;
    const cold = this.phase === "created";
    if (this.phase !== "closed") {
      this.phase = "closing";
      this.cancel(reason);
      if (cold) {
        this.complete({ ok: false, error: this.signal.reason });
      }
    }
    void this.settled.promise.then((result) => {
      if (!result.ok && this.failed) {
        reject(result.error);
      } else {
        resolve();
      }
    });
    return promise;
  }

  private complete(result: JobResult<unknown>): void {
    this.phase = "closed";
    this.cancellation?.[Symbol.dispose]();
    this.cancellation = undefined;
    this.owner?.children?.delete(this);
    this.settled.resolve(result);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
