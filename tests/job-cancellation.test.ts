import { getEventListeners } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { Job, execute, fork, signal } from "../src/index.js";

function untilAbort(): Promise<void> {
  const current = signal();
  current.throwIfAborted();
  const { promise, resolve } = Promise.withResolvers<void>();
  current.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}
test("cancelling with a failure afterward cannot reclassify the original throw", async () => {
  const failure = new Error("failed before cancellation");
  const job = new Job(() => {
    throw failure;
  }).start();
  job.cancel(failure);
  await expect(job.join()).rejects.toBe(failure);
  await expect(job.close(failure)).rejects.toBe(failure);
});
test("a Node AbortError caused by the task signal is cancellation, not a failure", async () => {
  await expect(
    execute(() => {
      fork(() => sleep(60_000, undefined, { signal: signal() })).cancel();
    }),
  ).resolves.toBeUndefined();
});
test("cancellation inspection preserves a native-shaped error whose cause getter fails", async () => {
  const controller = new AbortController();
  const failure = Object.defineProperties(new Error("abort"), {
    name: { value: "AbortError" },
    code: { value: "ABORT_ERR" },
    cause: {
      get() {
        throw new Error("cause inspection failed");
      },
    },
  });

  await expect(
    execute({ signal: controller.signal }, () => {
      controller.abort("cancelled");
      throw failure;
    }),
  ).rejects.toBe(failure);
});
test("reentrant cancellation during signal linking never starts or leaks an admitted Job", async () => {
  const owner = new Job(untilAbort).start();
  const parent = owner.signal;
  const reason = new Error("cancel while linking");
  const add = parent.addEventListener.bind(parent);
  let ran = false;
  const registration = vi.spyOn(parent, "addEventListener").mockImplementation((...args) => {
    owner.cancel(reason);
    add(...args);
  });
  try {
    const task = new Job(() => {
      ran = true;
    }).start({ parent: owner });
    await expect(task.join()).rejects.toBe(reason);
    await owner.close(reason);
    expect(ran).toBe(false);
    expect(owner.size).toBe(0);
    expect(getEventListeners(parent, "abort")).toEqual([]);
  } finally {
    registration.mockRestore();
    await owner.close();
  }
});

test("a NaN cancellation reason does not turn cancelled work into a genuine failure", async () => {
  const job = new Job(async () => {
    await untilAbort();
    signal().throwIfAborted();
  }).start();
  job.cancel(NaN);
  expect(await job.result()).toStrictEqual({ ok: false, error: NaN });
  await expect(job.close()).resolves.toBeUndefined();
});

test("cancelling a cold Job preserves the first reason and prevents body entry on start", async () => {
  let entered = false;
  const job = new Job(() => {
    entered = true;
  });
  const result = job.result();
  job.cancel(0);
  job.cancel(new Error("later cancellation"));
  job.start();
  expect(await result).toStrictEqual({ ok: false, error: 0 });
  expect(entered).toBe(false);
  await job.close();
});

test("shared native cancellation compounds remain cancellation rather than poisoning their owner", async () => {
  const reason = new Error("cancel leaf");
  let compound!: AggregateError;
  await expect(
    execute(async () => {
      const child = fork(async () => {
        const native = await sleep(60_000, undefined, { signal: signal() }).catch(
          (error: unknown) => error,
        );
        const shared = new SuppressedError(native, reason);
        compound = new AggregateError([shared, shared]);
        throw compound;
      });
      child.cancel(reason);
      expect(await child.result()).toStrictEqual({ ok: false, error: compound });
      await child.close();
      return "owner survived";
    }),
  ).resolves.toBe("owner survived");
});

test("a native AbortError from another signal remains a genuine failure after local cancellation", async () => {
  const foreignReason = new Error("foreign cancellation");
  const foreignFailure = await sleep(60_000, undefined, {
    signal: AbortSignal.abort(foreignReason),
  }).catch((error: unknown) => error);
  const job = new Job(async () => {
    await untilAbort();
    throw foreignFailure;
  }).start();
  job.cancel(new Error("local cancellation"));
  expect(await job.result()).toStrictEqual({ ok: false, error: foreignFailure });
  await expect(job.close()).rejects.toBe(foreignFailure);
});

test("a genuine failure inside a cancellation compound is preserved without flattening", async () => {
  const reason = new Error("cancel leaf");
  const rollback = new Error("rollback failed", { cause: reason });
  const compound = new AggregateError([reason, new SuppressedError(rollback, reason)]);
  const job = new Job(async () => {
    await untilAbort();
    throw compound;
  }).start();
  job.cancel(reason);
  expect(await job.result()).toStrictEqual({ ok: false, error: compound });
  await expect(job.close()).rejects.toBe(compound);
});

test("cyclic failure compounds terminate classification and remain genuine failures", async () => {
  const reason = new Error("cancel leaf");
  const cycle = new AggregateError([]);
  cycle.errors.push(reason, cycle);
  const job = new Job(async () => {
    await untilAbort();
    throw cycle;
  }).start();
  job.cancel(reason);
  const result = await job.result();
  expect(result.ok).toBe(false);
  expect((result as { error: unknown }).error).toBe(cycle);
  await expect(job.close()).rejects.toBe(cycle);
});
