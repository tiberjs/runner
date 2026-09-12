import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, test } from "vitest";
import {
  currentState,
  execute,
  fork,
  signal,
  Job,
  LifecycleDependencyError,
  LifecycleStateError,
} from "../src/index.js";

function untilCancelled(): Promise<void> {
  const current = signal();
  current.throwIfAborted();
  const { promise, resolve } = Promise.withResolvers<void>();
  current.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

test("a fork cannot settle before its nested child", async () => {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const order: string[] = [];
  await execute(async () => {
    const parent = fork(() => {
      fork(async () => {
        started.resolve();
        await release.promise;
        order.push("child");
      });
      return 42;
    });
    const observed = parent.then((value) => {
      order.push("parent");
      return value;
    });
    await started.promise;
    await nextTurn();
    expect(order).toEqual([]);
    release.resolve();
    expect(await observed).toBe(42);
    expect(order).toEqual(["child", "parent"]);
  });
});

test("a Job can publish its value before its body and descendants settle", async () => {
  const releaseBody = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  const childStarted = Promise.withResolvers<void>();
  let settled = false;
  const job = new Job<number, string>(async (publish) => {
    fork(async () => {
      childStarted.resolve();
      await releaseChild.promise;
    });
    publish(Promise.resolve("ready"));
    expect(() => publish("again")).toThrowError(TypeError);
    await releaseBody.promise;
    return 7;
  }).start();
  const completion = job.then((value) => {
    settled = true;
    return value;
  });

  await childStarted.promise;
  expect(await job.value()).toBe("ready");
  expect(settled).toBe(false);
  releaseBody.resolve();
  await nextTurn();
  expect(settled).toBe(false);
  releaseChild.resolve();
  expect(await completion).toBe(7);
});

test("value rejects when a Job settles before publishing", async () => {
  const unreported = new Job(() => 42);
  const missing = unreported.value();
  unreported.start();
  await expect(missing).rejects.toBeInstanceOf(LifecycleStateError);
  expect(await unreported).toBe(42);

  const failure = new Error("before publication");
  const failed = new Job(() => {
    throw failure;
  });
  const value = failed.value();
  failed.start();
  await expect(value).rejects.toBe(failure);
});

test("a cancelled Job still publishes the answer its body owes", async () => {
  const childFailure = new Error("child");
  const released = Promise.withResolvers<void>();
  const job = new Job<void, string>(async (publish) => {
    fork(() => {
      throw childFailure;
    });
    await nextTurn();
    // The child's failure has cancelled this Job; the answer is still owed.
    expect(signal().aborted).toBe(true);
    publish("mapped");
    await released.promise;
  }).start();

  expect(await job.value()).toBe("mapped");
  released.resolve();
  expect(await job.result()).toEqual({ ok: false, error: childFailure });
});

test("a rejected publication does not replace the Job's lifetime result", async () => {
  const publicationFailure = new Error("publication");
  const job = new Job<number, string>((publish) => {
    publish(Promise.reject(publicationFailure));
    return 42;
  }).start();

  await expect(job.value()).rejects.toBe(publicationFailure);
  expect(await job).toBe(42);
});

test("successful completion joins naturally without cancelling body or child signals", async () => {
  let body!: AbortSignal;
  let child!: AbortSignal;
  const order: string[] = [];
  await execute(() => {
    body = signal();
    try {
      fork(async () => {
        child = signal();
        await nextTurn();
        expect(body.aborted).toBe(false);
        expect(child.aborted).toBe(false);
        order.push("child");
      });
    } finally {
      order.push("body finalized");
    }
  });
  expect(body.aborted).toBe(false);
  expect(child.aborted).toBe(false);
  expect(order).toEqual(["body finalized", "child"]);
});

test("awaiting a failing child never disables sibling or body cancellation", async () => {
  const failure = new Error("child failed");
  let siblingStopped = false;
  await expect(
    execute(async () => {
      const release = Promise.withResolvers<void>();
      const failed = fork(async () => {
        await release.promise;
        throw failure;
      });
      fork(async () => {
        await untilCancelled();
        siblingStopped = true;
      });
      const observed = Promise.resolve(failed);
      release.resolve();
      await expect(observed).rejects.toBe(failure);
      expect(signal().aborted).toBe(true);
    }),
  ).rejects.toBe(failure);
  expect(siblingStopped).toBe(true);
});

test("explicit ownership lets submitted work outlive its caller", async () => {
  const owner = new Job(untilCancelled).start();
  const release = Promise.withResolvers<void>();
  let submitted!: Job<number>;
  let completed = false;
  await execute(() => {
    const caller = currentState().job;
    submitted = new Job(async () => {
      expect(owner.owns(currentState().job)).toBe(true);
      expect(caller.owns(currentState().job)).toBe(false);
      await release.promise;
      completed = true;
      return 42;
    }).start({ parent: owner });
  });
  expect(completed).toBe(false);
  release.resolve();
  expect(await submitted).toBe(42);
  await owner.close();
});

test("explicit ownership is registered before a seed getter can cancel the owner", async () => {
  const owner = new Job(untilCancelled).start();
  const reason = new Error("cancel during preparation");
  let ran = false;
  const task = new Job(
    () => {
      ran = true;
    },
    {
      get values() {
        expect(owner.size).toBe(1);
        owner.cancel(reason);
        return undefined;
      },
    },
  ).start({ parent: owner });
  await expect(task.join()).rejects.toBe(reason);
  await owner.close();
  expect(ran).toBe(false);
  expect(owner.failed).toBe(false);
});

test.each(["join", "finish", "close"] as const)(
  "a Job's %s waits for its body and ordinary finally",
  async (operation) => {
    const release = Promise.withResolvers<void>();
    const cleanupRelease = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    let settled = false;
    const child = new Job(async () => {
      try {
        await release.promise;
      } finally {
        cleanupStarted.resolve();
        await cleanupRelease.promise;
      }
    }).start();
    const observed = child.result();
    const barrier = child[operation]().then(() => {
      settled = true;
    });
    await nextTurn();
    expect(settled).toBe(false);
    release.resolve();
    await cleanupStarted.promise;
    expect(settled).toBe(false);
    cleanupRelease.resolve();
    await barrier;
    const result = await observed;
    expect(result.ok).toBe(operation !== "close");
  },
);

test("awaiting a descendant aggregate does not repeat its already owned failures", async () => {
  const first = new Error("first descendant");
  const second = new Error("second descendant");
  const failure = await execute(async () => {
    await fork(() => {
      const release = Promise.withResolvers<void>();
      fork(async () => {
        await release.promise;
        throw first;
      });
      fork(async () => {
        await release.promise;
        throw second;
      });
      release.resolve();
    });
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([first, second]);
});

test.each(["join", "finish", "close"] as const)(
  "a Job rejects its own %s without sealing admission",
  async (operation) => {
    await execute(async () => {
      const owner = currentState().job;
      await expect(owner[operation]()).rejects.toBeInstanceOf(LifecycleDependencyError);
      expect(await fork(() => 42)).toBe(42);
    });
  },
);

test("self and descendant result observations reject without replacing the owner's eventual result", async () => {
  const job = new Job(async () => {
    const owner = currentState().job;
    expect(() => owner.result()).toThrowError(LifecycleDependencyError);
    expect(() => owner.value()).toThrowError(LifecycleDependencyError);
    return await fork(() => {
      expect(() => owner.result()).toThrowError(LifecycleDependencyError);
      expect(() => owner.value()).toThrowError(LifecycleDependencyError);
      return 42;
    });
  });
  const result = job.result();
  job.start();
  expect(await result).toEqual({ ok: true, value: 42 });
});

test("a reentrant start option cannot execute twice or adopt the outer parent", async () => {
  const owner = new Job(untilCancelled).start();
  let calls = 0;
  const job = new Job(() => ++calls);
  try {
    expect(() =>
      job.start({
        parent: owner,
        get propagation() {
          job.start({ parent: undefined });
          return "isolate" as const;
        },
      }),
    ).toThrowError(LifecycleStateError);
    expect(await job).toBe(1);
    expect(job.parent).toBeUndefined();
    expect(owner.size).toBe(0);
  } finally {
    await owner.close();
  }
});

test("closing through a start option cannot revive a cold Job", async () => {
  let ran = false;
  const job = new Job(() => {
    ran = true;
  });
  let closing!: Promise<void>;
  expect(() =>
    job.start({
      get context() {
        closing = job.close();
        return undefined;
      },
    }),
  ).toThrowError(LifecycleStateError);
  await closing;
  expect(ran).toBe(false);
  expect(job.state).toBe("closed");
});

test("source listeners cannot suppress cancellation through the actual Job tree", async () => {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const reason = new Error("stop");
  let childStopped = false;
  const job = new Job(
    async () => {
      signal().addEventListener("abort", (event) => event.stopImmediatePropagation());
      fork(async () => {
        await untilCancelled();
        childStopped = true;
      });
      await Promise.resolve();
    },
    { signal: controller.signal },
  ).start();
  const result = job.result();
  controller.abort(reason);
  expect(await result).toEqual({ ok: false, error: reason });
  expect(childStopped).toBe(true);
});

test("owners can join children without closing admission, but descendants cannot join that barrier", async () => {
  await execute(async () => {
    const owner = currentState().job;
    let completed = false;
    fork(async () => {
      await expect(owner.joinChildren()).rejects.toBeInstanceOf(LifecycleDependencyError);
      await Promise.resolve();
      completed = true;
    });
    await owner.joinChildren();
    expect(completed).toBe(true);
    expect(await fork(() => "admitted")).toBe("admitted");
  });
});

test("an owner can cancel and join its descendants without cancelling itself or sealing admission", async () => {
  const reason = new Error("stop descendants");
  await execute(async () => {
    const owner = currentState().job;
    const entered = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cancelled = false;
    const child = fork(async () => {
      entered.resolve();
      try {
        await untilCancelled();
      } finally {
        cancelled = true;
        cleaning.resolve();
        await release.promise;
      }
    });

    await entered.promise;
    let joined = false;
    const cancelling = owner.cancelChildren(reason).then(() => {
      joined = true;
    });
    await cleaning.promise;
    expect(cancelled).toBe(true);
    expect(joined).toBe(false);
    expect(signal().aborted).toBe(false);
    release.resolve();
    await cancelling;
    expect(await child.result()).toEqual({ ok: false, error: reason });
    expect(await fork(() => "admitted")).toBe("admitted");
  });
});

test("a descendant cannot cancel and join its owner's children", async () => {
  await execute(async () => {
    const owner = currentState().job;
    await fork(async () => {
      await expect(owner.cancelChildren()).rejects.toBeInstanceOf(LifecycleDependencyError);
    });
  });
});

test("reconcileFailure replaces cancellation with the recorded failure and retains other errors", async () => {
  const childFailure = new Error("child");
  const job = new Job(async () => {
    fork(() => {
      throw childFailure;
    });
    await untilCancelled();
    signal().throwIfAborted();
  }).start();
  await job.result();

  expect(job.reconcileFailure(job.signal.reason)).toBe(childFailure);
  const caught = new Error("caught");
  const reconciled = job.reconcileFailure(caught) as AggregateError;
  expect(reconciled).toBeInstanceOf(AggregateError);
  expect(reconciled.errors).toEqual([caught, childFailure]);
  expect(new Job(() => undefined).reconcileFailure(caught)).toBe(caught);
});

test("a cold Job cannot be consumed or restarted, and cold close never runs its body", async () => {
  let calls = 0;
  const job = new Job(() => ++calls);
  await expect(job.join()).rejects.toBeInstanceOf(LifecycleStateError);
  expect(calls).toBe(0);
  const result = job.result();
  await job.close();
  expect((await result).ok).toBe(false);
  expect(calls).toBe(0);
  expect(() => job.start()).toThrowError(LifecycleStateError);
  const started = new Job(() => ++calls).start();
  expect(() => started.start()).toThrowError(LifecycleStateError);
  expect(await started).toBe(1);
  await started.close();
  expect(started.signal.aborted).toBe(false);
});

test("reentrant close joins cleanup after admission has already been sealed", async () => {
  const release = Promise.withResolvers<void>();
  let reentrant: Promise<void> | undefined;
  let admissionError: unknown;
  const job = new Job(async () => {
    await untilCancelled();
    await release.promise;
  }).start();
  job.signal.addEventListener("abort", () => {
    reentrant = job.close();
    try {
      new Job(() => undefined).start({ parent: job });
    } catch (error) {
      admissionError = error;
    }
  });
  const closing = job.close();
  const completed: string[] = [];
  const outer = closing.then(() => completed.push("outer"));
  const inner = reentrant!.then(() => completed.push("inner"));
  try {
    expect(admissionError).toBeInstanceOf(LifecycleStateError);
    await nextTurn();
    expect(completed).toEqual([]);
  } finally {
    release.resolve();
    await Promise.all([outer, inner]);
  }
});
test("Job results distinguish returning undefined from throwing undefined", async () => {
  const successful = new Job(() => undefined).start();
  const failed = new Job(() => {
    throw undefined;
  }).start();

  expect(await successful.result()).toStrictEqual({ ok: true, value: undefined });
  expect(await failed.result()).toStrictEqual({ ok: false, error: undefined });
  await expect(successful.join()).resolves.toBeUndefined();
  await expect(failed.join()).rejects.toBeUndefined();
});

test("a throwing start option leaves the declaration reusable under its intended owner", async () => {
  await using owner = new Job(untilCancelled).start();
  const failure = new Error("context lookup failed");
  const job = new Job(() => 42);
  let thrown: unknown;
  try {
    job.start({
      parent: owner,
      get context(): never {
        throw failure;
      },
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(failure);
  expect(await job.start({ parent: owner })).toBe(42);
  expect(owner.signal.aborted).toBe(false);
});

test("finish seals direct admission without cancelling or truncating expanding descendants", async () => {
  const expand = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = new Job(() => {
    fork(async () => {
      await expand.promise;
      return await fork(async () => {
        entered.resolve();
        await release.promise;
        return 7;
      });
    });
    return 42;
  }).start();
  let settled = false;
  const finished = owner.finish().finally(() => {
    settled = true;
  });
  try {
    expect(() => new Job(() => undefined).start({ parent: owner })).toThrowError(
      LifecycleStateError,
    );
    expand.resolve();
    await entered.promise;
    await nextTurn();
    expect(settled).toBe(false);
    expect(owner.signal.aborted).toBe(false);
  } finally {
    expand.resolve();
    release.resolve();
    await finished;
  }
  expect(await finished).toBe(42);
});
