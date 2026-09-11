import { expect, expectTypeOf, test } from "vitest";
import {
  Job,
  Supervisor,
  TaskGroup,
  LifecycleDependencyError,
  LifecycleStateError,
  contextKey,
  currentState,
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

test("nested results follow declaration order rather than completion order with direct leaf ownership", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const releaseFirst = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const releaseThird = Promise.withResolvers<void>();
  const first = new Job(async () => {
    await releaseFirst.promise;
    return 1;
  });
  const second = new Job(async () => {
    await releaseSecond.promise;
    return "two";
  });
  const third = new Job(async () => {
    await releaseThird.promise;
    return true;
  });
  const group = new TaskGroup([first, new TaskGroup([second, third]), new TaskGroup([])]);
  const running = supervisor.run(group);
  expectTypeOf(running).toEqualTypeOf<Promise<[number, [string, boolean], []]>>();
  const outcome = running.catch((error: unknown) => error);
  try {
    expect(supervisor.job.size).toBe(3);
    expect([first.parent, second.parent, third.parent]).toEqual([
      supervisor.job,
      supervisor.job,
      supervisor.job,
    ]);
    releaseThird.resolve();
    await third.result();
    releaseSecond.resolve();
    await second.result();
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    releaseThird.resolve();
  }
  expect(await outcome).toEqual([1, ["two", true], []]);
});

test("declarations snapshot membership but choose owner context only at activation", async () => {
  const Key = contextKey<string>("declaration context");
  let group!: TaskGroup<readonly Job<string | undefined>[]>;
  const leaf = new Job(() => use(Key));
  const members = [leaf];
  await execute({ values: [provide(Key, "submitter")] }, () => {
    group = new TaskGroup(members);
  });
  members.push(new Job(() => "not a member"));
  await using supervisor = new Supervisor(new Job(untilAbort, { values: [provide(Key, "owner")] }));
  supervisor.start();
  expect(await supervisor.run(group)).toEqual(["owner"]);
  expect(members[1]!.state).toBe("created");
});

test("duplicate and reused members reject before any fresh body or seed is touched", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  let calls = 0;
  let seedReads = 0;
  const fresh = new Job(
    () => {
      calls++;
    },
    {
      get values() {
        seedReads++;
        return [];
      },
    },
  );
  expect(() => supervisor.run(new TaskGroup([fresh, new TaskGroup([fresh])]))).toThrow(TypeError);
  expect([calls, seedReads]).toEqual([0, 0]);
  const used = new Job(() => 42);
  expect(await supervisor.run(used)).toBe(42);
  expect(() => supervisor.run(new TaskGroup([fresh, used]))).toThrow(LifecycleStateError);
  expect([calls, seedReads]).toEqual([0, 0]);
  expect(await supervisor.run(new TaskGroup([fresh]))).toEqual([undefined]);
});

test("ancestor rejection leaves earlier members available for a later valid submission", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  let calls = 0;
  const fresh = new Job(() => ++calls);
  await supervisor.run(() => {
    expect(() => supervisor.run(new TaskGroup([fresh, currentState().job]))).toThrow(
      LifecycleDependencyError,
    );
  });
  expect(calls).toBe(0);
  expect(await supervisor.run(new TaskGroup([fresh]))).toEqual([1]);
});

test("fail-fast cancels sibling leaves immediately but joins their entire descendant lifetimes", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const fail = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const descendantEntered = Promise.withResolvers<void>();
  const failure = new Error("group failure");
  const failing = new Job(async () => {
    await fail.promise;
    throw failure;
  });
  // Stopping abort delivery cannot suppress the actual child failure.
  failing.signal.addEventListener("abort", (event) => {
    event.stopImmediatePropagation();
  });
  const sibling = new Job(() => {
    fork(async () => {
      descendantEntered.resolve();
      try {
        await untilAbort();
      } finally {
        cleaning.resolve();
        await release.promise;
      }
    });
    return "body returned";
  });
  let settled = false;
  const outcome = supervisor
    .run(new TaskGroup([failing, sibling]))
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  await descendantEntered.promise;
  fail.resolve();
  await cleaning.promise;
  try {
    expect(sibling.signal.aborted).toBe(true);
    expect(settled).toBe(false);
  } finally {
    release.resolve();
  }
  expect(await outcome).toBe(failure);
  expect(await supervisor.run(() => "owner survived")).toBe("owner survived");
});

