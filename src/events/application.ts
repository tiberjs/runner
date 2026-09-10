import { eventKey } from "./event-bus.js";

/** Startup hooks completed successfully; not a transport-listening event. */
export const AppStarted = eventKey<void>("app.started");

/** Shutdown began and the application no longer admits new executions. */
export const AppClosing = eventKey<void>("app.closing");

/** Resources finished teardown, including unsuccessful teardown. */
export const AppClosed = eventKey<Readonly<{ error?: unknown }>>("app.closed");
