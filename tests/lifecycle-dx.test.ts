import { expect, test } from "vitest";
import {
  ApplicationLifecycle,
  LifecycleDependencyError,
  LifecycleStateError,
  currentState,
  execute,
  fork,
  type Task,
} from "../src/index.js";

test("startup consumption rejects its gated task without losing failure ownership", async () => {
  const app = new ApplicationLifecycle();
  let task!: Task<void>;
  let ran = false;
  app.scope.addStartup(async () => {
    task = app.background.run(() => {
      ran = true;
    });
    await task;
  });
  const failure = await app.start().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(LifecycleDependencyError);
  expect(ran).toBe(false);
  await expect(app.background.flush()).rejects.toBe(failure);
  await expect(app.close()).rejects.toBe(failure);
  await expect(Promise.resolve(task)).rejects.toBe(failure);
});

test("startup may submit work and recover from an early then consumption attempt", async () => {
  await using app = new ApplicationLifecycle();
  let task!: Task<number>;
  let rejected: unknown;
  app.scope.addStartup(async () => {
    task = app.background.run(() => 42);
    rejected = await task.then(undefined, (error: unknown) => error);
  });
  await app.start();
  expect(rejected).toBeInstanceOf(LifecycleDependencyError);
  expect(await task).toBe(42);
});

test("the first submission marks its admission dependency before startup can join it", async () => {
  await using app = new ApplicationLifecycle();
  let rejected: unknown;
  app.scope.addStartup(async () => {
    rejected = await app.background.flush().catch((error: unknown) => error);
  });
  expect(await app.background.run(() => 42)).toBe(42);
  expect(rejected).toBeInstanceOf(LifecycleDependencyError);
});

test("managed warmup cannot start application shutdown or consume its startup barrier", async () => {
  const app = new ApplicationLifecycle();
  const failures: unknown[] = [];
  let disposed = false;
  app.scope.defer(() => {
    disposed = true;
  });
  app.scope.addStartup(({ execute }) =>
    execute(async () => {
      failures.push(await app.close().catch((error: unknown) => error));
      failures.push(await app.start().catch((error: unknown) => error));
      try {
        app.admit();
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  await app.start();
  expect(failures).toEqual([
    expect.any(LifecycleDependencyError),
    expect.any(LifecycleDependencyError),
    expect.any(LifecycleDependencyError),
  ]);
  expect(app.closing).toBeUndefined();
  expect(disposed).toBe(false);
  await app.close();
  expect(disposed).toBe(true);
});

test("startup dependency ancestry survives an intermediate task completing", async () => {
  const app = new ApplicationLifecycle();
  const proceed = Promise.withResolvers<void>();
  let ran = false;
  app.scope.addStartup(({ execute }) =>
    execute(async () => {
      await fork(() => {
        fork(async () => {
          await proceed.promise;
          await app.background.run(() => {
            ran = true;
          });
        });
      });
      proceed.resolve();
    }),
  );
  const failure = await app.start().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(LifecycleDependencyError);
  expect(ran).toBe(false);
  await expect(app.close()).rejects.toBe(failure);
});

test("a supervisor task cannot join its own barriers and rejected close leaves admission open", async () => {
  await using app = new ApplicationLifecycle();
  const failures = await app.background.run(async () => [
    await app.background.flush().catch((error: unknown) => error),
    await app.background.close().catch((error: unknown) => error),
    await app.close().catch((error: unknown) => error),
  ]);
  expect(failures).toEqual([
    expect.any(LifecycleDependencyError),
    expect.any(LifecycleDependencyError),
    expect.any(LifecycleDependencyError),
  ]);
  expect(app.closing).toBeUndefined();
  expect(await app.background.run(() => 42)).toBe(42);
});

test("forked work cannot join its own group but the execution boundary still can", async () => {
  const failures: unknown[] = [];
  expect(
    await execute(async () => {
      await fork(async () => {
        failures.push(
          await currentState()
            .tasks.join()
            .catch((error: unknown) => error),
        );
        failures.push(
          await currentState()
            .tasks.close()
            .catch((error: unknown) => error),
        );
      });
      return 42;
    }),
  ).toBe(42);
  expect(failures).toEqual([
    expect.any(LifecycleDependencyError),
    expect.any(LifecycleDependencyError),
  ]);
});

test("independent application barriers do not inherit another application's ownership", async () => {
  await using first = new ApplicationLifecycle();
  const second = new ApplicationLifecycle();
  expect(await second.background.run(() => 21)).toBe(21);
  expect(
    await first.background.run(async () => {
      await second.background.flush();
      await second.close();
      return 42;
    }),
  ).toBe(42);
});

test("a drainer cannot await a closing application and does not replace its close promise", async () => {
  const app = new ApplicationLifecycle();
  let failure: unknown;
  app.onDrain(async () => {
    failure = await app.close().catch((error: unknown) => error);
  });
  const closing = app.close();
  await closing;
  expect(failure).toBeInstanceOf(LifecycleDependencyError);
  expect(app.close()).toBe(closing);
});

test("resource cleanup cannot await the application shutdown that owns its disposal", async () => {
  const app = new ApplicationLifecycle();
  let failure: unknown;
  app.scope.defer(async () => {
    failure = await app.close().catch((error: unknown) => error);
  });
  await app.close();
  expect(failure).toBeInstanceOf(LifecycleDependencyError);
});

test("a closed event bus cannot strand startup or skip application resource cleanup", async () => {
  const app = new ApplicationLifecycle();
  let disposed = false;
  app.scope.defer(() => {
    disposed = true;
  });
  await app.events.close();
  const startingFailure = await app.start().catch((error: unknown) => error);
  expect(startingFailure).toBeInstanceOf(LifecycleStateError);
  expect(app.started).toBe(false);
  const closingFailure = await app.close().catch((error: unknown) => error);
  expect(closingFailure).toBeInstanceOf(AggregateError);
  expect((closingFailure as AggregateError).errors).toContain(startingFailure);
  expect(disposed).toBe(true);
});

test("admission errors distinguish closing from closed without closing the scope before drain", async () => {
  const app = new ApplicationLifecycle();
  const release = Promise.withResolvers<void>();
  app.onDrain(() => release.promise);
  const closing = app.close();
  try {
    await expect(app.start()).rejects.toMatchObject({
      owner: "ApplicationLifecycle",
      operation: "start",
      state: "closing",
    });
    expect(() => app.onDrain(() => {})).toThrow(LifecycleStateError);
    expect(() => app.background.run(() => 1)).toThrow(LifecycleStateError);
    await using _child = app.scope.child();
  } finally {
    release.resolve();
  }
  await closing;
  await expect(app.start()).rejects.toMatchObject({
    owner: "ApplicationLifecycle",
    operation: "start",
    state: "closed",
  });
});
