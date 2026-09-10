/** A single tracing span. Named {@link TraceSpan} to avoid clashing with @Span. */
export interface TraceSpan {
  setAttribute(key: string, value: unknown): void;
  recordError(error: unknown): void;
  end(): void;
}

export interface Tracer {
  startSpan(name: string): TraceSpan;
}

const noopSpan: TraceSpan = {
  setAttribute() {},
  recordError() {},
  end() {},
};

let activeTracer: Tracer = { startSpan: () => noopSpan };

/** Install the process tracer used by {@link span} / `@Span` (default: no-op). */
export function setTracer(tracer: Tracer): void {
  activeTracer = tracer;
}

/**
 * Run `fn` inside a tracing span (architecture §13). The span records a thrown
 * error and always ends. With the default no-op tracer this is a thin pass-through
 * — the point is that `@Span` desugars to exactly this call.
 */
export async function span<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const current = activeTracer.startSpan(name);
  try {
    return await fn();
  } catch (error) {
    current.recordError(error);
    throw error;
  } finally {
    current.end();
  }
}
