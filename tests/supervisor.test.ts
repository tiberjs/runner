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
  const current = signal();
  if (current.aborted) {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  current.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

test("isolated work preserves native disposal and descendant errors", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const handlerFailure = new Error("handler", { cause: new Error("native cause") });
  const descendantFailure = new Error("descendant");
  const cleanupFailure = new Error("cleanup");
  const task = supervisor.run(async () => {
    await using _resource = {
      [Symbol.asyncDispose]() {
        return Promise.reject(cleanupFailure);
      },
    };
    fork(() => {
      throw descendantFailure;
    });
    throw handlerFailure;
  });
  const result = await task.result();
  expect(result.ok).toBe(false);
  const failure = (result.ok ? undefined : result.error) as AggregateError;
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors).toContain(descendantFailure);
  const suppressed = failure.errors.find(
    (error: unknown) => error instanceof SuppressedError,
  ) as SuppressedError;
  expect(suppressed).toBeInstanceOf(SuppressedError);
  expect(suppressed.error).toBe(cleanupFailure);
  expect(suppressed.suppressed).toBe(handlerFailure);
  await supervisor.flush();
  expect(await supervisor.run(() => 42)).toBe(42);
});

test("explicit supervisor submission inherits owner context, not the submitting execution", async () => {
  const Tenant = contextKey<string>("tenant");
  const Secret = contextKey<string>("secret");
  const ownerAttachment = { service: true };
  await using supervisor = new Supervisor(
    new Job(
      async () => {
        await untilAbort();
      },
      { values: [provide(Tenant, "owner")], attachment: ownerAttachment },
    ),
  );
  supervisor.start();
  const controller = new AbortController();
  const release = Promise.withResolvers<void>();
  let task!: Job<unknown>;
  await expect(
    execute(
      {
        signal: controller.signal,
        deadline: Date.now() + 60_000,
        attachment: { request: true },
        values: [provide(Tenant, "request"), provide(Secret, "private")],
      },
      () => {
        task = supervisor.run({ values: [provide(Tenant, "explicit")] }, async () => {
          await release.promise;
          return {
            tenant: use(Tenant),
            secret: use(Secret),
            attachment: currentAttachment(),
            deadline: deadline(),
            aborted: signal().aborted,
            parent: currentState().job.parent,
          };
        });
        controller.abort("request cancelled");
      },
    ),
  ).rejects.toBe("request cancelled");
  release.resolve();
  expect(await task).toEqual({
    tenant: "explicit",
    secret: undefined,
    attachment: ownerAttachment,
    deadline: undefined,
    aborted: false,
    parent: supervisor.job,
  });
});

test("cancelling one submitted Job joins its finally without stopping siblings", async () => {
  await using supervisor = new Supervisor(new Job(untilAbort));
  supervisor.start();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  let settled = false;
  const first = supervisor.run(async () => {
    try {
      entered.resolve();
      await untilAbort();
      signal().throwIfAborted();
    } finally {
      cleaning.resolve();
      await releaseCleanup.promise;
    }
  });
  const second = supervisor.run(async () => {
    await release.promise;
    return signal().aborted;
  });
  const observed = first.result().then((result) => {
    settled = true;
    return result;
  });
  await entered.promise;
  const reason = new Error("cancel one");
  first.cancel(reason);
  await cleaning.promise;
  expect(settled).toBe(false);
  release.resolve();
  expect(await second).toBe(false);
  releaseCleanup.resolve();
  expect(await observed).toEqual({ ok: false, error: reason });
  expect(await supervisor.run(() => 42)).toBe(42);
});

test("fail-fast cancels siblings before the failed subtree finishes cleanup", async () => {
  const supervisor = new Supervisor(new Job(untilAbort), { failure: "fail-fast" });
  const ownerResult = supervisor.job.result();
  supervisor.start();
  const fail = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const siblingStopped = Promise.withResolvers<void>();
  const sibling = supervisor.run(async () => {
    await untilAbort();
    siblingStopped.resolve();
  });
  const failure = new Error("fatal descendant", { cause: new Error("native cause") });
  const failed = supervisor.run(() => {
    fork(async () => {
      await fail.promise;
      throw failure;
    });
    fork(async () => {
      try {
        await untilAbort();
      } finally {
        cleaning.resolve();
        await releaseCleanup.promise;
      }
    });
  });
  let childSettled = false;
  const childResult = failed.result().then((result) => {
    childSettled = true;
    return result;
  });
  fail.resolve();
  await Promise.all([cleaning.promise, siblingStopped.promise]);
  expect(childSettled).toBe(false);
  expect(() => supervisor.run(() => 1)).toThrow(LifecycleStateError);
  const closing = supervisor.close().catch((error: unknown) => error);
  releaseCleanup.resolve();
  expect(await childResult).toEqual({ ok: false, error: failure });
  expect(await ownerResult).toEqual({ ok: false, error: failure });
  expect(await sibling.result()).toEqual({ ok: false, error: supervisor.job.signal.reason });
  expect(await closing).toBe(failure);
});

test("an isolated child failure cannot replace the finite owner's result or escape its lifetime", async () => {
  const fail = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const failure = new Error("isolated child");
  let child!: Job<never>;
  const supervisor = new Supervisor(
    new Job(() => {
      child = supervisor.run(async () => {
        try {
          await fail.promise;
          throw failure;
        } finally {
          cleaning.resolve();
          await releaseCleanup.promise;
        }
      });
      return 42;
    }),
  );
  let settled = false;
  const ownerResult = supervisor.job.result().then((result) => {
    settled = true;
    return result;
  });
  supervisor.start();
  const childResult = child.result();
  fail.resolve();
  await cleaning.promise;
  expect(settled).toBe(false);
  releaseCleanup.resolve();
  expect(await childResult).toEqual({ ok: false, error: failure });
  expect(await ownerResult).toEqual({ ok: true, value: 42 });
  await supervisor.close();
});
