import { eventKey } from "./event-bus.js";

/** Startup hooks completed successfully; not a transport-listening event. */
export const AppStarted = eventKey<void>("app.started");

/**
 * Shutdown began and the application no longer admits new executions.
 *
 * Resources are still alive: a listener injects application dependencies, and
 * an asynchronous delivery is joined before teardown starts.
 */
export const AppClosing = eventKey<void>("app.closing");

/**
 * Resources finished teardown, including unsuccessful teardown.
 *
 * The application scope is already disposed: a listener cannot inject
 * application dependencies, and its failure is only reported because `close()`
 * has already produced its result. Shutdown work belongs in `onDrain()`,
 * `AppClosing`, or a resource's own `onDispose()`.
 */
export const AppClosed = eventKey<Readonly<{ error?: unknown }>>("app.closed");
