import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, test } from "vitest";
import {
  currentState,
  fork,
  signal,
  HandoffJob,
  Job,
  LifecycleDependencyError,
  Supervisor,
} from "../src/index.js";

test("the body suspends at its offer until the consumer resumes, and the Job still settles after descendants", async () => {
  const releaseChild = Promise.withResolvers<void>();
  const childStarted = Promise.withResolvers<void>();
  const order: string[] = [];
  const job = new HandoffJob<string, number, string>(async (handoff) => {
    fork(async () => {
      childStarted.resolve();
      await releaseChild.promise;
      order.push("child");
    });
    const answer = await handoff.offer(1);
    order.push(`resumed:${answer}`);
    return "done";
  }).start();
  let settled = false;
  const completion = job.then((value) => {
    settled = true;
    return value;
  });

  expect(await job.receive()).toBe(1);
  await childStarted.promise;
  await nextTurn();
  expect(order).toEqual([]);

  job.resume("ack");
  await nextTurn();
  expect(order).toEqual(["resumed:ack"]);
  expect(settled).toBe(false);

  releaseChild.resolve();
  expect(await completion).toBe("done");
  expect(order).toEqual(["resumed:ack", "child"]);
});

test("offer and resume are each accepted at most once", async () => {
  const job = new HandoffJob<void, string, string>(async (handoff) => {
    const first = handoff.offer("first");
    expect(() => handoff.offer("second")).toThrowError(TypeError);
    await first;
  }).start();

  expect(await job.receive()).toBe("first");
  job.resume("ack");
  expect(() => job.resume("again")).toThrowError(TypeError);
  await job;
});

test("failure before an offer rejects the receiver with the composed Job failure", async () => {
  const bodyFailure = new Error("body");
  const childFailure = new Error("child");
  const job = new HandoffJob<void, string, void>(async () => {
    fork(() => {
      throw childFailure;
    });
    await nextTurn();
    throw bodyFailure;
  });
  const received = job.receive();
  job.start();

  const result = await job.result();
  if (result.ok) {
    throw new Error("expected the Job to fail");
  }
  await expect(received).rejects.toBe(result.error);
  await expect(received).rejects.toMatchObject({ errors: [childFailure, bodyFailure] });
});

test("a body that completes without offering fails instead of succeeding", async () => {
  const job = new HandoffJob<number, string, void>(() => 42).start();

  await expect(job.receive()).rejects.toBeInstanceOf(TypeError);
  await expect(job).rejects.toBeInstanceOf(TypeError);
});

test("cancellation releases a body suspended in its offer with the original reason", async () => {
  const reason = new Error("stop");
  let released: unknown;
  const job = new HandoffJob<string, string, string>(async (handoff) => {
    try {
      await handoff.offer("value");
    } catch (error) {
      released = error;
    }
    return "cleaned";
  }).start();

  expect(await job.receive()).toBe("value");
  job.cancel(reason);
  await job.result();
  expect(released).toBe(reason);
  // A late acknowledgement is discarded rather than rejected.
  job.resume("late");
});

test("an offer made after cancellation still reaches the consumer without suspending the body", async () => {
  const childFailure = new Error("child");
  const job = new HandoffJob<void, string, string>(async (handoff) => {
    fork(() => {
      throw childFailure;
    });
    await nextTurn();
    expect(signal().aborted).toBe(true);
    await expect(handoff.offer("mapped")).rejects.toBe(signal().reason);
  }).start();

  expect(await job.receive()).toBe("mapped");
  expect(await job.result()).toEqual({ ok: false, error: childFailure });
});

test("an abandoned consumer cannot keep a closing Job suspended", async () => {
  const job = new HandoffJob<void, string, string>(async (handoff) => {
    await handoff.offer("value").catch(() => {});
  }).start();
  expect(await job.receive()).toBe("value");
  await nextTurn();
  expect(job.state).toBe("running");

  await job.close();
  expect(job.state).toBe("closed");
});

test("owner cancellation cascades into a supervised HandoffJob's suspended offer", async () => {
  const reason = new Error("shutdown");
  let released: unknown;
  const owner = new Supervisor(new Job(() => untilCancelled()));
  owner.start({ parent: undefined });
  const job = owner.run(
    new HandoffJob<void, string, string>(async (handoff) => {
      try {
        await handoff.offer("value");
      } catch (error) {
        released = error;
      }
    }),
  );
  expect(await job.receive()).toBe("value");

  await owner.close(reason);
  expect(released).toBe(reason);
  expect(job.state).toBe("closed");
});

test("independent delivery and cleanup failures keep their identities", async () => {
  const delivery = new Error("delivery");
  const cleanup = new Error("cleanup");
  const job = new HandoffJob<void, string, { readonly error: unknown }>(async (handoff) => {
    const outcome = await handoff.offer("value");
    try {
      throw cleanup;
    } catch (error) {
      throw new AggregateError([outcome.error, error], "delivery and cleanup failed");
    }
  }).start();

  expect(await job.receive()).toBe("value");
  job.resume({ error: delivery });
  await expect(job.result()).resolves.toMatchObject({
    ok: false,
    error: { errors: [delivery, cleanup] },
  });
});

test("receive rejects self and descendant observation synchronously", async () => {
  const job = new HandoffJob<number, string, void>(async (handoff) => {
    const owner = currentState().job as HandoffJob<number, string, void>;
    expect(() => owner.receive()).toThrowError(LifecycleDependencyError);
    const value = await fork(() => {
      expect(() => owner.receive()).toThrowError(LifecycleDependencyError);
      return 42;
    });
    await handoff.offer("ready");
    return value;
  });
  const received = job.receive();
  job.start();
  expect(await received).toBe("ready");
  job.resume();
  expect(await job).toBe(42);
});

function untilCancelled(): Promise<void> {
  const current = signal();
  current.throwIfAborted();
  const { promise, resolve } = Promise.withResolvers<void>();
  current.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}
