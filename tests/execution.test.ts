import { expect, afterEach, test, vi } from "vitest";
import { deadline, execute, fork, signal, timeout, LifecycleStateError } from "../src/index.js";

afterEach(() => vi.useRealTimers());

function untilAbort(): Promise<void> {
  const current = signal();
  current.throwIfAborted();

  const { promise, resolve } = Promise.withResolvers<void>();
  current.addEventListener("abort", () => resolve(), { once: true });

  return promise;
}

test("synchronous fork failures preserve the original error at the boundary", async () => {
  const error = new Error("sync failure");

  await expect(
    execute(() => {
      fork(() => {
        throw error;
      });
    }),
  ).rejects.toBe(error);
});

test("lazy fork results are assimilated inside their child execution", async () => {
  await execute(async () => {
    let seen: AbortSignal | undefined;
    const lazy: PromiseLike<number> = {
      // oxlint-disable-next-line unicorn/no-thenable -- Verify user thenable assimilation at the execution boundary.
      then(resolve, reject) {
        seen = signal();
        return Promise.resolve(42).then(resolve, reject);
      },
    };
    const task = fork(() => lazy);

    expect(await task).toBe(42);
    expect(seen).toBe(task.signal);
  });
});

test("cancelling a fork does not hide a subsequent body failure", async () => {
  const error = new Error("cleanup failed");

  await expect(
    execute(() => {
      const task = fork(async () => {
        await untilAbort();
        throw error;
      });
      task.cancel();
    }),
  ).rejects.toBe(error);
});

test("an already cancelled execution does not run its handler", async () => {
  const error = new Error("cancelled");
  let called = false;

  await expect(
    execute({ signal: AbortSignal.abort(error) }, () => {
      called = true;
    }),
  ).rejects.toBe(error);

  expect(called).toBe(false);
});

test("a retained execution context cannot fork after its boundary closes", async () => {
  const release = Promise.withResolvers<void>();
  let escaped!: Promise<unknown>;
  let called = false;

  await execute(() => {
    escaped = release.promise.then(() =>
      fork(() => {
        called = true;
      }),
    );
  });

  const settled = Promise.allSettled([escaped]);
  release.resolve();

  const [outcome] = await settled;
  expect(outcome).toMatchObject({
    status: "rejected",
    reason: expect.any(LifecycleStateError),
  });

  expect(called).toBe(false);
});

test("timeout preserves the enclosing deadline and rejects ignored cancellation", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);

  await expect(
    execute({ deadline: 1020 }, async () => {
      await expect(
        timeout(100, async () => {
          expect(deadline()).toBe(1020);
          vi.advanceTimersByTime(20);
          return "ignored cancellation";
        }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    }),
  ).rejects.toMatchObject({ name: "TimeoutError" });
});

test("a huge timeout does not expire at the native timer overflow boundary", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);
  let childSignal!: AbortSignal;

  await expect(
    execute(() =>
      timeout(2 ** 31, () => {
        childSignal = signal();
        vi.advanceTimersByTime(1);
        expect(childSignal.aborted).toBe(false);
        return "completed";
      }),
    ),
  ).resolves.toBe("completed");

  vi.advanceTimersByTime(2 ** 31);
  expect(childSignal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test("parent cancellation still propagates through a huge timeout", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const reason = new Error("parent cancelled");

  await expect(
    execute({ signal: controller.signal }, () =>
      timeout(2 ** 31, async () => {
        const aborted = untilAbort();
        controller.abort(reason);
        await aborted;
      }),
    ),
  ).rejects.toBe(reason);

  expect(vi.getTimerCount()).toBe(0);
});

