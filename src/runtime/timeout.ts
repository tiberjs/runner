import { combinedError } from "../lifecycle/errors.js";
import { linkAbort } from "./abort.js";
import { scheduleDeadline } from "./deadline.js";
import { currentState, runWith } from "./state.js";
import type { RuntimeState } from "./state.js";
import { TaskGroup } from "./task-group.js";

/**
 * Run `fn` under a derived context with a child AbortSignal and a deadline
 * (architecture §8, §10). If `fn` does not settle within `ms`, its signal is
 * aborted with a `TimeoutError`. Parent cancellation still propagates in.
 *
 * A fresh child TaskGroup is created for the scope and closed (cancel → join)
 * when `fn` settles, so work forked inside the timeout is bounded by it.
 */
export async function timeout<T>(ms: number, fn: () => T | Promise<T>): Promise<T> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError("Timeout must be finite and non-negative.");
  }

  const state = currentState();
  const controller = new AbortController();
  const unlink = linkAbort(state.context.signal, controller);

  const deadline = Math.min(Date.now() + ms, state.context.deadline ?? Infinity);
  const timer = scheduleDeadline(deadline, () => {
    controller.abort(new DOMException(`Operation timed out after ${ms}ms`, "TimeoutError"));
  });

  const tasks = new TaskGroup();
  const childState: RuntimeState = {
    context: { values: state.context.values, signal: controller.signal, deadline },
    tasks,
    scope: state.scope,
    attachment: state.attachment,
  };

  let errors: unknown[] | undefined;
  let result!: T;
  try {
    controller.signal.throwIfAborted();
    result = await runWith(childState, async () => fn());
    controller.signal.throwIfAborted();
  } catch (error) {
    (errors ??= []).push(error);
  } finally {
    timer[Symbol.dispose]();
    unlink();
    await tasks.close(errors ? errors[0] : new DOMException("Timeout scope closed", "AbortError"));
  }

  if (tasks.failed) {
    (errors ??= []).push(tasks.failure);
  }

  if (errors) {
    throw combinedError(errors, "Timeout execution and tasks failed.");
  }

  return result;
}

/** The current execution's cancellation signal (respects enclosing timeouts). */
export function signal(): AbortSignal {
  return currentState().context.signal;
}

/** The current execution's deadline (epoch millis), if any. */
export function deadline(): number | undefined {
  return currentState().context.deadline;
}
