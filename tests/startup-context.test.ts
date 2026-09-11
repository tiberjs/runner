import { expect, test } from "vitest";
import {
  ApplicationLifecycle,
  LifecycleDependencyError,
  LifecycleStateError,
  Scope,
  ScopeStartupError,
  contextKey,
  currentScope,
  currentState,
  execute,
  fork,
  inject,
  onDispose,
  onStart,
  peekState,
  provide,
  scoped,
  token,
  use,
  type ScopeObject,
  type StartupContext,
} from "../src/index.js";

test("explicit startup execution joins warmup work and borrows resources until application close", async () => {
  const app = new ApplicationLifecycle();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const Resource = token<object>("warmup resource");
  const Secret = contextKey<string>("caller secret");
  const controller = new AbortController();
  const order: string[] = [];
  let resource: object | undefined;

  class Service {
    constructor() {
      onStart(async ({ execute }) => {
        expect(peekState()).toBeUndefined();
        await execute(() => {
          const state = currentState();
          expect(state.scope).toBe(app.scope);
          expect(state.context.signal).not.toBe(controller.signal);
          expect(state.context.deadline).toBeUndefined();
          expect(state.attachment).toBeUndefined();
          expect(use(Secret)).toBeUndefined();
          resource = scoped(
            Resource,
            () => ({}),
            () => {
              order.push("dispose");
            },
          );
          fork(async () => {
            entered.resolve();
            await release.promise;
            expect(inject(Resource)).toBe(resource);
            order.push("warmup");
          });
        });
        expect(peekState()).toBeUndefined();
        order.push("ready");
      });
    }
  }

  app.scope.get(Service);
  let started = false;
  const starting = execute(
    { signal: controller.signal, attachment: "request", values: [provide(Secret, "private")] },
    async () => {
      await app.start();
      started = true;
    },
  );
  await entered.promise;
  try {
    expect(started).toBe(false);
    expect(order).toEqual([]);
  } finally {
    release.resolve();
  }
  await starting;
  expect(order).toEqual(["warmup", "ready"]);
  expect(app.scope.get(Resource)).toBe(resource);
  await app.close();
  expect(order).toEqual(["warmup", "ready", "dispose"]);
});

test.each([false, true])(
  "startup context retires after hook settlement (failure: %s)",
  async (fails) => {
    const app = new ApplicationLifecycle();
    const failure = new Error("warmup failed", { cause: new Error("native cause") });
    let captured!: StartupContext;
    let invoked = false;
    app.scope.addStartup(async (startup) => {
      captured = startup;
      await startup.execute(() => {
        if (fails) {
          throw failure;
        }
      });
    });

    const expected = fails ? failure : undefined;
    await expect(app.start().catch((error: unknown) => error)).resolves.toBe(expected);
    await expect(
      captured.execute(() => {
        invoked = true;
      }),
    ).rejects.toBeInstanceOf(LifecycleStateError);
    expect(invoked).toBe(false);
    await expect(app.close().catch((error: unknown) => error)).resolves.toBe(expected);
  },
);

test("ordinary hooks stay outside managed execution even when a scope starts inside one", async () => {
  await using scope = new Scope(undefined, { startup: true });
  const Resource = token<string>("startup dependency");
  scope.provide(Resource, () => "owned");
  scope.addStartup(async () => {
    expect(peekState()).toBeUndefined();
    expect(currentScope()).toBe(scope);
    expect(inject(Resource)).toBe("owned");
    expect(() => fork(() => {})).toThrow();
    await Promise.resolve();
    expect(peekState()).toBeUndefined();
    expect(currentScope()).toBe(scope);
  });

  await execute(() => scope.start());
});

test("scope startup self-waits fail without closing or clearing the scope", async () => {
  await using scope = new Scope(undefined, { startup: true });
  const Resource = token<object>("existing resource");
  const resource = scope.use(Resource, () => ({}));
  let cleaned = false;
  scope.addStartup(async (startup) => {
    await expect(scope.start()).rejects.toBeInstanceOf(LifecycleDependencyError);
    await expect(scope[Symbol.asyncDispose]()).rejects.toBeInstanceOf(LifecycleDependencyError);
    expect(scope.get(Resource)).toBe(resource);
    onDispose(() => {
      cleaned = true;
    });
    await startup.execute(async () => {
      await expect(scope.start()).rejects.toBeInstanceOf(LifecycleDependencyError);
      await expect(scope[Symbol.asyncDispose]()).rejects.toBeInstanceOf(LifecycleDependencyError);
      expect(inject(Resource)).toBe(resource);
    });
  });

  await scope.start();
  expect(cleaned).toBe(false);
  expect(scope.get(Resource)).toBe(resource);
  await scope[Symbol.asyncDispose]();
  expect(cleaned).toBe(true);
});

test("structural hook thenables retain scope and startup dependency during assimilation", async () => {
  await using scope = new Scope(undefined, { startup: true });
  const Resource = token<string>("thenable dependency");
  scope.provide(Resource, () => "owned");
  const seen: string[] = [];
  class Service implements ScopeObject {
    onStart(startup: StartupContext): PromiseLike<void> {
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- Exercise lazy startup PromiseLike assimilation in its owning contexts.
        then(resolve, reject) {
          expect(peekState()).toBeUndefined();
          seen.push(inject(Resource));
          return Promise.resolve()
            .then(async () => {
              await expect(scope.start()).rejects.toBeInstanceOf(LifecycleDependencyError);
              await startup.execute(() => {
                seen.push(inject(Resource));
                expect(currentState().scope).toBe(scope);
              });
            })
            .then(resolve, reject);
        },
      };
    }
  }

  scope.get(Service);
  await scope.start();
  expect(seen).toEqual(["owned", "owned"]);
});

test("managed warmup does not admit startup-dependent resources resolved too late", async () => {
  const app = new ApplicationLifecycle();
  class LateDependency {
    constructor() {
      onStart(() => {});
    }
  }
  app.scope.addStartup((startup) =>
    startup.execute(() => {
      inject(LateDependency);
    }),
  );

  await expect(app.start()).rejects.toBeInstanceOf(ScopeStartupError);
  await expect(app.close()).rejects.toBeInstanceOf(ScopeStartupError);
});
