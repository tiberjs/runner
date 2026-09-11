import { AsyncLocalStorage } from "node:async_hooks";

/** An operation tried to admit work after its owner began closing. */
export class LifecycleStateError extends Error {
  constructor(
    readonly owner: string,
    readonly operation: string,
    readonly state: "closing" | "closed",
  ) {
    super(`${owner}.${operation}() is unavailable: ${owner} is ${state}.`);
    this.name = "LifecycleStateError";
  }
}

/** A managed operation tried to wait on a barrier that must join that operation. */
export class LifecycleDependencyError extends Error {
  constructor(
    readonly owner: string,
    readonly operation: string,
    readonly dependency: string,
  ) {
    super(
      `${owner}.${operation}() cannot wait for ${dependency} from work that barrier must join.`,
    );
    this.name = "LifecycleDependencyError";
  }
}

/** @internal Identity only: never retain an owning scope, task, or execution. */
export interface DependencyToken {
  readonly owner: string;
}

/** @internal An active ownership chain, independent of the execution/DI contexts. */
export interface DependencyFrame {
  token: DependencyToken | undefined;
  readonly parent: DependencyFrame | undefined;
  waitingFor: DependencyToken | undefined;
}

const activeDependency = new AsyncLocalStorage<DependencyFrame>();
const startupDependencies = new WeakMap<object, DependencyToken>();
const promiseDependencies = new WeakMap<object, DependencyToken>();
const taskDependencies = new WeakMap<object, DependencyFrame>();

/** @internal Share the identity of a scope's startup barrier with application admission. */
export function startupDependency(scope: object): DependencyToken {
  let token = startupDependencies.get(scope);
  if (!token) {
    token = { owner: "startup" };
    startupDependencies.set(scope, token);
  }
  return token;
}

/** @internal Allocate a lightweight frame before invoking owned work. */
export function dependencyFrame(token: DependencyToken): DependencyFrame {
  return { token, parent: activeDependency.getStore(), waitingFor: undefined };
}

/** @internal Keep ownership across awaits without borrowing a caller's execution state. */
export function runWithDependency<T>(frame: DependencyFrame, handler: () => T): T {
  return activeDependency.run(frame, handler);
}

/** @internal Retire this work without invalidating still-running descendants' ancestry. */
export function releaseDependency(frame: DependencyFrame): void {
  frame.token = undefined;
  frame.waitingFor = undefined;
  // Ancestors contain only lightweight tokens. A descendant may still need to
  // detect an outer live barrier after an intermediate task has settled.
}

/** @internal Application-owned work must not inherit its submitter's dependency chain. */
export function withoutDependencies<T>(handler: () => T): T {
  return activeDependency.exit(handler);
}

/** @internal Associate an admission callback or promise with the startup it awaits. */
export function markDependency(promise: object, token: DependencyToken): void {
  promiseDependencies.set(promise, token);
}

/** @internal Track only the currently pending admission, not a task's complete lifetime. */
export function setWaitingFor(promise: object | undefined): void {
  const frame = activeDependency.getStore();
  if (frame) {
    frame.waitingFor =
      promise === undefined ? undefined : (promiseDependencies.get(promise) ?? frame.waitingFor);
  }
}

/** @internal Register/retire task observation guards without retaining the task in its frame. */
export function trackTaskDependency(task: object, frame: DependencyFrame | undefined): void {
  if (frame) {
    taskDependencies.set(task, frame);
  } else {
    taskDependencies.delete(task);
  }
}

/** @internal A startup may submit work, but cannot consume work gated on that same startup. */
export function assertTaskConsumable(task: object, operation = "consume", owner = "Task"): void {
  const dependency = taskDependencies.get(task)?.waitingFor;
  if (dependency) {
    assertCanJoin(dependency, operation, owner);
  }
}

/** @internal Check before committing any admission/closing state. */
export function assertCanJoin(
  dependency: DependencyToken,
  operation: string,
  owner = dependency.owner,
): void {
  for (let frame = activeDependency.getStore(); frame; frame = frame.parent) {
    if (frame.token === dependency) {
      throw new LifecycleDependencyError(owner, operation, dependency.owner);
    }
  }
}
