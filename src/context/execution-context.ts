import type { ContextFrame } from "./frame.js";

/** Immutable values, cancellation, and deadline inherited by an execution's children. */
export interface ExecutionContext {
  readonly values: ContextFrame;
  readonly signal: AbortSignal;
  readonly deadline?: number;
}
