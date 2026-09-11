import { expect, test } from "vitest";
import {
  Job,
  Supervisor,
  LifecycleStateError,
  contextKey,
  currentAttachment,
  currentState,
  deadline,
  execute,
  fork,
  provide,
  signal,
  use,
} from "../src/index.js";

function untilAbort(): Promise<void> {
  const abort = signal();
  if (abort.aborted) {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  abort.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

test("running owners admit work immediately and start remains idempotent", async () => {
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const job = new Job(async () => {
    calls++;
    await release.promise;
    return 42;
  });
  await using supervisor = new Supervisor(job);
  let seedReads = 0;
  let handlerCalls = 0;
  const seed = {
    get values() {
      seedReads++;
      return [];
    },
  };
  const handler = () => {
    handlerCalls++;
    return 42;
  };
  expect(() => supervisor.run(seed, handler)).toThrow(LifecycleStateError);
  expect([seedReads, handlerCalls]).toEqual([0, 0]);
  expect(supervisor.start()).toBe(job);
  expect(supervisor.state).toBe("running");
  const child = supervisor.run(seed, handler);
  expect(supervisor.start()).toBe(job);
  expect(await child).toBe(42);
  expect(calls).toBe(1);
  expect([seedReads, handlerCalls]).toEqual([1, 1]);
  release.resolve();
  expect(await job).toBe(42);
  expect(supervisor.state).toBe("closed");
  expect(() => supervisor.run(() => 1)).toThrow(LifecycleStateError);
});

test("owner failure preserves its identity and native cause through completion and close", async () => {
  const failure = new Error("initialization", { cause: new Error("native cause") });
  const job = new Job(() => {
    throw failure;
  });
  const supervisor = new Supervisor(job);
  const result = job.result();
  supervisor.start();
  expect(await result).toEqual({ ok: false, error: failure });
  await expect(supervisor.close()).rejects.toBe(failure);
  expect(() => supervisor.run(() => 1)).toThrow(LifecycleStateError);
});

test("closing a running owner seals admission and joins its finally", async () => {
  const entered = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const supervisor = new Supervisor(
    new Job(async () => {
      entered.resolve();
      try {
        await untilAbort();
      } finally {
        cleaning.resolve();
        await release.promise;
      }
    }),
  );
  supervisor.start();
  await entered.promise;
  const reason = new Error("stop owner");
  const closing = supervisor.close(reason);
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await cleaning.promise;
  expect(closed).toBe(false);
  expect(() => supervisor.run(() => 1)).toThrow(LifecycleStateError);
  release.resolve();
  await closing;
  expect(await supervisor.job.result()).toEqual({ ok: false, error: reason });
});

test("closing a cold supervisor never invokes its Job", async () => {
  let calls = 0;
  const supervisor = new Supervisor(
    new Job(() => {
      calls++;
    }),
  );
  const reason = new Error("not needed");
  await supervisor.close(reason);
  expect(await supervisor.job.result()).toEqual({ ok: false, error: reason });
  expect(calls).toBe(0);
  expect(supervisor.start()).toBe(supervisor.job);
  expect(() => supervisor.run(() => 1)).toThrow(LifecycleStateError);
});

test("explicit root startup ignores the submitting context, attachment, deadline and cancellation", async () => {
  const Secret = contextKey<string>("secret");
  const controller = new AbortController();
  const initialize = Promise.withResolvers<void>();
  const initialized = Promise.withResolvers<void>();
  const seen: unknown[] = [];
  const supervisor = new Supervisor(
    new Job(async () => {
      seen.push([use(Secret), currentAttachment(), deadline(), currentState().job.parent]);
      await initialize.promise;
      seen.push([use(Secret), currentAttachment(), deadline(), signal().aborted]);
      initialized.resolve();
      await untilAbort();
    }),
  );
  await using _lifetime = supervisor;
  await expect(
    execute(
      {
        values: [provide(Secret, "private")],
        attachment: { request: true },
        deadline: Date.now() + 60_000,
        signal: controller.signal,
      },
      () => {
        supervisor.start({ parent: undefined });
        controller.abort("submitter cancelled");
      },
    ),
  ).rejects.toBe("submitter cancelled");
  initialize.resolve();
  await initialized.promise;
  expect(seen).toEqual([
    [undefined, undefined, undefined, undefined],
    [undefined, undefined, undefined, false],
  ]);
});

test("default startup inherits the executing owner and its context, cancellation and drain", async () => {
  const Tenant = contextKey<string>("tenant");
  const attachment = { request: true };
  const expires = Date.now() + 60_000;
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const seen: unknown[] = [];
  let parent!: Job<unknown>;
  const nested = new Supervisor(
    new Job(async () => {
      seen.push(use(Tenant), currentAttachment(), deadline());
      entered.resolve();
      try {
        await untilAbort();
      } finally {
        cleaning.resolve();
        await release.promise;
      }
    }),
  );
  let settled = false;
  const completion = execute(
    {
      values: [provide(Tenant, "request")],
      attachment,
      deadline: expires,
      signal: controller.signal,
    },
    () => {
      parent = currentState().job;
      nested.start();
    },
  ).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await entered.promise;
  expect(nested.job.parent).toBe(parent);
  expect(seen).toEqual(["request", attachment, expires]);
  expect(settled).toBe(false);
  const reason = new Error("request cancelled");
  controller.abort(reason);
  await cleaning.promise;
  expect(nested.job.signal.reason).toBe(reason);
  expect(settled).toBe(false);
  release.resolve();
  expect(await completion).toBe(reason);
  expect(await nested.job.result()).toEqual({ ok: false, error: reason });
  expect(nested.state).toBe("closed");
});

test("shutdown joins both owner finally and its descendants", async () => {
  const childEntered = Promise.withResolvers<void>();
  const childStopped = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  const cleanupFinished = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const order: string[] = [];
  const supervisor = new Supervisor(
    new Job(async () => {
      fork(async () => {
        childEntered.resolve();
        await untilAbort();
        childStopped.resolve();
        await releaseChild.promise;
        order.push("child");
      });
      try {
        await untilAbort();
      } finally {
        cleanupEntered.resolve();
        await releaseCleanup.promise;
        order.push("finally");
        cleanupFinished.resolve();
      }
    }),
  );
  supervisor.start();
  await childEntered.promise;
  const closing = supervisor.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
    order.push("closed");
  });
  await Promise.all([childStopped.promise, cleanupEntered.promise]);
  expect(closed).toBe(false);
  releaseCleanup.resolve();
  await cleanupFinished.promise;
  expect(closed).toBe(false);
  releaseChild.resolve();
  await closing;
  expect(order).toEqual(["finally", "child", "closed"]);
});
test("external close seals admission before cancellation listeners can submit work", async () => {
  const supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const entered = Promise.withResolvers<void>();
  let rejected: unknown;
  const task = supervisor.run(async () => {
    signal().addEventListener(
      "abort",
      () => {
        try {
          supervisor.run(() => 1);
        } catch (error) {
          rejected = error;
        }
      },
      { once: true },
    );
    entered.resolve();
    await untilAbort();
  });
  await entered.promise;
  const closing = supervisor.close();
  expect(await task.result()).toEqual({ ok: false, error: task.signal.reason });
  await closing;
  expect(rejected).toBeInstanceOf(LifecycleStateError);
  expect(() => supervisor.run(() => 1)).toThrow(LifecycleStateError);
});
test("reentrant close during seed evaluation cannot lose the admitted Job or run its body", async () => {
  const supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  let closing: Promise<void> | undefined;
  let ran = false;
  const child = new Job(
    () => {
      ran = true;
    },
    {
      get values() {
        closing = supervisor.close();
        return [];
      },
    },
  );
  supervisor.run(child);
  await closing;
  expect(ran).toBe(false);
  expect(child.parent).toBe(supervisor.job);
  expect(await child.result()).toEqual({
    ok: false,
    error: supervisor.job.signal.reason,
  });
});

