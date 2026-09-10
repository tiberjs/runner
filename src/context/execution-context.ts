import type { ContextFrame } from "./frame.js";

/**
 * The state inherited by a single execution: context values, a cancellation
 * signal, and an optional deadline (epoch millis). Immutable — derived contexts
 * are produced by `next(provide(...))`, `fork()`, and `timeout()` (architecture §4).
 */
export interface ExecutionContext {
  readonly values: ContextFrame;
  readonly signal: AbortSignal;
  readonly deadline?: number;
}
