import { getEventListeners } from "node:events";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { ContextFrame, Job, execute, fork, signal } from "../src/index.js";

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
test("children add no abort listeners to their parent and receive its cancellation", async () => {
  const owner = new Job(untilAbort).start();
  const parent = owner.signal;
  const baseline = getEventListeners(parent, "abort").length;
  const children = [
    new Job(untilAbort).start({ parent: owner }),
    new Job(untilAbort).start({ parent: owner }),
    new Job(untilAbort).start({ parent: owner }),
  ];
  expect(getEventListeners(parent, "abort")).toHaveLength(baseline);

  const reason = new Error("cancel owner");
  owner.cancel(reason);
  const results = await Promise.all(children.map((child) => child.result()));
  expect(results).toEqual(children.map(() => ({ ok: false, error: reason })));
  await owner.close(reason);
});

test("cancelling a deep ownership chain does not depend on the JavaScript call stack", () => {
  const reason = new Error("cancel deep tree");
  const suspended = new Promise<never>(() => undefined);
  const root = new Job(() => suspended).start();
  let leaf = root;
  for (let depth = 0; depth < 8_000; depth++) {
    leaf = new Job(() => suspended).start({ parent: leaf });
  }

  expect(() => root.cancel(reason)).not.toThrow();
  expect(leaf.signal.reason).toBe(reason);
});

test("reentrant external cancellation during the first observation is visible before the observer continues", async () => {
  const source = new AbortController();
  const reason = new Error("cancel while linking");
  const add = source.signal.addEventListener.bind(source.signal);
  let observed: boolean | undefined;
  const registration = vi.spyOn(source.signal, "addEventListener").mockImplementation((...args) => {
    source.abort(reason);
    add(...args);
  });
  try {
    const job = new Job(
      () => {
        observed = signal().aborted;
      },
      { signal: source.signal },
    ).start();
    await expect(job.join()).rejects.toBe(reason);
    expect(observed).toBe(true);
    expect(getEventListeners(source.signal, "abort")).toEqual([]);
  } finally {
    registration.mockRestore();
  }
});

test("a Job cancelled before activation does not subscribe to external sources", async () => {
  const source = new AbortController();
  const reason = new Error("cancel before start");
  const job = new Job(() => undefined, { signal: source.signal });
  const result = job.result();
  job.cancel(reason);
  job.start();

  expect(getEventListeners(source.signal, "abort")).toEqual([]);
  expect(await result).toEqual({ ok: false, error: reason });
});

test("one external source shared by context and seed has one subscription", async () => {
  const source = new AbortController();
  const release = Promise.withResolvers<void>();
  const reason = new Error("shared source");
  const job = new Job(
    () => {
      signal();
      return release.promise;
    },
    { signal: source.signal },
  ).start({
    context: {
      values: ContextFrame.empty,
      signal: source.signal,
      attachment: undefined,
    },
  });
  expect(getEventListeners(source.signal, "abort")).toHaveLength(1);

  source.abort(reason);
  release.resolve();
  expect(await job.result()).toEqual({ ok: false, error: reason });
  expect(getEventListeners(source.signal, "abort")).toEqual([]);
});

test("an unobserved external source is never subscribed to, yet its abort still ends the Job", async () => {
  const source = new AbortController();
  const release = Promise.withResolvers<void>();
  const reason = new Error("nobody looked");
  const job = new Job(() => release.promise, { signal: source.signal }).start();
  await nextTurn();
  expect(getEventListeners(source.signal, "abort")).toEqual([]);

  source.abort(reason);
  release.resolve();
  expect(await job.result()).toEqual({ ok: false, error: reason });
  expect(getEventListeners(source.signal, "abort")).toEqual([]);
});

test("the first signal read subscribes once and a late reader sees an abort that preceded it", async () => {
  const source = new AbortController();
  const release = Promise.withResolvers<void>();
  const reason = new Error("aborted before observation");
  let seen: AbortSignal | undefined;
  const job = new Job(
    async () => {
      await release.promise;
      seen = signal();
      seen.throwIfAborted();
    },
    { signal: source.signal },
  ).start();
  source.abort(reason);
  expect(getEventListeners(source.signal, "abort")).toEqual([]);

  release.resolve();
  expect(await job.result()).toEqual({ ok: false, error: reason });
  expect(seen?.aborted).toBe(true);
  expect(seen?.reason).toBe(reason);
});

test("starting a child subscribes the parent so the cascade can reach it", async () => {
  const source = new AbortController();
  const reason = new Error("cancel the tree");
  let childStopped = false;
  const job = new Job(
    () => {
      expect(getEventListeners(source.signal, "abort")).toEqual([]);
      fork(async () => {
        await untilAbort();
        childStopped = true;
      });
      expect(getEventListeners(source.signal, "abort")).toHaveLength(1);
    },
    { signal: source.signal },
  ).start();

  source.abort(reason);
  expect(await job.result()).toEqual({ ok: false, error: reason });
  expect(childStopped).toBe(true);
  expect(getEventListeners(source.signal, "abort")).toEqual([]);
});

test("the first of two external sources wins and the other subscription is released", async () => {
  const inherited = new AbortController();
  const seeded = new AbortController();
  const reason = new Error("inherited source");
  const job = new Job(untilAbort, { signal: seeded.signal }).start({
    context: {
      values: ContextFrame.empty,
      signal: inherited.signal,
      attachment: undefined,
    },
  });
  expect(getEventListeners(inherited.signal, "abort")).toHaveLength(1);
  expect(getEventListeners(seeded.signal, "abort")).toHaveLength(1);

  inherited.abort(reason);
  expect(await job.result()).toEqual({ ok: false, error: reason });
  expect(getEventListeners(inherited.signal, "abort")).toEqual([]);
  expect(getEventListeners(seeded.signal, "abort")).toEqual([]);

  seeded.abort(new Error("late source"));
  expect(job.signal.reason).toBe(reason);
});

test("external cancellation remains linked while a Job drains children", async () => {
  const source = new AbortController();
  const entered = Promise.withResolvers<void>();
  const reason = new Error("cancel while closing");
  let childStopped = false;
  const job = new Job(
    () => {
      fork(async () => {
        entered.resolve();
        await untilAbort();
        childStopped = true;
      });
    },
    { signal: source.signal },
  ).start();

  await entered.promise;
  await nextTurn();
  expect(job.state).toBe("closing");
  source.abort(reason);
  expect(await job.result()).toEqual({ ok: false, error: reason });
  expect(childStopped).toBe(true);
  expect(getEventListeners(source.signal, "abort")).toEqual([]);
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
