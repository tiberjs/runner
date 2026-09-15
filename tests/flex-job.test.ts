import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, expectTypeOf, test, vi } from "vitest";
import {
  contextKey,
  currentState,
  execute,
  FlexJob,
  fork,
  Job,
  LifecycleDependencyError,
  provide,
  Supervisor,
  use,
} from "../src/index.js";
import type { Publish } from "../src/index.js";

test("construction is cold and publication never waits for a receiver", async () => {
  let ran = false;
  const job = new FlexJob<string, number>((publish) => {
    ran = true;

    expect(publish(1)).toBeUndefined();
    publish(2);
    publish(3);
    return "done";
  });

  expect(ran).toBe(false);
  expect(job.state).toBe("created");

  job.start();
  expect(await job).toBe("done");
  expect(await job.receive()).toEqual({ done: false, value: 3 });
  expect(await job.receive()).toEqual({ done: true, value: undefined });
  expect(await job.result()).toEqual({ ok: true, value: "done" });
  expectTypeOf(job.result()).toEqualTypeOf<ReturnType<Job<string>["result"]>>();
});

test("a pending receive takes an undefined publication without confusing it with completion", async () => {
  const job = new FlexJob<number, undefined>((publish) => {
    publish(undefined);
    return 42;
  });

  const received = job.receive();
  job.start();

  expect(await received).toEqual({ done: false, value: undefined });
  expect(await job).toBe(42);
  expect(await job.receive()).toEqual({ done: true, value: undefined });
});

test("buffered updates are consumed once in FIFO order across competing receivers", async () => {
  const proceed = Promise.withResolvers<void>();
  const job = FlexJob.withBuffer<void, number>(3, async (publish) => {
    await proceed.promise;

    publish(1);
    publish(2);
    publish(3);
    publish(4);
    publish(5);
  }).start();

  const first = job.receive();
  const second = job.receive();
  proceed.resolve();

  expect(await first).toEqual({ done: false, value: 1 });
  expect(await second).toEqual({ done: false, value: 2 });
  await job;

  for (const value of [3, 4, 5]) {
    expect(await job.receive()).toEqual({ done: false, value });
  }
  expect(await job.receive()).toEqual({ done: true, value: undefined });
});

test("drop-oldest retains the newest values across repeated publication and consumption", async () => {
  const proceed = Promise.withResolvers<void>();
  const job = FlexJob.withBuffer<void, number>(2, async (publish) => {
    publish(1);
    publish(2);
    publish(3);

    await proceed.promise;

    publish(4);
    publish(5);
    publish(6);
  }).start();

  expect(await job.receive()).toEqual({ done: false, value: 2 });

  proceed.resolve();
  await job;

  expect(await job.receive()).toEqual({ done: false, value: 5 });
  expect(await job.receive()).toEqual({ done: false, value: 6 });
  expect(await job.receive()).toEqual({ done: true, value: undefined });
});

test("drop-newest preserves unread updates when its buffer is full", async () => {
  const job = FlexJob.withBuffer<void, number>(
    2,
    (publish) => {
      for (const value of [1, 2, 3, 4]) {
        publish(value);
      }
    },
    { overflow: "drop-newest" },
  ).start();

  await job;
  expect(await job.receive()).toEqual({ done: false, value: 1 });
  expect(await job.receive()).toEqual({ done: false, value: 2 });
  expect(await job.receive()).toEqual({ done: true, value: undefined });
});

test("overflow errors fail the Job unless the body handles them", async () => {
  let overflow: unknown;
  const job = FlexJob.withBuffer<void, number>(
    1,
    (publish) => {
      publish(1);

      try {
        publish(2);
      } catch (error) {
        overflow = error;
        throw error;
      }
    },
    { overflow: "error" },
  ).start();

  expect(await job.result()).toEqual({ ok: false, error: overflow });
  expect(overflow).toBeInstanceOf(RangeError);
  await expect(job.receive()).rejects.toBe(overflow);

  const recovered = FlexJob.withBuffer<string, number>(
    1,
    (publish) => {
      publish(1);
      expect(() => publish(2)).toThrowError(RangeError);
      return "recovered";
    },
    { overflow: "error" },
  ).start();

  expect(await recovered).toBe("recovered");
  expect(await recovered.receive()).toEqual({ done: false, value: 1 });
});

