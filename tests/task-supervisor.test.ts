import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import {
  AppClosing,
  ApplicationLifecycle,
  Scope,
  TaskSupervisor,
  contextKey,
  currentAttachment,
  currentScope,
  deadline,
  execute,
  fork,
  inject,
  onDispose,
  provide,
  scoped,
  signal,
  token,
  use,
  type Task,
} from "../src/index.js";

// Resolves on cancellation; callers decide whether cancellation should reject.
function untilAbort(): Promise<void> {
  const current = signal();
  if (current.aborted) {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  current.addEventListener("abort", () => resolve(), { once: true });
  return promise;
}

test("background work survives request cancellation and reads only explicit data and application providers", async () => {
  await using app = new ApplicationLifecycle();
  const Tenant = contextKey<string>("tenant");
  const Secret = contextKey<string>("secret");
  const Config = token<string>("config");
  app.scope.provide(Config, () => "application");
  await using requestScope = app.scope.child();
  requestScope.provide(Config, () => "request");
  const controller = new AbortController();
  const release = Promise.withResolvers<void>();
  const ended: string[] = [];
  let task!: Task<unknown>;

  await expect(
    execute(
      {
        scope: requestScope,
        signal: controller.signal,
        deadline: Date.now() + 1000,
        attachment: { request: true },
        values: [provide(Tenant, "request"), provide(Secret, "private")],
      },
      () => {
        const values = [provide(Tenant, "background")];
        task = app.background.run({ values }, async () => {
          onDispose(() => ended.push(`disposed:${use(Tenant)}`));
          await release.promise;
          return {
            tenant: use(Tenant),
            secret: use(Secret),
            attachment: currentAttachment(),
            deadline: deadline(),
            config: inject(Config),
            aborted: signal().aborted,
            sharesRequestScope: currentScope() === requestScope,
          };
        });
        values[0] = provide(Tenant, "mutated");
        controller.abort("request cancelled");
      },
    ),
  ).rejects.toBe("request cancelled");

  release.resolve();
  expect(await task).toEqual({
    tenant: "background",
    secret: undefined,
    attachment: undefined,
    deadline: undefined,
    config: "application",
    aborted: false,
    sharesRequestScope: false,
  });
  expect(ended).toEqual(["disposed:background"]);
});

test("each background task owns resources locally while sharing application singleton identity", async () => {
  await using app = new ApplicationLifecycle();
  class Shared {}
  const Local = token<object>("local");
  const gate = Promise.withResolvers<void>();
  const released: object[] = [];
  const launch = () =>
    app.background.run(async () => {
      const local = scoped(
        Local,
        () => ({}),
        (value) => {
          released.push(value);
        },
      );
      expect(scoped(Local, () => ({}))).toBe(local);
      const shared = inject(Shared);
      await gate.promise;
      return { local, shared };
    });
  const first = launch();
  const second = launch();
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  expect(a.local).not.toBe(b.local);
  expect(a.shared).toBe(b.shared);
  expect(released).toContain(a.local);
  expect(released).toContain(b.local);
});

test("submission from a factory does not retain its construction scope during work or cleanup", async () => {
  await using app = new ApplicationLifecycle();
  const Config = token<string>("config");
  app.scope.provide(Config, () => "app");
  const factoryScope = new Scope();
  factoryScope.provide(Config, () => "factory");
  const Token = token<Task<string>>("submitted task");
  const cleanup: string[] = [];
  factoryScope.provide(Token, () =>
    app.background.run(() => {
      onDispose(() => {
        cleanup.push(inject(Config));
      });
      return inject(Config);
    }),
  );
  const task = factoryScope.get(Token);
  await factoryScope[Symbol.asyncDispose]();
  expect(await task).toBe("app");
  expect(cleanup).toEqual(["app"]);
});

test("application shutdown cancels before drain and joins descendants and local cleanup before shared disposal", async () => {
  const app = new ApplicationLifecycle();
  const entered = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>();
  const order: string[] = [];
  const Config = token<string>("config");
  app.scope.provide(Config, () => "app");
  app.scope.defer(() => {
    order.push("shared disposed");
  });
  const task = app.background.run(async () => {
    onDispose(async () => {
      order.push(`local cleanup:${inject(Config)}`);
      expect(() => fork(() => undefined)).toThrow();
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      order.push("local disposed");
    });
    fork(async () => {
      await untilAbort();
      order.push("descendant stopped");
    });
    entered.resolve();
    await untilAbort();
    order.push("handler stopped");
    signal().throwIfAborted();
  });
  const observed = Promise.resolve(task).catch((error: unknown) => error);
  await entered.promise;
  app.onDrain(async () => {
    await observed;
    order.push("drained");
  });
  app.events.on(AppClosing, () => {
    expect(() => app.background.run(() => undefined)).toThrow();
  });
  const closing = app.close();
  expect(app.close()).toBe(closing);
  await cleanupEntered.promise;
  try {
    expect(order.slice(0, 2).sort()).toEqual(["descendant stopped", "handler stopped"]);
    expect(order.slice(2)).toEqual(["local cleanup:app"]);
  } finally {
    releaseCleanup.resolve();
  }
  await closing;
  expect(order.slice(2)).toEqual([
    "local cleanup:app",
    "local disposed",
    "drained",
    "shared disposed",
  ]);
});

test("flush waits without cancellation and includes jobs submitted while it waits", async () => {
  await using app = new ApplicationLifecycle();
  const firstGate = Promise.withResolvers<void>();
  const secondGate = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  const order: string[] = [];
  app.background.run(async () => {
    await firstGate.promise;
    app.background.run(async () => {
      secondEntered.resolve();
      await secondGate.promise;
      expect(signal().aborted).toBe(false);
      order.push("second");
    });
    order.push("first");
  });
  const flushed = app.background.flush().then(() => {
    order.push("flushed");
  });
  firstGate.resolve();
  await secondEntered.promise;
  expect(order).toEqual(["first"]);
  secondGate.resolve();
  await flushed;
  expect(order).toEqual(["first", "second", "flushed"]);
  expect(await app.background.run(() => 42)).toBe(42);
});

test("cancelling one handle joins its cleanup without stopping siblings", async () => {
  await using app = new ApplicationLifecycle();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cleaned = false;
  const first = app.background.run(async () => {
    onDispose(() => {
      cleaned = true;
    });
    entered.resolve();
    await sleep(60_000, undefined, { signal: signal() });
  });
  const second = app.background.run(async () => {
    await release.promise;
    return signal().aborted;
  });
  const observed = Promise.resolve(first).catch((error: unknown) => error);
  await entered.promise;
  first.cancel("cancel one");
  await observed;
  expect(cleaned).toBe(true);
  release.resolve();
  expect(await second).toBe(false);
  await app.background.flush();
});

test("shutdown ignores expected Node cancellation but preserves unrelated cleanup failure", async () => {
  const app = new ApplicationLifecycle();
  const entered = Promise.withResolvers<void>();
  const failure = new Error("cleanup failed");
  app.background.run(async () => {
    entered.resolve();
    await sleep(60_000, undefined, { signal: signal() });
  });
  app.background.run(async () => {
    await untilAbort();
    throw failure;
  });
  await entered.promise;
  await expect(app.close()).rejects.toBe(failure);
});

test("unobserved failures preserve work and cleanup errors without cancelling siblings", async () => {
  const app = new ApplicationLifecycle();
  const workFailure = new Error("work");
  const localFailure = new Error("local cleanup");
  const rootFailure = new Error("root cleanup");
  const drainFailure = new Error("drain");
  app.background.run(() => {
    onDispose(() => {
      throw localFailure;
    });
    throw workFailure;
  });
  expect(await app.background.run(() => "sibling succeeded")).toBe("sibling succeeded");
  const failure = await app.background.flush().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([workFailure, localFailure]);
  app.scope.defer(() => {
    throw rootFailure;
  });
  app.onDrain(() => {
    throw drainFailure;
  });
  const closing = app.close();
  const error = await closing.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([drainFailure, failure, rootFailure]);
  expect(app.close()).toBe(closing);
});

test("awaited task failures belong to their caller rather than application shutdown", async () => {
  await using app = new ApplicationLifecycle();
  const failure = new Error("handled");
  await expect(
    Promise.resolve(
      app.background.run(() => {
        throw failure;
      }),
    ),
  ).rejects.toBe(failure);
  await app.background.flush();
  await app.close();
});

test("late observation releases only the handled failure from supervisor barriers", async () => {
  await using app = new ApplicationLifecycle();
  const failure = new Error("shared rejection");
  const first = app.background.run(() => {
    throw failure;
  });
  const second = app.background.run(() => {
    throw failure;
  });
  const initial = await app.background.flush().catch((error: unknown) => error);
  expect(initial).toBeInstanceOf(AggregateError);
  expect((initial as AggregateError).errors).toEqual([failure, failure]);

  await expect(Promise.resolve(first)).rejects.toBe(failure);
  await expect(app.background.flush()).rejects.toBe(failure);
  await expect(Promise.resolve(second)).rejects.toBe(failure);
  await app.background.flush();
  await app.close();
});

test("background work waits for application startup before accessing providers", async () => {
  await using app = new ApplicationLifecycle();
  const gate = Promise.withResolvers<void>();
  const Config = token<string>("config");
  let ready = false;
  let ran = false;
  app.scope.provide(Config, () => {
    expect(ready).toBe(true);
    return "ready";
  });
  app.scope.addStartup(async () => {
    await gate.promise;
    ready = true;
  });
  const task = app.background.run(() => {
    ran = true;
    return inject(Config);
  });
  expect(ran).toBe(false);
  gate.resolve();
  expect(await task).toBe("ready");
  expect(app.started).toBe(true);
});

test("shutdown during pending startup never starts the submitted handler", async () => {
  const app = new ApplicationLifecycle();
  const startup = Promise.withResolvers<void>();
  let ran = false;
  app.scope.addStartup(() => startup.promise);
  const task = app.background.run(() => {
    ran = true;
  });
  const observed = Promise.resolve(task).catch((error: unknown) => error);
  const closing = app.close();
  startup.resolve();
  await observed;
  await closing;
  expect(ran).toBe(false);
});

test("startup failure rejects waiting work without executing the handler", async () => {
  const app = new ApplicationLifecycle();
  const failure = new Error("startup failed");
  let ran = false;
  app.scope.addStartup(() => {
    throw failure;
  });
  await expect(
    Promise.resolve(
      app.background.run(() => {
        ran = true;
      }),
    ),
  ).rejects.toBe(failure);
  await expect(app.close()).rejects.toBe(failure);
  expect(ran).toBe(false);
});

test("closing a standalone supervisor rejects new work but leaves its borrowed scope open", async () => {
  await using scope = new Scope();
  const supervisor = new TaskSupervisor(scope);
  const closed = supervisor.close();
  expect(supervisor.close()).toBe(closed);
  expect(() => supervisor.run(() => undefined)).toThrow();
  await closed;
  class Service {}
  expect(scope.get(Service)).toBeInstanceOf(Service);
});

test("cancellation during resource disposal cannot commit a successful result", async () => {
  await using app = new ApplicationLifecycle();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const task = app.background.run(() => {
    onDispose(async () => {
      cleaning.resolve();
      await release.promise;
    });
    return "too early";
  });
  const result = Promise.resolve(task).catch((error: unknown) => error);
  await cleaning.promise;
  task.cancel("cancel during cleanup");
  release.resolve();
  expect(await result).toBe("cancel during cleanup");
});

test("a descendant failure remains owned after the top-level handler returns", async () => {
  const app = new ApplicationLifecycle();
  const failure = new Error("descendant cleanup");
  let disposed = false;
  app.background.run(() => {
    onDispose(() => {
      disposed = true;
    });
    fork(async () => {
      await untilAbort();
      throw failure;
    });
    return "handler result";
  });
  await expect(app.background.flush()).rejects.toBe(failure);
  expect(disposed).toBe(true);
  await expect(app.close()).rejects.toBe(failure);
});

test("closing reentrantly from a handler seals admission before cancellation callbacks run", async () => {
  const app = new ApplicationLifecycle();
  let closing: Promise<void> | undefined;
  let rejected = false;
  const task = app.background.run(() => {
    const current = signal();
    current.addEventListener(
      "abort",
      () => {
        try {
          app.background.run(() => undefined);
        } catch {
          rejected = true;
        }
      },
      { once: true },
    );
    closing = app.close();
  });
  await Promise.resolve(task).catch(() => undefined);
  await closing;
  expect(rejected).toBe(true);
});

test("unobserved submissions do not multiply the application's startup failure", async () => {
  const app = new ApplicationLifecycle();
  const failure = new Error("startup");
  let ran = false;
  app.scope.addStartup(() => {
    throw failure;
  });
  app.background.run(() => {
    ran = true;
  });
  app.background.run(() => {
    ran = true;
  });
  await expect(app.start()).rejects.toBe(failure);
  await expect(app.close()).rejects.toBe(failure);
  expect(ran).toBe(false);
});

test("closing during initial seed evaluation prevents the handler from being admitted", async () => {
  await using scope = new Scope();
  await using supervisor = new TaskSupervisor(scope);
  let closing: Promise<void> | undefined;
  let ran = false;
  expect(() =>
    supervisor.run(
      {
        get values() {
          closing = supervisor.close();
          return [];
        },
      },
      () => {
        ran = true;
      },
    ),
  ).toThrow();
  await closing;
  expect(ran).toBe(false);
});
