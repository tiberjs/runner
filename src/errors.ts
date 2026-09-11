export type LifecycleState = "created" | "running" | "closing" | "closed";

/** Work was submitted outside its owner's admission phase. */
export class LifecycleStateError extends Error {
  constructor(
    readonly owner: string,
    readonly operation: string,
    readonly state: LifecycleState,
  ) {
    super(`${owner}.${operation}() is unavailable: ${owner} is ${state}.`);
    this.name = "LifecycleStateError";
  }
}

/** A task attempted to join itself or an owner that must join it. */
export class LifecycleDependencyError extends Error {
  constructor(
    readonly owner: string,
    readonly operation: string,
    readonly dependency: string,
  ) {
    super(`${owner}.${operation}() cannot join ${dependency} from its own work.`);
    this.name = "LifecycleDependencyError";
  }
}

/** Preserve a sole failure by identity; aggregate only when several were retained. */
export function combinedError(
  errors: readonly unknown[],
  message = "Multiple operations failed.",
): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
}