test("an isolating subgroup does not poison sibling groups in a fail-fast outer declaration", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort), { failure: "fail-fast" });
  supervisor.start();
  const fail = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error("isolated subgroup");
  const failing = new Job(async () => {
    await fail.promise;
    throw failure;
  });
  const localSibling = new Job(async () => {
    await release.promise;
    return signal().aborted;
  });
  const outerSibling = new Job(async () => {
    await release.promise;
    return signal().aborted;
  });
  const group = new TaskGroup([
    new TaskGroup([failing, localSibling], { failure: "isolate" }),
    new TaskGroup([outerSibling]),
  ]);
  const outcome = supervisor.run(group).catch((error: unknown) => error);
  fail.resolve();
  await failing.result();
  try {
    expect([localSibling.signal.aborted, outerSibling.signal.aborted]).toEqual([false, false]);
  } finally {
    release.resolve();
  }
  expect(await outcome).toBe(failure);
  expect(await localSibling).toBe(false);
  expect(await outerSibling).toBe(false);
  expect(await supervisor.run(() => "owner survived")).toBe("owner survived");
});

test("a fail-fast subgroup cancels locally but an isolating outer group lets other subgroups finish", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const fail = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error("local failure");
  const local = new Job(untilAbort);
  const sibling = new Job(async () => {
    await release.promise;
    return 42;
  });
  const failing = new Job(async () => {
    await fail.promise;
    throw failure;
  });
  const outcome = supervisor
    .run(
      new TaskGroup([new TaskGroup([failing, local]), new TaskGroup([sibling])], {
        failure: "isolate",
      }),
    )
    .catch((error: unknown) => error);
  fail.resolve();
  await local.result();
  try {
    expect(local.signal.aborted).toBe(true);
    expect(sibling.signal.aborted).toBe(false);
  } finally {
    release.resolve();
  }
  expect(await outcome).toBe(failure);
  expect(await sibling).toBe(42);
});

test("a thrown undefined remains a genuine failure rather than a missing-error sentinel", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const group = new TaskGroup([
    new Job(() => {
      throw undefined;
    }),
    new Job(() => 42),
  ]);
  await expect(supervisor.run(group)).rejects.toBeUndefined();
});

test("independent failures are aggregated once by identity while preserving native compounds", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const shared = new Error("same error object");
  const compound = new SuppressedError(new Error("cleanup"), new Error("body"));
  const aggregate = new AggregateError([new Error("nested failure")], "application aggregate");
  const group = new TaskGroup(
    [
      new Job(() => {
        throw shared;
      }),
      new Job(() => {
        throw shared;
      }),
      new Job(() => {
        throw compound;
      }),
      new Job(() => {
        throw aggregate;
      }),
    ],
    { failure: "isolate" },
  );
  const failure = (await supervisor.run(group).catch((error: unknown) => error)) as AggregateError;
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toHaveLength(3);
  expect(failure.errors[0]).toBe(shared);
  expect(failure.errors[1]).toBe(compound);
  expect(failure.errors[2]).toBe(aggregate);
});

test("cancellation-only grouped work rejects the original cancellation reason", async () => {
  const supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const first = new Job(untilAbort);
  const second = new Job(untilAbort);
  const outcome = supervisor.run(new TaskGroup([first, second])).catch((error: unknown) => error);
  const reason = new Error("owner stopped");
  await supervisor.close(reason);
  expect(await outcome).toBe(reason);
});

test("reentrant owner close in a seed getter joins committed work without starting later bodies", async () => {
  const supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  let calls = 0;
  let closing: Promise<void> | undefined;
  const reason = new Error("seed cancelled owner");
  const first = new Job(
    () => {
      calls++;
    },
    {
      get values() {
        closing = supervisor.close(reason);
        return [];
      },
    },
  );
  const later = new Job(() => {
    calls++;
  });
  const outcome = supervisor.run(new TaskGroup([first, later])).catch((error: unknown) => error);
  expect(await outcome).toBe(reason);
  await closing;
  expect(calls).toBe(0);
  expect(first.parent).toBe(supervisor.job);
  expect([first.state, later.state]).toEqual(["closed", "closed"]);
});

test("empty declarations are reusable because they consume no single-use Jobs", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const empty = new TaskGroup([]);
  expect(await supervisor.run(empty)).toEqual([]);
  expect(await supervisor.run(new TaskGroup([empty, new TaskGroup([empty])]))).toEqual([[], [[]]]);
});

test("reentrant activation of a later member never reparents it or leaks its lifetime", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  let cleaned = false;
  const later = new Job(async () => {
    try {
      await untilAbort();
    } finally {
      cleaned = true;
    }
  });
  const first = new Job(() => 1, {
    get values() {
      supervisor.run(later);
      return [];
    },
  });
  await expect(supervisor.run(new TaskGroup([first, later]))).rejects.toBeInstanceOf(
    LifecycleStateError,
  );
  expect(cleaned).toBe(true);
  expect(later.parent).toBe(supervisor.job);
  expect([first.state, later.state]).toEqual(["closed", "closed"]);
  expect(await supervisor.run(() => 42)).toBe(42);
});