test("invalid buffer configuration is rejected before executing the body", () => {
  let ran = false;
  const body = () => {
    ran = true;
  };

  for (const capacity of [0, -1, 1.5, NaN, Infinity, 2 ** 32]) {
    expect(() => FlexJob.withBuffer(capacity, body)).toThrowError(RangeError);
  }
  expect(() => new FlexJob(body, { overflow: "unknown" as "error" })).toThrowError(TypeError);
  expect(() => new FlexJob(undefined as unknown as () => void)).toThrowError(TypeError);
  expect(ran).toBe(false);
});

test("aborting one receive keeps the producer and other receivers running", async () => {
  const proceed = Promise.withResolvers<void>();
  const observation = new AbortController();
  const reason = new Error("stop observing");
  const job = new FlexJob<string, number>(async (publish) => {
    await proceed.promise;

    publish(42);
    return "done";
  }).start();

  const abandoned = job.receive({ signal: observation.signal });
  const rejected = abandoned.catch((error: unknown) => error);
  const remaining = job.receive();
  expect(getEventListeners(observation.signal, "abort")).toHaveLength(1);

  observation.abort(reason);
  expect(await rejected).toBe(reason);
  expect(getEventListeners(observation.signal, "abort")).toHaveLength(0);
  expect(job.signal.aborted).toBe(false);

  proceed.resolve();
  expect(await remaining).toEqual({ done: false, value: 42 });
  expect(await job).toBe("done");
});

