import { expect, test } from "vitest";
import { Job, Supervisor, LifecycleDependencyError, fork, signal } from "../src/index.js";

function untilAbort(): Promise<void> {
  const abort = signal();
  if (abort.aborted) {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  abort.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

test("the managed owner and its descendants cannot consume their own shutdown barrier", async () => {
  const failures: unknown[] = [];
  const checked = Promise.withResolvers<void>();
  await using supervisor = new Supervisor(
    new Job(async () => {
      failures.push(await supervisor.close().catch((error: unknown) => error));
      await fork(async () => {
        failures.push(await supervisor.close().catch((error: unknown) => error));
      });
      checked.resolve();
      await untilAbort();
    }),
  );
  supervisor.start();
  await checked.promise;
  expect(failures).toEqual([
    expect.any(LifecycleDependencyError),
    expect.any(LifecycleDependencyError),
  ]);
  expect(await supervisor.run(() => 42)).toBe(42);
});

test("a supervised descendant cannot flush or close its owner and rejected close preserves admission", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const failures = await supervisor.run(async () => [
    await supervisor.flush().catch((error: unknown) => error),
    await supervisor.close().catch((error: unknown) => error),
  ]);
  expect(failures).toEqual([
    expect.any(LifecycleDependencyError),
    expect.any(LifecycleDependencyError),
  ]);
  expect(await supervisor.run(() => 42)).toBe(42);
});

test("the managed owner can flush its admitted children before returning", async () => {
  const release = Promise.withResolvers<void>();
  const joined = Promise.withResolvers<void>();
  const order: string[] = [];
  const job = new Job(async () => {
    supervisor.run(async () => {
      await release.promise;
      order.push("child");
    });
    const flushing = supervisor.flush();
    joined.resolve();
    await flushing;
    order.push("owner");
    return 42;
  });
  const supervisor = new Supervisor(job);
  supervisor.start({ parent: undefined });
  await joined.promise;
  expect(order).toEqual([]);
  release.resolve();
  expect(await job).toBe(42);
  expect(order).toEqual(["child", "owner"]);
});

test("an unrelated supervised Job can flush and close another supervisor", async () => {
  await using first = new Supervisor(new Job(untilAbort));
  const second = new Supervisor(new Job(untilAbort));
  first.start();
  second.start();
  const release = Promise.withResolvers<void>();
  const joining = Promise.withResolvers<void>();
  const order: string[] = [];
  second.run(async () => {
    await release.promise;
    order.push("child");
  });
  const caller = first.run(async () => {
    expect(first.ownsCurrent()).toBe(true);
    expect(second.ownsCurrent()).toBe(false);
    const flushing = second.flush();
    joining.resolve();
    await flushing;
    order.push("flushed");
    await second.close();
    order.push("closed");
    return 42;
  });
  const result = caller.result();
  await joining.promise;
  expect(order).toEqual([]);
  release.resolve();
  expect(await result).toEqual({ ok: true, value: 42 });
  expect(order).toEqual(["child", "flushed", "closed"]);
  expect(await first.run(() => signal().aborted)).toBe(false);
});

test("native finally cannot join the external close which is waiting for it", async () => {
  const entered = Promise.withResolvers<void>();
  let failure: unknown;
  const supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const task = supervisor.run(async () => {
    try {
      entered.resolve();
      await untilAbort();
    } finally {
      failure = await supervisor.close().catch((error: unknown) => error);
    }
  });
  await entered.promise;
  const closing = supervisor.close();
  await closing;
  expect(await task.result()).toEqual({ ok: false, error: supervisor.job.signal.reason });
  expect(failure).toBeInstanceOf(LifecycleDependencyError);
});

test("flush includes new submissions while joining without cancelling or sealing admission", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const firstGate = Promise.withResolvers<void>();
  const secondGate = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const order: string[] = [];
  supervisor.run(async () => {
    await firstGate.promise;
    supervisor.run(async () => {
      secondEntered.resolve();
      await secondGate.promise;
      expect(signal().aborted).toBe(false);
      order.push("second");
    });
    order.push("first");
  });
  const flushed = supervisor.flush().then(() => {
    order.push("flushed");
  });
  firstGate.resolve();
  await secondEntered.promise;
  expect(order).toEqual(["first"]);
  secondGate.resolve();
  await flushed;
  expect(order).toEqual(["first", "second", "flushed"]);
  expect(await supervisor.run(() => 42)).toBe(42);
});
