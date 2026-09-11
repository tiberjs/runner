import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { Cancelable, defer, execute, fork, forkGroup, signal } from "../src/index.js";

class NativeTimer extends Cancelable {
  readonly controller = new AbortController();
  readonly pending = sleep(60_000, undefined, { signal: this.controller.signal });
  reason: unknown;

  cancel(reason: unknown): Promise<void> {
    this.reason = reason;
    this.controller.abort(reason);
    return this.pending;
  }
}

function shutdownWith(failure: (reason: unknown) => unknown): Promise<void> {
  return execute(() => {
    fork(async () => {
      const current = signal();
      await new Promise<void>((resolve) => {
        current.addEventListener("abort", () => resolve(), { once: true });
      });
      throw failure(current.reason);
    });
  });
}

test("shutdown joins a native timer whose body and cancellation disposal reject together", async () => {
  let operation!: NativeTimer;
  let taskFailure: unknown;

  await expect(
    execute(() => {
      fork(async () => {
        operation = new NativeTimer();
        try {
          await using _registration = operation.cancelable();
          await operation.pending;
        } catch (error) {
          taskFailure = error;
          throw error;
        }
      });
    }),
  ).resolves.toBeUndefined();

  expect(taskFailure).toBeInstanceOf(SuppressedError);
  const compound = taskFailure as SuppressedError;
  expect(compound.error).toBe(compound.suppressed);
  expect(compound.error).toBeInstanceOf(Error);
  expect(compound.error.name).toBe("AbortError");
  expect(compound.error.cause).toBe(operation.reason);
});

test("independent cleanup failures survive a native timer's duplicate cancellation", async () => {
  const cause = new Error("cleanup cause");
  const cleanupFailure = new Error("cleanup failed", { cause });
  let operation!: NativeTimer;
  let taskFailure: unknown;

  const failure = await execute(() => {
    fork(async () => {
      operation = new NativeTimer();
      try {
        await using _cleanup = defer(() => {
          throw cleanupFailure;
        });
        await using _registration = operation.cancelable();
        await operation.pending;
      } catch (error) {
        taskFailure = error;
        throw error;
      }
    });
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(SuppressedError);
  expect(failure).toBe(taskFailure);
  const compound = failure as SuppressedError;
  expect(compound.error).toBe(cleanupFailure);
  expect(compound.error.cause).toBe(cause);
  expect(compound.suppressed).toBeInstanceOf(SuppressedError);
  expect(compound.suppressed.error).toBe(compound.suppressed.suppressed);
  expect(compound.suppressed.error.cause).toBe(operation.reason);
});

test("nested cancellation compounds may share already classified branches", async () => {
  await expect(
    shutdownWith((reason) => {
      const native = new Error("native cancellation", { cause: reason });
      const shared = new SuppressedError(native, reason);
      return new AggregateError([shared, new SuppressedError(shared, native)]);
    }),
  ).resolves.toBeUndefined();
});

test.each([
  { label: "undefined", leaf: undefined },
  { label: "an independent error", leaf: new Error("cleanup failed") },
  { label: "an empty aggregate", leaf: new AggregateError([]) },
])("a nested $label leaf is not suppressed as cancellation", async ({ leaf }) => {
  let compound!: AggregateError;
  const failure = await shutdownWith((reason) => {
    compound = new AggregateError([new SuppressedError(reason, leaf)], "mixed failure", {
      cause: reason,
    });
    return compound;
  }).catch((error: unknown) => error);

  expect(failure).toBe(compound);
  expect(compound.errors[0].suppressed).toBe(leaf);
});

test("name-shaped objects do not acquire SuppressedError cancellation semantics", async () => {
  let impostor: unknown;
  const failure = await shutdownWith((reason) => {
    impostor = { name: "SuppressedError", error: reason, suppressed: reason };
    return impostor;
  }).catch((error: unknown) => error);

  expect(failure).toBe(impostor);
});

test("native cancellation matching follows only one cause level", async () => {
  let compound!: SuppressedError;
  const failure = await shutdownWith((reason) => {
    const native = new Error("native cancellation", { cause: reason });
    compound = new SuppressedError(reason, new Error("independent wrapper", { cause: native }));
    return compound;
  }).catch((error: unknown) => error);

  expect(failure).toBe(compound);
});

test.each(["aggregate", "suppressed"])("a cyclic %s is still reported as failure", async (kind) => {
  let compound!: AggregateError | SuppressedError;
  const failure = await shutdownWith((reason) => {
    if (kind === "aggregate") {
      compound = new AggregateError([reason]);
      compound.errors.push(compound);
    } else {
      compound = new SuppressedError(reason, reason);
      compound.suppressed = compound;
    }
    return compound;
  }).catch((error: unknown) => error);

  expect(failure).toBe(compound);
});

test("a compound cannot cancel a task whose signal is still active", async () => {
  let compound!: SuppressedError;
  const failure = await execute(async () => {
    const failed = Promise.withResolvers<void>();
    fork(() => {
      const current = signal();
      compound = new SuppressedError(current.reason, { cause: current.reason });
      failed.resolve();
      throw compound;
    });
    await failed.promise;
  }).catch((error: unknown) => error);

  expect(failure).toBe(compound);
});

test("forkGroup does not add a sibling's compound cancellation to the triggering failure", async () => {
  const failure = new Error("work failed");
  const started = Promise.withResolvers<void>();

  await expect(
    execute(() =>
      forkGroup(
        async () => {
          await started.promise;
          throw failure;
        },
        async () => {
          const operation = new NativeTimer();
          await using _registration = operation.cancelable();
          started.resolve();
          await operation.pending;
        },
      ),
    ),
  ).rejects.toBe(failure);
});