test("already-aborted receives do not consume buffered values", async () => {
  const job = new FlexJob<void, number>((publish) => publish(42)).start();
  await job;

  const reason = new Error("already stopped");
  await expect(job.receive({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  expect(await job.receive()).toEqual({ done: false, value: 42 });
});

test("receive registrations are removed on delivery, completion, and failure", async () => {
  for (const ending of ["value", "complete", "fail"] as const) {
    const observation = new AbortController();
    const proceed = Promise.withResolvers<void>();
    const failure = new Error("body failed");
    const job = new FlexJob<void, number>(async (publish) => {
      await proceed.promise;
      if (ending === "value") {
        publish(42);
      }
      if (ending === "fail") {
        throw failure;
      }
    }).start();

    const received = job.receive({ signal: observation.signal });
    const checked = received.then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ ok: false, error }),
    );

    proceed.resolve();
    expect(await checked).toEqual(
      ending === "fail"
        ? { ok: false, error: failure }
        : {
            ok: true,
            value:
              ending === "value" ? { done: false, value: 42 } : { done: true, value: undefined },
          },
    );
    await job.result();

    expect(getEventListeners(observation.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(job.signal, "abort")).toHaveLength(0);
  }
});

test("body completion closes publication but final results still join descendants", async () => {
  const releaseChild = Promise.withResolvers<void>();
  let publishLater: Publish<number> | undefined;
  let settled = false;

  const job = new FlexJob<string, number>((publish) => {
    publishLater = publish;
    fork(() => releaseChild.promise);
    publish(42);
    return "done";
  }).start();

  const completion = job.then((value) => {
    settled = true;
    return value;
  });

  expect(await job.receive()).toEqual({ done: false, value: 42 });
  expect(await job.receive()).toEqual({ done: true, value: undefined });
  expect(settled).toBe(false);
  expect(() => publishLater!(43)).toThrowError(TypeError);

  releaseChild.resolve();
  expect(await completion).toBe("done");
});

test("body failures preserve error identity and discard stale updates", async () => {
  const failure = new Error("body failed");
  const job = new FlexJob<void, number>((publish) => {
    publish(1);
    throw failure;
  }).start();

  expect(await job.result()).toEqual({ ok: false, error: failure });
  await expect(job.receive()).rejects.toBe(failure);
});

test("an undefined thrown error remains distinguishable from channel completion", async () => {
  const job = new FlexJob<void, number>(() => {
    throw undefined;
  }).start();

  expect(await job.result()).toEqual({ ok: false, error: undefined });
  await expect(job.receive()).rejects.toBeUndefined();
});

test("cancellation releases receivers before uncooperative work finishes", async () => {
  const finishBody = Promise.withResolvers<void>();
  const reason = new Error("stop");
  let publishLater: Publish<number> | undefined;

  const job = new FlexJob<void, number>(async (publish) => {
    publishLater = publish;
    await finishBody.promise;
  }).start();

  const received = job.receive();
  const rejected = received.catch((error: unknown) => error);

  job.cancel(reason);
  expect(await rejected).toBe(reason);
  expect(job.state).toBe("running");
  expect(() => publishLater!(42)).toThrow(reason);

  finishBody.resolve();
  expect(await job.result()).toEqual({ ok: false, error: reason });
  await expect(job.receive()).rejects.toBe(reason);
});

test("parent cancellation reaches a FlexJob channel without cancelling a receive separately", async () => {
  const release = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<{ child: FlexJob<void, number> }>();
  const reason = new Error("owner stopped");
  const owner = new Job(async () => {
    const child = new FlexJob<void, number>(() => release.promise).start();
    ready.resolve({ child });
    await release.promise;
  }).start();

  const { child } = await ready.promise;
  const received = child.receive();
  const rejected = received.catch((error: unknown) => error);

  owner.cancel(reason);
  expect(await rejected).toBe(reason);

  release.resolve();
  expect(await owner.result()).toEqual({ ok: false, error: reason });
});

test("an external source is observed even when the body does not read its signal", async () => {
  const release = Promise.withResolvers<void>();
  const external = new AbortController();
  const reason = new Error("external stopped");
  const job = new FlexJob<void, number>(() => release.promise, {
    seed: { signal: external.signal },
  }).start();

  const received = job.receive();
  const rejected = received.catch((error: unknown) => error);

  external.abort(reason);
  expect(await rejected).toBe(reason);

  release.resolve();
  expect(await job.result()).toEqual({ ok: false, error: reason });
  expect(getEventListeners(external.signal, "abort")).toHaveLength(0);
});

test("cold close and failures before the body starts release receivers", async () => {
  const reason = new Error("stopped before start");
  const cold = new FlexJob<void, number>(() => {
    throw new Error("must not run");
  });
  const received = cold.receive();
  const rejected = received.catch((error: unknown) => error);

  await cold.close(reason);
  expect(await rejected).toBe(reason);

  const skipped = new FlexJob<void, number>(
    () => {
      throw new Error("must not run");
    },
    {
      seed: { signal: AbortSignal.abort(reason) },
    },
  );
  const skippedReceive = skipped.receive();
  const skippedRejection = skippedReceive.catch((error: unknown) => error);

  skipped.start();
  expect(await skipped.result()).toEqual({ ok: false, error: reason });
  expect(await skippedRejection).toBe(reason);

  const invalid = new FlexJob<void, number>(() => {}, { seed: { deadline: NaN } });
  const invalidReceive = invalid.receive();
  const invalidRejection = invalidReceive.catch((error: unknown) => error);

  invalid.start();
  expect((await invalid.result()).ok).toBe(false);
  expect(await invalidRejection).toBeInstanceOf(RangeError);
});

test("publication runs under its Job's context and descendants retain ownership", async () => {
  const Tenant = contextKey<string>("tenant");

  await execute({ values: [provide(Tenant, "outer")] }, async () => {
    const owner = currentState().job;
    let bodyOwner: Job<unknown> | undefined;

    const job = FlexJob.withBuffer<string, string>(
      2,
      async (publish) => {
        bodyOwner = currentState().job;
        publish(use(Tenant)!);

        const child = fork(() => {
          expect(currentState().job.parent).toBe(bodyOwner);
          return use(Tenant)!;
        });

        publish(await child);
        return "done";
      },
      { seed: { values: [provide(Tenant, "inner")] } },
    ).start();

    expect(job.parent).toBe(owner);
    expect(await job).toBe("done");
    expect(bodyOwner).toBe(job);
    expect(await job.receive()).toEqual({ done: false, value: "inner" });
    expect(await job.receive()).toEqual({ done: false, value: "inner" });
    expect(use(Tenant)).toBe("outer");
  });
});

test("receiving from oneself or an ancestor is rejected synchronously", async () => {
  let job: FlexJob<void, number>;
  job = new FlexJob<void, number>(async () => {
    expect(() => job.receive()).toThrowError(LifecycleDependencyError);
    await fork(() => {
      expect(() => job.receive()).toThrowError(LifecycleDependencyError);
    });
  });

  job.start();
  await job;
});

test("a descendant failure after publication closes remains in the final Job result", async () => {
  const release = Promise.withResolvers<void>();
  const failure = new Error("descendant failed");
  const job = new FlexJob<string, number>((publish) => {
    fork(async () => {
      await release.promise;
      throw failure;
    });
    publish(42);
    return "body returned";
  }).start();

  expect(await job.receive()).toEqual({ done: false, value: 42 });
  expect(await job.receive()).toEqual({ done: true, value: undefined });

  release.resolve();
  expect(await job.result()).toEqual({ ok: false, error: failure });
  await expect(job.receive()).rejects.toBe(failure);
});

test("composed operation and finalizer failures remain in the final result", async () => {
  const proceed = Promise.withResolvers<void>();
  const operation = new Error("operation failed");
  const cleanup = new Error("cleanup failed");
  const job = new FlexJob<void, number>(async (publish) => {
    fork(async () => {
      try {
        await proceed.promise;
        throw operation;
      } finally {
        fork(() => {
          throw cleanup;
        });
      }
    });
    publish(42);
  }).start();

  expect(await job.receive()).toEqual({ done: false, value: 42 });

  proceed.resolve();
  const result = await job.result();
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected failure");
  }

  expect(result.error).toBeInstanceOf(AggregateError);
  expect((result.error as AggregateError).errors).toEqual(
    expect.arrayContaining([operation, cleanup]),
  );
  await expect(job.receive()).rejects.toBe(result.error);
});

