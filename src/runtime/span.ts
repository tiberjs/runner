/** A tracing span created by a {@link Tracer}. */
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

/** Install the process-wide tracer used by {@link span}. */
export function setTracer(tracer: Tracer): void {
  activeTracer = tracer;
}

/** Run `fn` in a span that records thrown errors and always ends. */
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
