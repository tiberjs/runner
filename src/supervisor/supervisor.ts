import { GroupRunner } from "./group-runner.js";
import type { ExecutionSeed } from "../execution/context/execution-context.js";
import { Job, type JobStartOptions } from "../job/job.js";
import { peekState } from "../execution/state.js";
import { TaskGroup, type GroupMember, type GroupResults } from "./task-group.js";
import { LifecycleStateError, type LifecycleState } from "../errors.js";

export interface SupervisorOptions {
  readonly failure?: "fail-fast" | "isolate";
}

type Handler<T> = () => T | PromiseLike<T>;

/** Optional admission and failure policy for an ordinary, explicitly supplied Job. */
export class Supervisor<T = unknown, Published = T> implements AsyncDisposable {
  readonly job: Job<T, Published>;
  readonly failure: "fail-fast" | "isolate";
  #groupRunner: GroupRunner | undefined;

  constructor(job: Job<T, Published>, options: SupervisorOptions = {}) {
    const failure = options.failure ?? "isolate";
    if (failure !== "fail-fast" && failure !== "isolate") {
      throw new TypeError("Supervisor failure must be fail-fast or isolate.");
    }
    this.job = job;
    this.failure = failure;
    job.manage(this);
  }

  get state(): LifecycleState {
    return this.job.state;
  }

  start(options?: JobStartOptions): Job<T, Published> {
    if (this.job.state !== "created") {
      return this.job;
    }
    return this.job.start(options);
  }

  run<R>(handler: Handler<R>): Job<R>;
  run<R>(seed: ExecutionSeed, handler: Handler<R>): Job<R>;
  run<R, Value>(job: Job<R, Value>): Job<R, Value>;
  run<Members extends readonly GroupMember[]>(
    group: TaskGroup<Members>,
  ): Promise<GroupResults<Members>>;
  run(
    input:
      | ExecutionSeed
      | Handler<unknown>
      | Job<unknown, unknown>
      | TaskGroup<readonly GroupMember[]>,
    handler?: Handler<unknown>,
  ): Job<unknown, unknown> | Promise<unknown[]> {
    if (this.job.state !== "running" || this.job.signal.aborted) {
      throw new LifecycleStateError("Supervisor", "run", this.state);
    }
    if (input instanceof TaskGroup) {
      return (this.#groupRunner ??= new GroupRunner(this.job)).run(input);
    }
    const child =
      input instanceof Job
        ? input
        : typeof input === "function"
          ? new Job(input)
          : new Job(handler!, input);
    return child.start({ parent: this.job });
  }

  ownsCurrent(): boolean {
    return this.job.owns(peekState()?.job);
  }

  flush(): Promise<void> {
    return this.job.joinChildren();
  }

  close(reason?: unknown): Promise<void> {
    return this.job.close(reason);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /** @internal Decide propagation from an actual child's genuine failure. */
  childFailed(child: Job<unknown, unknown>): boolean {
    const propagate = this.#groupRunner?.childFailed(child) ?? true;
    return propagate && this.failure === "fail-fast";
  }
}