test("a deadline releases observation while completion still waits for work", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    const release = Promise.withResolvers<void>();
    const job = new FlexJob<void, number>(() => release.promise, {
      seed: { deadline: Date.now() + 20 },
    }).start();

    const received = job.receive().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    const reason = await received;
    expect(reason).toBe(job.signal.reason);
    expect(job.signal.aborted).toBe(true);
    expect(job.state).toBe("running");

    release.resolve();
    expect(await job.result()).toEqual({ ok: false, error: reason });
  } finally {
    vi.useRealTimers();
  }
});

test("the maximum supported capacity accepts publications", async () => {
  const job = FlexJob.withBuffer<void, number>(0xffff_ffff, (publish) => publish(42)).start();

  await job;
  expect(await job.receive()).toEqual({ done: false, value: 42 });
  expect(await job.receive()).toEqual({ done: true, value: undefined });
});

test("isolated Supervisor submissions preserve FlexJob result and channel failure", async () => {
  const finishOwner = Promise.withResolvers<void>();
  const owner = new Job(() => finishOwner.promise);
  await using supervisor = new Supervisor(owner);
  supervisor.start({ parent: undefined });

  const failure = new Error("isolated failure");
  const job = new FlexJob<void, number>(() => {
    throw failure;
  });

  await expect(supervisor.run(job)).rejects.toBe(failure);
  expect(job.parent).toBe(owner);
  expect(owner.signal.aborted).toBe(false);
  expect(await job.result()).toEqual({ ok: false, error: failure });
  await expect(job.receive()).rejects.toBe(failure);

  finishOwner.resolve();
});

test("unobserved intermediate failures do not create unhandled promise rejections", async () => {
  const failure = new Error("unobserved");
  const job = new FlexJob<void, number>(() => {
    throw failure;
  }).start();

  expect(await job.result()).toEqual({ ok: false, error: failure });
  await nextTurn();
  await expect(job.receive()).rejects.toBe(failure);
});
