import { combinedError } from "../lifecycle/errors.js";
import { isCancellation, linkAbort } from "./abort.js";
import { currentState, runWith } from "./state.js";
import type { RuntimeState } from "./state.js";
import { Task, TaskGroup } from "./task-group.js";

/**
 * Start child work owned by the current execution.
 *
 * The child inherits context values and deadline, receives its own cancellation
 * signal, and is cancelled and joined when the current task group closes.
 */
export function fork<T>(fn: () => T | Promise<T>): Task<T> {
  const state = currentState();
  const group = state.tasks;
  group.assertOpen();

  const controller = new AbortController();
  const unlink = linkAbort(state.context.signal, controller);

  const childState: RuntimeState = {
    ...state,
    context: { ...state.context, signal: controller.signal },
  };

  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const task = new Task(promise, controller);
  group.add(task);

  // Register ownership before invoking user code: a synchronous throw must
  // never report an uninitialized Task.
  void runWith(childState, async () => {
    try {
      controller.signal.throwIfAborted();
      resolve(await fn());
    } catch (error) {
      // Cancellation does not excuse unrelated errors thrown by finalizers.
      if (!isCancellation(error, controller.signal)) {
        group.reportFailure(task, error);
      }

      reject(error);
    } finally {
      unlink();
    }
  });

  return task;
}

type ForkThunks<T extends readonly unknown[]> = {
  readonly [K in keyof T]: () => T[K] | Promise<T[K]>;
};

const GROUP_FAILED = new DOMException(
  "forkGroup cancelled a sibling because another failed",
  "AbortError",
);

/**
 * Run tasks as one all-or-nothing group.
 *
 * A failure cancels and joins every sibling before all genuine failures are
 * surfaced. Successful results preserve the input order.
 */
export async function forkGroup<T extends readonly unknown[]>(
  ...thunks: ForkThunks<T>
): Promise<T> {
  const parent = currentState();
  const group = new TaskGroup();
  const scoped: RuntimeState = { ...parent, tasks: group };

  // Fork each thunk into the child group; awaiting them below marks them
  // observed, so the group itself never re-surfaces their failures.
  const tasks = runWith(scoped, () => thunks.map((thunk) => fork(thunk as () => unknown)));
  let result: T;
  try {
    result = (await Promise.all(tasks)) as unknown as T;
  } catch (error) {
    await group.close(GROUP_FAILED);

    const errors: unknown[] = [];
    for (const task of tasks) {
      const outcome = await task.outcome();
      if (outcome.status === "rejected" && !isCancellation(outcome.reason, task.signal)) {
        errors.push(outcome.reason);
      }
    }

    // Preserve the triggering rejection even when it was parent cancellation,
    // without repeating that same cancellation for every cancelled sibling.
    if (!errors.includes(error)) {
      errors.unshift(error);
    }
    if (group.failed) {
      errors.push(group.failure);
    }

    throw combinedError(errors, "Task group and descendant work failed.");
  }

  await group.close(new DOMException("Task group completed", "AbortError"));
  if (group.failed) {
    throw group.failure;
  }

  return result;
}