test("a Supervisor cannot take management of a running or completed Job", async () => {
  const release = Promise.withResolvers<void>();
  const job = new Job(async () => {
    await release.promise;
    return 42;
  }).start({ parent: undefined });
  expect(() => new Supervisor(job)).toThrow(LifecycleStateError);
  release.resolve();
  expect(await job).toBe(42);
  expect(() => new Supervisor(job)).toThrow(LifecycleStateError);
});

test("submission rejects a running or completed Job without taking its ownership", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const release = Promise.withResolvers<void>();
  const job = new Job(async () => {
    await release.promise;
    return 42;
  }).start({ parent: undefined });
  expect(() => supervisor.run(job)).toThrow(LifecycleStateError);
  expect(job.parent).toBeUndefined();
  await supervisor.close();
  expect(job.signal.aborted).toBe(false);
  release.resolve();
  expect(await job).toBe(42);

  await using other = new Supervisor(new Job(untilAbort));
  other.start();
  expect(() => other.run(job)).toThrow(LifecycleStateError);
  expect(await other.run(() => 7)).toBe(7);
  expect(await job).toBe(42);
});

test("starting an already activated managed Job does not adopt the caller's lifetime", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  const job = supervisor.job.start({ parent: undefined });
  const reason = new Error("caller stopped");
  await expect(
    execute(() => {
      expect(supervisor.start()).toBe(job);
      currentState().job.cancel(reason);
    }),
  ).rejects.toBe(reason);
  expect(job.parent).toBeUndefined();
  expect(job.signal.aborted).toBe(false);
  expect(await supervisor.run(() => 42)).toBe(42);
});
