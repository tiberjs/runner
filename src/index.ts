/** Job execution, supervision, declarative grouping, and immutable context. */

export { Supervisor } from "./supervisor/supervisor.js";
export type { SupervisorOptions } from "./supervisor/supervisor.js";
export { combinedError } from "./errors.js";
export { LifecycleStateError, LifecycleDependencyError } from "./errors.js";

export { ContextFrame } from "./execution/context/frame.js";
export type { ExecutionContext, ExecutionSeed } from "./execution/context/execution-context.js";
export { contextKey, provide } from "./execution/context/key.js";
export type { ContextEntry, ContextKey } from "./execution/context/key.js";

export { execute, fork, timeout } from "./execution/execution.js";
export { currentAttachment, currentState, peekState, runWith } from "./execution/state.js";
export type { RuntimeState } from "./execution/state.js";
export {
  use,
  withContext,
  hasContext,
  requireContext,
  MissingContextError,
  deadline,
  signal,
} from "./execution/context/access.js";

export { Job } from "./job/job.js";
export type { JobPublisher, JobStartOptions, JobState, JobResult } from "./job/job.js";
export { TaskGroup } from "./supervisor/task-group.js";
export type { TaskGroupOptions, GroupMember, GroupResults } from "./supervisor/task-group.js";
