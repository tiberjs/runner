import { expect, afterEach, test, vi } from "vitest";
import { execute, fork, forkGroup, onDispose, signal, timeout, deadline } from "../src/index.js";

const seed = () => ({ signal: new AbortController().signal, attachment: undefined });
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
    execute(seed(), () => {
      fork(() => {
        throw error;
      });
    }),
  ).rejects.toBe(error);
});

test("all unobserved task failures reach the execution caller", async () => {
  const first = new Error("first");
  const second = new Error("second");

  const result = execute(seed(), () => {
    fork(() => {
      throw first;
    });
    fork(() => {
      throw second;
    });
  });

  await expect(result).rejects.toBeInstanceOf(AggregateError);
  const failure = await result.catch((error) => error);
  expect(failure.errors).toContain(first);
  expect(failure.errors).toContain(second);
});

test("cancellation does not hide a task finalizer failure", async () => {
  const error = new Error("cleanup failed");

  await expect(
    execute(seed(), () => {
      fork(async () => {
        await untilAbort();
        throw error;
      });
    }),
  ).rejects.toBe(error);
});

test("forkGroup cancels and joins descendants before returning", async () => {
  let stopped = false;

  await execute(seed(), async () => {
    const values = await forkGroup(() => {
      fork(async () => {
        await untilAbort();
        stopped = true;
      });
      return 42;
    });

    expect(values).toStrictEqual([42]);
    expect(stopped).toBe(true);
  });
});

test("handler failure and disposal failure both reach the caller", async () => {
  const handlerError = new Error("handler");
  const cleanupError = new Error("cleanup");

  const result = execute(seed(), () => {
    onDispose(() => {
      throw cleanupError;
    });
    throw handlerError;
  });

  await expect(result).rejects.toBeInstanceOf(AggregateError);
  const failure = await result.catch((error) => error);
  expect(failure.errors).toContain(handlerError);
  expect(failure.errors).toContain(cleanupError);
});

test("an already cancelled execution does not run its handler", async () => {
  const error = new Error("cancelled");
  let called = false;

  await expect(
    execute({ signal: AbortSignal.abort(error), attachment: undefined }, () => {
      called = true;
    }),
  ).rejects.toBe(error);

  expect(called).toBe(false);
});

test("a retained execution context cannot fork after its boundary closes", async () => {
  const release = Promise.withResolvers<void>();
  let escaped!: Promise<unknown>;
  let called = false;

  await execute(seed(), () => {
    escaped = release.promise.then(() =>
      fork(() => {
        called = true;
      }),
    );
  });

  const settled = Promise.allSettled([escaped]);
  release.resolve();

  const [outcome] = await settled;
  expect(outcome.status).toBe("rejected");

  expect(called).toBe(false);
});

test("timeout preserves the enclosing deadline and rejects ignored cancellation", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);

  await execute({ ...seed(), deadline: 1020 }, async () => {
    await expect(
      timeout(100, async () => {
        expect(deadline()).toBe(1020);

        vi.advanceTimersByTime(20);
        return "ignored cancellation";
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

test("a huge timeout does not expire at the native timer overflow boundary", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1000);
  let childSignal!: AbortSignal;

  await expect(
    execute(seed(), () =>
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
    execute({ signal: controller.signal, attachment: undefined }, () =>
      timeout(2 ** 31, async () => {
        const aborted = untilAbort();
        controller.abort(reason);
        await aborted;
      }),
    ),
  ).rejects.toBe(reason);

  expect(vi.getTimerCount()).toBe(0);
});

test("forkGroup retains sibling finalizer failures after cancellation and joins before disposal", async () => {
  const failure = new Error("work failed");
  const cleanupFailure = new Error("sibling finalizer failed");
  const order: string[] = [];

  const result = execute(seed(), async () => {
    onDispose(() => {
      order.push("resources disposed");
    });

    await forkGroup(
      () => {
        throw failure;
      },
      async () => {
        await untilAbort();
        order.push("sibling finalized");
        throw cleanupFailure;
      },
    );
  });

  await expect(result).rejects.toBeInstanceOf(AggregateError);
  const error = await result.catch((error: unknown) => error);
  expect((error as AggregateError).errors[0]).toBe(failure);
  expect((error as AggregateError).errors[1]).toBe(cleanupFailure);
  expect(order).toEqual(["sibling finalized", "resources disposed"]);
});

test("forkGroup excludes its own sibling cancellation without wrapping the real failure", async () => {
  const failure = new Error("work failed");

  await expect(
    execute(seed(), () =>
      forkGroup(
        () => {
          throw failure;
        },
        async () => {
          await untilAbort();
          signal().throwIfAborted();
        },
      ),
    ),
  ).rejects.toBe(failure);
});

test("forkGroup preserves one non-reflexive parent cancellation shared by every sibling", async () => {
  const controller = new AbortController();
  const reason = NaN;
  const cancelledWork = async () => {
    await untilAbort();
    signal().throwIfAborted();
  };

  await expect(
    execute({ signal: controller.signal, attachment: undefined }, () => {
      const pending = forkGroup(cancelledWork, cancelledWork);
      controller.abort(reason);

      return pending;
    }),
  ).rejects.toBe(reason);
});

test("non-reflexive cancellation reasons remain one failure rather than an unowned task error", async () => {
  const controller = new AbortController();
  const reason = NaN;

  const result = execute({ signal: controller.signal, attachment: undefined }, () => {
    fork(async () => {
      await untilAbort();
      signal().throwIfAborted();
    });

    controller.abort(reason);
  });

  await expect(result).rejects.toBe(reason);
});

test("cancellation retains independent task and resource cleanup failures", async () => {
  const controller = new AbortController();
  const reason = { cancelled: true };
  const taskFailure = new Error("task finalizer");
  const resourceFailure = new Error("resource finalizer");
  const order: string[] = [];

  const result = execute({ signal: controller.signal, attachment: undefined }, () => {
    onDispose(() => {
      order.push("resource");
      throw resourceFailure;
    });

    fork(async () => {
      await untilAbort();
      order.push("task");
      throw taskFailure;
    });

    controller.abort(reason);
    signal().throwIfAborted();
  });

  const [outcome] = await Promise.allSettled([result]);
  expect(outcome.status).toBe("rejected");
  const failure = (outcome as PromiseRejectedResult).reason as unknown;
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = (failure as AggregateError).errors as unknown[];
  expect(errors).toContain(reason);
  expect(errors).toContain(taskFailure);
  expect(errors).toContain(resourceFailure);
  expect(order).toEqual(["task", "resource"]);
});

test("timeout retains a handler failure and independent cancelled-child cleanup", async () => {
  const handlerFailure = new Error("handler");
  const cleanupFailure = new Error("child cleanup");

  const result = execute(seed(), () =>
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