test("fail-fast supervision applies when a failure escapes all group isolation boundaries", async () => {
  const supervisor = new Supervisor(new Job(untilAbort), { failure: "fail-fast" });
  const ownerResult = supervisor.job.result();
  supervisor.start();
  const cleaning = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const failure = new Error("escaping group failure");
  const outsideGroup = supervisor.run(async () => {
    try {
      await untilAbort();
    } finally {
      cleaning.resolve();
      await releaseCleanup.promise;
    }
  });
  const group = new TaskGroup([
    new Job(async () => {
      await failed.promise;
      throw failure;
    }),
  ]);
  const outcome = supervisor.run(group).catch((error: unknown) => error);
  failed.resolve();
  await cleaning.promise;
  try {
    expect(supervisor.job.signal.aborted).toBe(true);
    expect(outsideGroup.state).not.toBe("closed");
  } finally {
    releaseCleanup.resolve();
  }
  expect(await outcome).toBe(failure);
  expect(await ownerResult).toEqual({ ok: false, error: failure });
  await expect(supervisor.close()).rejects.toBe(failure);
});

test("an application failure caused by earlier cancellation still escapes a fail-fast group and owner", async () => {
  const supervisor = new Supervisor(new Job(untilAbort), { failure: "fail-fast" });
  const ownerResult = supervisor.job.result();
  supervisor.start();
  const cleaning = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const peerEntered = Promise.withResolvers<void>();
  const outsideEntered = Promise.withResolvers<void>();
  let failure!: Error;
  const bad = new Job(async () => {
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        cleaning.resolve();
        await releaseCleanup.promise;
        failure = new Error("rollback failed", { cause: signal().reason });
        throw failure;
      },
    };
    await untilAbort();
  });
  const peer = new Job(async () => {
    peerEntered.resolve();
    await untilAbort();
  });
  const outside = new Job(async () => {
    outsideEntered.resolve();
    await untilAbort();
  });
  const badResult = bad.result();
  const peerResult = peer.result();
  const outsideResult = outside.result();
  supervisor.run(outside);
  const groupResult = supervisor.run(new TaskGroup([bad, peer])).catch((error: unknown) => error);
  await Promise.all([peerEntered.promise, outsideEntered.promise]);
  const reason = new Error("cancel only the bad leaf");
  bad.cancel(reason);
  await cleaning.promise;
  try {
    expect([peer.signal.aborted, outside.signal.aborted, supervisor.job.signal.aborted]).toEqual([
      false,
      false,
      false,
    ]);
  } finally {
    releaseCleanup.resolve();
  }
  const badOutcome = await badResult;
  expect(!badOutcome.ok && badOutcome.error).toBe(failure);
  expect(failure.cause).toBe(reason);
  await Promise.all([peerResult, outsideResult]);
  expect([peer.signal.aborted, outside.signal.aborted, supervisor.job.signal.aborted]).toEqual([
    true,
    true,
    true,
  ]);
  expect(await groupResult).toBe(failure);
  const ownerOutcome = await ownerResult;
  expect(!ownerOutcome.ok && ownerOutcome.error).toBe(failure);
  await expect(supervisor.close()).rejects.toBe(failure);
});

test("outer fail-fast cancels an isolating subgroup but not a separate submission", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const fail = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error("outside the isolation boundary");
  const isolated = new Job(untilAbort);
  const unrelated = new Job(async () => {
    await release.promise;
    return 42;
  });
  const otherGroup = supervisor.run(new TaskGroup([unrelated])).catch((error: unknown) => error);
  const outcome = supervisor
    .run(
      new TaskGroup([
        new Job(async () => {
          await fail.promise;
          throw failure;
        }),
        new TaskGroup([new TaskGroup([isolated])], { failure: "isolate" }),
      ]),
    )
    .catch((error: unknown) => error);
  fail.resolve();
  try {
    expect(await outcome).toBe(failure);
    expect(isolated.signal.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);
  } finally {
    release.resolve();
  }
  expect(await otherGroup).toEqual([42]);
});

test("reentrant group submission cannot reserve an outer member or consume its own fresh members", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const fail = Promise.withResolvers<void>();
  const failure = new Error("outer group failure");
  const fresh = new Job(() => 42);
  const later = new Job(async () => {
    await fail.promise;
    throw failure;
  });
  const first = new Job(untilAbort, {
    get values() {
      expect(() =>
        supervisor.run(new TaskGroup([fresh, new TaskGroup([later])], { failure: "isolate" })),
      ).toThrow(TypeError);
      return [];
    },
  });
  const outcome = supervisor.run(new TaskGroup([first, later])).catch((error: unknown) => error);
  fail.resolve();
  expect(await outcome).toBe(failure);
  expect(first.signal.aborted).toBe(true);
  expect(await supervisor.run(new TaskGroup([fresh]))).toEqual([42]);
});
