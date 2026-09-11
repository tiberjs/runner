import type { ContextFrame } from "./frame.js";
import type { ContextEntry } from "./key.js";

/** Immutable values, cancellation, and deadline inherited by an execution's children. */
export interface ExecutionContext {
  readonly values: ContextFrame;
  readonly signal: AbortSignal;
  readonly deadline?: number;
  readonly attachment: unknown;
}

/** Context overrides applied when a cold Job is activated. */
export interface ExecutionSeed {
  readonly signal?: AbortSignal;
  readonly attachment?: unknown;
  readonly values?: ContextFrame | readonly ContextEntry[];
  readonly deadline?: number;
}
