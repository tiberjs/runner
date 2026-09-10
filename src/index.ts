/** Core execution model: context, DI, lifecycle, and structured concurrency. */

export { EventBus, eventKey } from "./events/event-bus.js";
export type { AsyncEventListener, EventKey, EventListener } from "./events/event-bus.js";
export { AppClosed, AppClosing, AppStarted } from "./events/application.js";
export { ApplicationLifecycle } from "./lifecycle/application.js";
export { combinedError } from "./lifecycle/errors.js";

export { ContextFrame } from "./context/frame.js";
export type { ExecutionContext } from "./context/execution-context.js";
export { contextKey, provide } from "./context/key.js";
export type { ContextEntry, ContextKey } from "./context/key.js";

export { currentScope, inject, onDispose, onStart, scoped } from "./di/ambient.js";
export {
  ResolutionError,
  ScopeClosedError,
  ScopeStartupError,
  ScopeDisposalConflictError,
} from "./di/errors.js";
export { Scope } from "./di/scope.js";
export type { ScopeOptions } from "./di/scope.js";
export type { ScopeObject } from "./di/resources.js";
export { token } from "./di/tokens.js";
export type { Constructor, Factory, InjectionToken, Token } from "./di/tokens.js";
export type { ResolutionGraph } from "./di/resolution-graph.js";

export { begin, COMPLETED, execute } from "./runtime/execution.js";
export type { ExecutionSeed } from "./runtime/execution.js";
export { currentAttachment, currentState, peekState, runWith } from "./runtime/state.js";
export type { RuntimeState } from "./runtime/state.js";
export { use } from "./runtime/context.js";

export { fork, forkGroup } from "./runtime/fork.js";
export { deadline, signal, timeout } from "./runtime/timeout.js";
export { scheduleDeadline } from "./runtime/deadline.js";
export { Task, TaskGroup } from "./runtime/task-group.js";
export { defer } from "./runtime/defer.js";

export { setTracer, span } from "./runtime/span.js";
export type { Tracer, TraceSpan } from "./runtime/span.js";