test("cancellation retains independent descendant and native body disposal failures", async () => {
  const controller = new AbortController();
  const reason = { cancelled: true };
  const taskFailure = new Error("task finalizer");
  const resourceFailure = new Error("resource finalizer");
  const order: string[] = [];

  const result = execute({ signal: controller.signal }, async () => {
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        order.push("resource");
        throw resourceFailure;
      },
    };

    const task = fork(async () => {
      await untilAbort();
      order.push("task");
      throw taskFailure;
    });

    controller.abort(reason);
    await task.result();
    signal().throwIfAborted();
  });

  const [outcome] = await Promise.allSettled([result]);
  expect(outcome.status).toBe("rejected");
  const failure = (outcome as PromiseRejectedResult).reason as unknown;
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = (failure as AggregateError).errors as unknown[];
  expect(errors).toHaveLength(2);
  expect(errors).toContain(taskFailure);
  const compound = errors.find((error) => error instanceof SuppressedError) as SuppressedError;
  expect(compound).toBeInstanceOf(SuppressedError);
  expect(compound.error).toBe(resourceFailure);
  expect(compound.suppressed).toBe(reason);
  expect(order).toEqual(["task", "resource"]);
});

test("timeout retains a handler failure and independent cancelled-child cleanup", async () => {
  const handlerFailure = new Error("handler");
  const cleanupFailure = new Error("child cleanup");

  const result = execute(() =>
    timeout(1000, () => {
      fork(async () => {
        await untilAbort();
        throw cleanupFailure;
      });

      throw handlerFailure;
    }),
  );

  const [outcome] = await Promise.allSettled([result]);
  expect(outcome.status).toBe("rejected");
  const failure = (outcome as PromiseRejectedResult).reason as unknown;
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = (failure as AggregateError).errors as unknown[];
  expect(errors).toContain(handlerFailure);
  expect(errors).toContain(cleanupFailure);
});

test("timeout keeps its deadline until a returned body's descendants and finalizers finish", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const release = Promise.withResolvers<void>();
  const finalizing = Promise.withResolvers<void>();
  let settled = false;
  const result = execute(() =>
    timeout(25, () => {
      fork(async () => {
        try {
          await untilAbort();
          signal().throwIfAborted();
        } finally {
          finalizing.resolve();
          await release.promise;
        }
      });
      return "body returned";
    }),
  );
  const observed = Promise.allSettled([result]).then((outcomes) => {
    settled = true;
    return outcomes;
  });

  await vi.advanceTimersByTimeAsync(25);
  await finalizing.promise;
  expect(settled).toBe(false);
  release.resolve();
  const [outcome] = await observed;
  expect(outcome.status).toBe("rejected");
  expect((outcome as PromiseRejectedResult).reason).toMatchObject({ name: "TimeoutError" });
  expect(vi.getTimerCount()).toBe(0);
});

test("handled lexical execution and timeout failures do not poison enclosing work", async () => {
  const failure = new Error("lexical failure");
  const cleanup: string[] = [];
  await execute(async () => {
    const release = Promise.withResolvers<void>();
    const sibling = fork(async () => {
      await release.promise;
      return signal().aborted;
    });
    await expect(
      execute(() => {
        try {
          throw failure;
        } finally {
          cleanup.push("disposed");
        }
      }),
    ).rejects.toBe(failure);
    expect(cleanup).toEqual(["disposed"]);
    await expect(
      timeout(1000, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(signal().aborted).toBe(false);
    release.resolve();
    expect(await sibling).toBe(false);
  });
});
test("execution preserves native body and disposal error identity and causes", async () => {
  const handlerCause = new Error("handler cause");
  const cleanupCause = new Error("cleanup cause");
  const handlerFailure = new Error("handler", { cause: handlerCause });
  const cleanupFailure = new Error("cleanup", { cause: cleanupCause });
  let bodyFailure: unknown;

  const failure = await execute(async () => {
    try {
      await using _cleanup = {
        async [Symbol.asyncDispose]() {
          throw cleanupFailure;
        },
      };
      throw handlerFailure;
    } catch (error) {
      bodyFailure = error;
      throw error;
    }
  }).catch((error: unknown) => error);

  expect(failure).toBe(bodyFailure);
  expect(failure).toBeInstanceOf(SuppressedError);
  expect((failure as SuppressedError).error).toBe(cleanupFailure);
  expect((failure as SuppressedError).suppressed).toBe(handlerFailure);
  expect(cleanupFailure.cause).toBe(cleanupCause);
  expect(handlerFailure.cause).toBe(handlerCause);
});
