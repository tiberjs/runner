import { expect, describe, test } from "vitest";
import {
  ApplicationLifecycle,
  contextKey,
  currentScope,
  execute,
  fork,
  provide,
  withContext,
  inject,
  onDispose,
  onStart,
  ResolutionError,
  Scope,
  ScopeClosedError,
  ScopeDisposalConflictError,
  ScopeStartupError,
  type ScopeObject,
  scoped,
  token,
} from "../src/index.js";

describe("Scope lifecycle", () => {
  test("synchronous disposal closes untouched children without touching their parent", async () => {
    const parent = new Scope();
    const scope = parent.child();
    const Value = token<object>("unused provider");
    let acquired = false;
    scope.provide(Value, () => {
      acquired = true;
      return {};
    });

    expect(scope.disposeSync()).toBe(true);
    expect(scope.disposeSync()).toBe(true);
    expect(scope.has(Value)).toBe(false);
    expect(() => scope.get(Value)).toThrow(ScopeClosedError);
    expect(() => scope.use(Value, () => ({}))).toThrow(ScopeClosedError);
    expect(() => scope.child()).toThrow(ScopeClosedError);
    expect(() => scope.provide(Value, () => ({}))).toThrow(ScopeClosedError);
    expect(() => scope.defer(() => {})).toThrow(ScopeClosedError);
    expect(() => scope.addStartup(() => {})).toThrow(ScopeClosedError);
    expect(() => scope.sealStartup()).toThrow(ScopeClosedError);
    await expect(scope.start()).rejects.toBeInstanceOf(ScopeClosedError);
    expect(scope.startupPending).toBe(false);
    expect(acquired).toBe(false);

    const closing = scope[Symbol.asyncDispose]();
    expect(scope[Symbol.asyncDispose]()).toBe(closing);
    await closing;
    expect(scope.disposeSync()).toBe(true);

    parent.provide(Value, () => ({}));
    expect(parent.disposeSync()).toBe(true);
  });

  test.each(["sync", "async"] as const)(
    "children retain local acquisition and cleanup after %s parent disposal",
    async (mode) => {
      const parent = new Scope();
      const child = parent.child();
      const untouched = parent.child();
      const Value = token<object>("child-local");
      const value = {};
      const order: string[] = [];
      child.provide(Value, () => {
        onDispose(() => {
          order.push("resource");
        });
        return value;
      });
      if (mode === "sync") {
        parent.disposeSync();
      } else {
        await parent[Symbol.asyncDispose]();
      }

      expect(child.get(Value)).toBe(value);
      child.defer(() => {
        order.push("deferred");
      });
      expect(() => parent.get(Value)).toThrow(ScopeClosedError);
      expect(() => parent.defer(() => {})).toThrow(ScopeClosedError);
      expect(() => parent.child()).toThrow(ScopeClosedError);
      expect(() => parent.provide(Value, () => value)).toThrow(ScopeClosedError);
      await expect(parent.start()).rejects.toBeInstanceOf(ScopeClosedError);
      expect(parent.resolutionGraph()).toEqual({ nodes: [], edges: [] });

      await untouched[Symbol.asyncDispose]();
      expect(() => untouched.child()).toThrow(ScopeClosedError);
      await child[Symbol.asyncDispose]();
      expect(order).toEqual(["deferred", "resource"]);
      expect(() => child.get(Value)).toThrow(ScopeClosedError);
      await parent[Symbol.asyncDispose]();
    },
  );

  test("closed ancestors do not split disposal ownership between surviving siblings", async () => {
    const root = new Scope();
    const branch = root.child();
    const first = branch.child();
    const second = root.child();
    const Shared = token<object>("shared");
    const Explicit = token<object>("explicit duplicate");
    let disposed = 0;
    const shared = {
      [Symbol.dispose]() {
        disposed++;
      },
    };
    expect(branch.disposeSync()).toBe(true);
    expect(root.disposeSync()).toBe(true);

    expect(first.use(Shared, () => shared)).toBe(shared);
    expect(second.use(Shared, () => shared)).toBe(shared);
    expect(() =>
      second.use(
        Explicit,
        () => shared,
        () => {},
      ),
    ).toThrow(ScopeDisposalConflictError);
    expect(root.disposeSync()).toBe(true);
    expect(branch.disposeSync()).toBe(true);

    await second[Symbol.asyncDispose]();
    expect(disposed).toBe(0);
    await first[Symbol.asyncDispose]();
    expect(disposed).toBe(1);
    await Promise.all([root[Symbol.asyncDispose](), branch[Symbol.asyncDispose]()]);
    expect(disposed).toBe(1);
  });

  test("a child returned by execute remains independently usable and disposable", async () => {
    const child = await execute(() => currentScope().child());
    const Value = token<object>("returned child");
    const value = {};
    let disposed = false;
    expect(
      child.use(
        Value,
        () => value,
        () => {
          disposed = true;
        },
      ),
    ).toBe(value);
    expect(disposed).toBe(false);
    await child[Symbol.asyncDispose]();
    expect(disposed).toBe(true);
    expect(() => child.get(Value)).toThrow(ScopeClosedError);
  });

  test("a synchronous disposal attempt preserves cached instances and resource ownership", async () => {
    const scope = new Scope();
    const Value = token<object>("owned instance");
    const value = {};
    const order: string[] = [];
    scope.use(
      Value,
      () => value,
      () => {
        order.push("resource");
      },
    );
    expect(scope.disposeSync()).toBe(false);
    expect(scope.get(Value)).toBe(value);
    scope.defer(() => {
      order.push("deferred");
    });
    expect(order).toEqual([]);

    await scope[Symbol.asyncDispose]();
    expect(scope.disposeSync()).toBe(false);
    await scope[Symbol.asyncDispose]();
    expect(order).toEqual(["deferred", "resource"]);
    expect(() => scope.get(Value)).toThrow(ScopeClosedError);
  });

  test("plain cached values still require the asynchronous disposal path", async () => {
    const scope = new Scope();
    const Value = token<undefined>("cached undefined");
    scope.use(Value, () => undefined);
    expect(scope.disposeSync()).toBe(false);
    expect(scope.has(Value)).toBe(true);
    expect(scope.get(Value)).toBeUndefined();
    await scope[Symbol.asyncDispose]();
    expect(scope.has(Value)).toBe(false);
    expect(scope.disposeSync()).toBe(false);
  });

  test("synchronous attempts do not hide a previous asynchronous cleanup failure", async () => {
    const scope = new Scope();
    const failure = new Error("cleanup", { cause: new Error("native cause") });
    let disposed = 0;
    scope.defer(() => {
      disposed++;
      throw failure;
    });
    await expect(scope[Symbol.asyncDispose]()).rejects.toBe(failure);
    expect(scope.disposeSync()).toBe(false);
    await expect(scope[Symbol.asyncDispose]()).rejects.toBe(failure);
    expect(disposed).toBe(1);
  });

  test("concurrent disposal waits for one LIFO drain, including late cleanup", async () => {
    const scope = new Scope();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];

    scope.defer(() => {
      events.push("first");
    });
    scope.defer(async () => {
      events.push("second:begin");
      entered.resolve();

      await release.promise;

      onDispose(() => {
        events.push("late");
      });

      events.push("second:end");
    });

    expect(scope.disposeSync()).toBe(false);

    let completed = 0;
    const first = scope[Symbol.asyncDispose]().then(() => {
      completed++;
    });
    await entered.promise;
    expect(scope.disposeSync()).toBe(false);

    const second = scope[Symbol.asyncDispose]().then(() => {
      completed++;
    });

    try {
      await Promise.resolve();
      expect(completed).toBe(0);
      expect(events).toStrictEqual(["second:begin"]);
    } finally {
      release.resolve();
    }

    await Promise.all([first, second]);
    await scope[Symbol.asyncDispose]();

    expect(completed).toBe(2);
    expect(events).toStrictEqual(["second:begin", "second:end", "late", "first"]);
    expect(() => scope.defer(() => {})).toThrow(ScopeClosedError);
  });

  test("disposal waits for shared startup and skips startup not yet entered", async () => {
    const scope = new Scope(undefined, { startup: true });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];

    scope.addStartup(async () => {
      events.push("start:begin");
      entered.resolve();

      await release.promise;

      onDispose(() => {
        events.push("stop:initialized");
      });

      events.push("start:end");
    });
    scope.addStartup(() => {
      events.push("start:skipped");
    });
    scope.defer(() => {
      events.push("stop:existing");
    });

    const firstStart = scope.start();
    const secondStart = scope.start();
    await entered.promise;

    let closed = false;
    const closing = scope[Symbol.asyncDispose]().then(() => {
      closed = true;
    });

    try {
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(events).toStrictEqual(["start:begin"]);
    } finally {
      release.resolve();
    }

    await Promise.all([firstStart, secondStart, closing]);

    expect(events).toStrictEqual(["start:begin", "start:end", "stop:initialized", "stop:existing"]);
    await expect(scope.start()).rejects.toBeInstanceOf(ScopeClosedError);
  });

  test("startup drains nested registrations once and rejects later registrations", async () => {
    const scope = new Scope(undefined, { startup: true });
    const events: string[] = [];

    scope.addStartup(() => {
      events.push("first");
      onStart(() => {
        events.push("nested");
      });
    });

    await scope.start();
    await scope.start();

    expect(() =>
      scope.addStartup(() => {
        events.push("later");
      }),
    ).toThrow(ScopeStartupError);
    await scope.start();

    expect(events).toStrictEqual(["first", "nested"]);

    await scope[Symbol.asyncDispose]();
  });

  test("startup and teardown failures are retained for every disposal waiter", async () => {
    const scope = new Scope(undefined, { startup: true });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const startupFailure = new Error("startup failed");
    const firstFailure = new Error("first cleanup failed");
    const secondFailure = new Error("second cleanup failed");
    const events: string[] = [];

    scope.addStartup(async () => {
      entered.resolve();
      await release.promise;
      throw startupFailure;
    });
    scope.defer(() => {
      events.push("first");
      throw firstFailure;
    });
    scope.defer(() => {
      events.push("second");
      throw secondFailure;
    });

    const starting = Promise.allSettled([scope.start()]);
    await entered.promise;
    const disposing = scope[Symbol.asyncDispose]();
    const disposal = Promise.allSettled([disposing, scope[Symbol.asyncDispose]()]);

    release.resolve();
    const [startupOutcomes, disposalOutcomes] = await Promise.all([starting, disposal]);

    expect(startupOutcomes[0].status).toBe("rejected");
    expect((startupOutcomes[0] as PromiseRejectedResult).reason).toBe(startupFailure);
    expect(disposalOutcomes).toEqual([
      { status: "rejected", reason: expect.any(AggregateError) },
      { status: "rejected", reason: expect.any(AggregateError) },
    ]);
    const failure = (disposalOutcomes[0] as PromiseRejectedResult).reason as AggregateError;
    expect((disposalOutcomes[1] as PromiseRejectedResult).reason).toBe(failure);
    const errors = failure.errors as unknown[];
    expect(errors[0]).toBe(startupFailure);
    expect(errors[1]).toBe(secondFailure);
    expect(errors[2]).toBe(firstFailure);
    await expect(scope[Symbol.asyncDispose]()).rejects.toBe(failure);
    expect(events).toStrictEqual(["second", "first"]);
  });

  test("closing permits cached local resources but blocks all new acquisition", async () => {
    const scope = new Scope();
    const existing = token<object>("existing");
    const missing = token<object>("missing");
    const value = scope.use(existing, () => ({}));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    scope.defer(async () => {
      entered.resolve();
      await release.promise;
    });

    let acquired = 0;
    const factory = () => {
      acquired++;
      return {};
    };
    scope.provide(missing, factory);

    const closing = scope[Symbol.asyncDispose]();
    await entered.promise;

    try {
      expect(scope.get(existing)).toBe(value);
      expect(scope.use(existing, factory)).toBe(value);
      expect(() => scope.get(missing)).toThrow(ScopeClosedError);
      expect(() => scope.use(missing, factory)).toThrow(ScopeClosedError);
      expect(() => scope.provide(missing, factory)).toThrow(ScopeClosedError);
      expect(() => scope.child()).toThrow(ScopeClosedError);
      expect(() => scope.addStartup(() => {})).toThrow(ScopeClosedError);
      await expect(scope.start()).rejects.toMatchObject({ state: "closing" });
      expect(acquired).toBe(0);
    } finally {
      release.resolve();
      await closing;
    }

    expect(() => scope.get(existing)).toThrow(ScopeClosedError);
    expect(() => scope.use(existing, factory)).toThrow(ScopeClosedError);
    await expect(scope.start()).rejects.toMatchObject({ state: "disposed" });
    expect(acquired).toBe(0);
  });

  test("a factory initiating shutdown still transfers its resource into teardown", async () => {
    const scope = new Scope();
    const resource = token<object>("resource");
    const events: string[] = [];
    let closing: Promise<void> | undefined;

    scope.provide(resource, () => {
      onDispose(() => {
        events.push("partial");
      });

      closing = scope[Symbol.asyncDispose]();
      return {
        [Symbol.dispose]() {
          events.push("resource");
        },
      };
    });

    scope.get(resource);

    expect(closing).toBeInstanceOf(Promise);
    await closing;

    expect(events).toStrictEqual(["resource", "partial"]);
  });

  test("failed construction keeps partial cleanup, not startup, and can be retried", async () => {
    const scope = new Scope(undefined, { startup: true });
    const events: string[] = [];
    const failure = new Error("construction failed");
    const resource = token<object>("resource");
    let attempt = 0;

    class Dependency {
      constructor() {
        onStart(() => {
          events.push("start:dependency");
        });
        onDispose(() => {
          events.push("stop:dependency");
        });
      }
    }

    scope.provide(resource, () => {
      const current = ++attempt;
      onStart(() => {
        events.push(`start:${current}`);
      });

      inject(Dependency);
      onDispose(() => {
        events.push(`stop:${current}`);
      });

      if (current === 1) {
        throw failure;
      }

      return {};
    });

    let constructionFailure: unknown;
    try {
      scope.get(resource);
    } catch (error) {
      constructionFailure = error;
    }

    expect(constructionFailure).toBe(failure);

    const value = scope.get(resource);
    expect(scope.get(resource)).toBe(value);

    await scope.start();
    await scope[Symbol.asyncDispose]();

    expect(events).toStrictEqual([
      "start:dependency",
      "start:2",
      "stop:2",
      "stop:1",
      "stop:dependency",
    ]);
  });

  test("inline factories acquire nested resources in their own scope", async () => {
    const root = new Scope();
    const child = root.child();
    const outer = token<object>("outer");
    const inner = token<object>("inner");
    const events: string[] = [];

    root.provide(outer, () =>
      child.use(outer, () => {
        const nested = scoped(inner, () => ({
          [Symbol.dispose]() {
            events.push("inner");
          },
        }));

        onDispose(() => {
          events.push("outer");
        });

        return { nested };
      }),
    );

    root.get(outer);
    await root[Symbol.asyncDispose]();

    expect(events).toStrictEqual([]);

    await child[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["outer", "inner"]);
  });

  test("provider aliases borrow automatically tracked ancestor resources", async () => {
    const root = new Scope();
    const child = root.child();
    const resource = token<object>("resource");
    const alias = token<object>("alias");
    const childAlias = token<object>("child alias");
    const events: string[] = [];

    root.provide(resource, () => {
      scoped(token<object>("nested"), () => ({
        [Symbol.dispose]() {
          events.push("nested");
        },
      }));

      return {
        [Symbol.dispose]() {
          events.push("resource");
        },
      };
    });
    root.provide(alias, () => inject(resource));
    child.provide(childAlias, () => inject(alias));

    expect(child.get(childAlias)).toBe(root.get(resource));

    await child[Symbol.asyncDispose]();

    expect(events).toStrictEqual([]);

    await root[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["resource", "nested"]);
  });

  test("inline acquisition detects cycles and failed attempts remain retryable", async () => {
    const scope = new Scope();
    const resource = token<object>("resource");

    let cycleFailure: unknown;
    try {
      scope.use(resource, () => scoped(resource, () => ({})));
    } catch (error) {
      cycleFailure = error;
    }

    expect(cycleFailure).toBeInstanceOf(ResolutionError);
    expect((cycleFailure as ResolutionError).reason).toBe("circular-dependency");
    expect((cycleFailure as ResolutionError).token).toBe(resource);

    const events: string[] = [];
    const value = scope.use(resource, () => ({
      [Symbol.dispose]() {
        events.push("disposed");
      },
    }));

    expect(scope.get(resource)).toBe(value);

    await scope[Symbol.asyncDispose]();

    expect(events).toStrictEqual(["disposed"]);
  });

  test("a missing provider identifies the exact token and can be registered after failure", async () => {
    const scope = new Scope();
    const available = token<object>("store");
    const missing = token<object>("store");
    const value = {};
    scope.provide(available, () => value);

    let resolutionFailure: unknown;
    try {
      scope.get(missing);
    } catch (error) {
      resolutionFailure = error;
    }

    expect(resolutionFailure).toBeInstanceOf(ResolutionError);
    expect((resolutionFailure as ResolutionError).reason).toBe("missing-provider");
    expect((resolutionFailure as ResolutionError).token).toBe(missing);

    scope.provide(missing, () => value);

    expect(scope.get(missing)).toBe(value);

    await scope[Symbol.asyncDispose]();
  });

  test("undefined factory failures are not mistaken for a value or retained in the cache", async () => {
    const scope = new Scope();
    const resource = token<object>("resource");
    const value = {};
    let fail = true;

    scope.provide(resource, () => {
      if (fail) {
        throw undefined;
      }

      return value;
    });

    let threw = false;
    let constructionFailure: unknown;
    try {
      scope.get(resource);
    } catch (error) {
      threw = true;
      constructionFailure = error;
    }

    expect(threw).toBe(true);
    expect(constructionFailure).toBeUndefined();

    fail = false;

    expect(scope.get(resource)).toBe(value);

    await scope[Symbol.asyncDispose]();
  });

  test("application admission refuses pending startup and seals late synchronous injection", async () => {
    const app = new ApplicationLifecycle();
    const events: string[] = [];
    class Ready implements ScopeObject {
      onStart() {
        events.push("ready");
      }
    }
    class Late {
      constructor() {
        onDispose(() => {
          events.push("partial");
        });
        onStart(() => {
          events.push("late");
        });
      }
    }
    app.scope.get(Ready);
    expect(() => app.sealStartup()).toThrow(ScopeStartupError);
    await app.start();
    app.sealStartup();
    expect(() => app.scope.get(Late)).toThrow(ScopeStartupError);
    await app.close();
    expect(events).toEqual(["ready", "partial"]);
  });

  test("synchronous admission seals an unused application root before lazy resources resolve", async () => {
    const app = new ApplicationLifecycle();
    const events: string[] = [];
    class Late implements ScopeObject {
      onStart() {
        events.push("start");
      }
      onClose() {
        events.push("close");
      }
    }
    app.sealStartup();
    expect(() => app.scope.get(Late)).toThrow(ScopeStartupError);
    await app.start();
    await app.close();
    expect(events).toEqual(["close"]);
  });

  test("execution startup hooks fail synchronously and retain partial resource cleanup", async () => {
    const events: string[] = [];
    await expect(
      execute({ signal: new AbortController().signal, attachment: undefined }, () => {
        onDispose(() => {
          events.push("partial");
        });
        onStart(() => {
          events.push("start");
        });
        events.push("returned");
      }),
    ).rejects.toBeInstanceOf(ScopeStartupError);
    await expect(
      execute({ signal: new AbortController().signal, attachment: undefined }, () => {
        return scoped(token<ScopeObject>("request resource"), () => ({
          onStart() {
            events.push("start");
          },
          onClose() {
            events.push("close");
          },
        }));
      }),
    ).rejects.toBeInstanceOf(ScopeStartupError);
    expect(events).toEqual(["partial", "close"]);
  });

  test("child scopes do not inherit startup ownership or return a rejected alias", async () => {
    const root = new Scope(undefined, { startup: true });
    const child = root.child();
    const events: string[] = [];
    const value: ScopeObject = {
      onStart() {
        events.push("start");
      },
      onClose() {
        events.push("close");
      },
    };
    const resource = token<ScopeObject>("child resource");
    child.provide(resource, () => value);
    expect(() => child.get(resource)).toThrow(ScopeStartupError);
    expect(() => child.use(token<ScopeObject>("alias"), () => value)).toThrow(ScopeStartupError);
    await root.start();
    await child[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
    expect(events).toEqual(["close"]);
  });

  test("structural hooks preserve dependency ordering, receiver identity, and alias ownership", async () => {
    const scope = new Scope(undefined, { startup: true });
    const child = scope.child();
    const events: string[] = [];
    class Dependency implements ScopeObject {
      readonly name = "dependency";
      onStart() {
        events.push(`start:${this.name}`);
      }
      onClose() {
        events.push(`close:${this.name}`);
      }
    }
    class Service implements ScopeObject {
      readonly dependency = inject(Dependency);
      onStart() {
        events.push(`start:service:${this.dependency.name}`);
      }
      onClose() {
        events.push("close:service");
      }
    }
    const alias = token<Service>("alias");
    scope.provide(alias, () => inject(Service));
    child.provide(alias, () => scope.get(alias));
    expect(child.get(alias)).toBe(scope.get(Service));
    await scope.start();
    await child[Symbol.asyncDispose]();
    expect(events).toEqual(["start:dependency", "start:service:dependency"]);
    await scope[Symbol.asyncDispose]();
    expect(events).toEqual([
      "start:dependency",
      "start:service:dependency",
      "close:service",
      "close:dependency",
    ]);
  });

  test("startup callbacks cannot resolve uninitialized startup resources, yet partial cleanup is retained", async () => {
    const scope = new Scope(undefined, { startup: true });
    const events: string[] = [];
    class Acquired implements ScopeObject {
      onStart() {
        events.push("acquired:start");
      }
      onClose() {
        events.push("acquired:close");
      }
    }
    let failure: unknown;
    scope.addStartup(() => {
      onDispose(() => {
        events.push("startup:close");
        onDispose(() => {
          events.push("teardown:close");
        });
      });
      try {
        inject(Acquired);
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    await expect(scope.start()).rejects.toBeInstanceOf(ScopeStartupError);
    expect(failure).toMatchObject({ state: "late" });
    expect(() => scope.addStartup(() => {})).toThrow(ScopeStartupError);
    await expect(scope[Symbol.asyncDispose]()).rejects.toBe(failure);
    // Never started, so never closed through startup; cleanup still runs LIFO.
    expect(events).toEqual(["acquired:close", "startup:close", "teardown:close"]);
  });

  test("a closing request scope can still resolve open application singletons", async () => {
    const root = new Scope(undefined, { startup: true });
    const child = root.child();
    const events: string[] = [];
    class Logger {
      log(message: string) {
        events.push(message);
      }
    }
    root.get(Logger);
    child.defer(() => {
      inject(Logger).log("closing");
    });
    await child[Symbol.asyncDispose]();
    expect(() => child.get(Logger)).toThrow(ScopeClosedError);
    await root[Symbol.asyncDispose]();
    expect(events).toEqual(["closing"]);
  });

  test("disposal ownership is direction independent and an explicit disposer overrides shape conflicts", async () => {
    const root = new Scope(undefined, { startup: true });
    const child = root.child();
    let disposed = 0;
    const shared = {
      [Symbol.dispose]() {
        disposed++;
      },
    };
    child.use(token("child first"), () => shared);
    expect(root.use(token("root alias"), () => shared)).toBe(shared);
    await child[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
    expect(disposed).toBe(1);

    const explicit = new Scope(undefined, { startup: true });
    const events: string[] = [];
    const thirdParty = {
      onClose() {
        events.push("onClose");
      },
      [Symbol.dispose]() {
        events.push("dispose");
      },
    };
    explicit.use(
      token("wrapped"),
      () => thirdParty,
      () => {
        events.push("explicit");
      },
    );
    await explicit[Symbol.asyncDispose]();
    expect(events).toEqual(["explicit"]);
  });

  test("conflicting close protocols fail acquisition and roll back exactly one disposer", async () => {
    const scope = new Scope(undefined, { startup: true });
    const events: string[] = [];
    const value = {
      onStart() {
        events.push("start");
      },
      onClose() {
        events.push("onClose");
      },
      [Symbol.asyncDispose]() {
        events.push("asyncDispose");
        return Promise.resolve();
      },
      [Symbol.dispose]() {
        events.push("dispose");
      },
    };
    const resource = token<typeof value>("conflict");
    scope.provide(resource, () => {
      onDispose(() => {
        events.push("partial");
      });
      return value;
    });
    expect(() => scope.get(resource)).toThrow(ScopeDisposalConflictError);
    expect(() => scope.use(token<typeof value>("alias"), () => value)).toThrow(
      ScopeDisposalConflictError,
    );
    await scope.start();
    await scope[Symbol.asyncDispose]();
    expect(events).toEqual(["asyncDispose", "partial"]);
  });

  test("explicit disposal owns aliases once while preserving structural startup", async () => {
    const scope = new Scope(undefined, { startup: true });
    const child = scope.child();
    const events: string[] = [];
    const value: ScopeObject = {
      onStart() {
        events.push("start");
      },
      onClose() {
        events.push("automatic");
      },
    };
    scope.use(
      token<ScopeObject>("resource"),
      () => value,
      () => {
        events.push("explicit");
      },
    );
    child.use(token<ScopeObject>("borrowed"), () => value);
    expect(() =>
      child.use(
        token<ScopeObject>("second owner"),
        () => value,
        () => {
          events.push("duplicate");
        },
      ),
    ).toThrow(ScopeDisposalConflictError);
    await scope.start();
    await child[Symbol.asyncDispose]();
    await scope[Symbol.asyncDispose]();
    expect(events).toEqual(["start", "explicit"]);
  });

  test("shutdown during construction cannot return a resource whose startup was abandoned", async () => {
    const scope = new Scope(undefined, { startup: true });
    const events: string[] = [];
    let closing: Promise<void> | undefined;
    expect(() =>
      scope.use(token<ScopeObject>("closing resource"), () => {
        onStart(() => {
          events.push("start");
        });
        closing = scope[Symbol.asyncDispose]();
        return {
          onClose() {
            events.push("close");
          },
        };
      }),
    ).toThrow(ScopeClosedError);
    await closing;
    expect(events).toEqual(["close"]);
  });

  test("an execution started during startup resolves its own scope, not the constructing one", async () => {
    await using app = new ApplicationLifecycle();
    const Config = token<string>("config");
    app.scope.provide(Config, () => "app");
    const requestScope = app.scope.child();
    const events: string[] = [];
    let executionScope: unknown;

    class Boot {
      constructor() {
        onStart(async () => {
          await execute(
            {
              scope: requestScope,
              signal: new AbortController().signal,
              attachment: undefined,
            },
            async () => {
              executionScope = currentScope();
              events.push(`resolved:${inject(Config)}`);
              onDispose(() => {
                events.push("execution:cleanup");
              });
            },
          );
          events.push("startup:done");
        });
      }
    }
    app.scope.get(Boot);
    await app.start();

    expect(executionScope).toBe(requestScope);
    expect(events).toEqual(["resolved:app", "startup:done"]);

    await requestScope[Symbol.asyncDispose]();
    expect(events).toEqual(["resolved:app", "startup:done", "execution:cleanup"]);
  });

  test("a derivation inside construction still owns resources in the constructing scope", async () => {
    const Tenant = contextKey<string>("tenant");
    const Built = token<object>("built");
    const root = new Scope();
    const events: string[] = [];
    const joined: PromiseLike<void>[] = [];

    root.provide(Built, () => {
      withContext([provide(Tenant, "acme")], () => {
        onDispose(() => {
          events.push("context");
        });
      });
      joined.push(
        fork(async () => {
          onDispose(() => {
            events.push("fork");
          });
        }),
      );

      return {};
    });

    const request = root.child();
    await execute({ scope: request, attachment: undefined }, async () => {
      root.get(Built);

      await Promise.all(joined);
    });

    await request[Symbol.asyncDispose]();
    expect(events).toEqual([]);

    await root[Symbol.asyncDispose]();
    expect(events).toEqual(["fork", "context"]);
  });
});
