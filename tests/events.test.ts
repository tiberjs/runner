import { describe, expect, test, vi } from "vitest";
import {
  ApplicationLifecycle,
  EventBus,
  LifecycleDependencyError,
  LifecycleStateError,
  Scope,
  type EventBusOptions,
  type EventErrorContext,
  currentScope,
  eventKey,
  execute,
  fork,
  inject,
  onDispose,
  onStart,
  scoped,
  signal,
  token,
} from "../src/index.js";

describe("EventBus", () => {
  test("keys and app instances isolate notifications", () => {
    const first = new EventBus();
    const second = new EventBus();
    const key = eventKey<number>("changed");
    const sameDescription = eventKey<number>("changed");
    const received: number[] = [];

    first.on(key, (value) => {
      received.push(value);
    });
    first.on(sameDescription, (value) => {
      received.push(-value);
    });

    second.emit(key, 1);
    first.emit(sameDescription, 2);
    first.emit(key, 3);

    expect(received).toStrictEqual([-2, 3]);
  });

  test("subscription mutations affect the next emission, not the current snapshot", () => {
    const bus = new EventBus();
    const key = eventKey<void>("changed");
    const order: string[] = [];
    let first = true;

    bus.on(key, () => {
      order.push("first");
      if (!first) {
        return;
      }

      first = false;
      offSecond();
      bus.on(key, () => {
        order.push("third");
      });
    });
    const offSecond = bus.on(key, () => {
      order.push("second");
    });

    bus.emit(key, undefined);
    bus.emit(key, undefined);

    expect(order).toStrictEqual(["first", "second", "first", "third"]);
  });

  test("duplicate subscriptions and stale unsubscribe handles have independent lifetimes", async () => {
    const bus = new EventBus();
    const key = eventKey<number>("changed");
    const received: number[] = [];
    const listener = (value: number): undefined => {
      received.push(value);
    };

    const first = bus.on(key, listener);
    const second = bus.on(key, listener);

    first();
    bus.emit(key, 1);
    second();

    expect(bus.hasListeners(key)).toBe(false);

    bus.on(key, listener);
    second();
    bus.emit(key, 2);

    await bus.close();
    await bus.close();
    expect(() => bus.emit(key, 3)).toThrow(LifecycleStateError);

    expect(received).toStrictEqual([1, 2]);
    expect(bus.hasListeners(key)).toBe(false);
    expect(() => bus.on(key, listener)).toThrow(LifecycleStateError);
    expect(() => bus.onAsync(key, listener)).toThrow(LifecycleStateError);
  });

  test("listener and diagnostic failures do not starve later subscribers", () => {
    const bus = new EventBus();
    const key = eventKey<number>("changed");
    const received: number[] = [];
    const report = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("sink failed");
    });

    bus.on(key, () => {
      throw new Error("listener failed");
    });
    bus.on(key, (value) => {
      received.push(value);
    });

    try {
      bus.emit(key, 42);

      expect(received).toStrictEqual([42]);
    } finally {
      report.mockRestore();
    }
  });

  test("async failures and broken diagnostics do not reject delivery barriers or starve listeners", async () => {
    const bus = new EventBus();
    const key = eventKey<void>("changed");
    const failure = new Error("async sink failed");
    const report = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("diagnostics failed");
    });
    const received: string[] = [];
    bus.onAsync(key, async () => {
      await Promise.resolve();
      throw failure;
    });
    bus.onAsync(key, () => {
      fork(() => {
        throw new Error("child failed");
      });
    });
    bus.onAsync(key, () => {
      onDispose(() => {
        throw new Error("cleanup failed");
      });
    });
    bus.onAsync(key, () => {
      received.push("async");
    });
    bus.on(key, () => {
      received.push("sync");
    });

    try {
      bus.emit(key, undefined);
      await bus.flush();
      bus.emit(key, undefined);
      await bus.close();

      expect(received).toEqual(["async", "sync", "async", "sync"]);
      expect(report.mock.calls.map((call) => call[1])).toContain(failure);
      expect(report).toHaveBeenCalledTimes(6);
    } finally {
      report.mockRestore();
    }
  });

  test("flush joins independent listener executions without holding or inheriting the emitter lifetime", async () => {
    const bus = new EventBus();
    const key = eventKey<void>("changed");
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const scopes: unknown[] = [];
    const order: string[] = [];
    for (const name of ["first", "second"]) {
      bus.onAsync(key, async () => {
        signals.push(signal());
        scopes.push(currentScope());
        onDispose(() => {
          order.push(`disposed:${name}`);
        });
        order.push(name);
        await release.promise;
        order.push(`finished:${name}`);
      });
    }
    let emitterScope: unknown;
    let synchronousScope: unknown;
    bus.on(key, () => {
      synchronousScope = currentScope();
    });
    await execute({ signal: controller.signal, attachment: undefined }, () => {
      emitterScope = currentScope();
      onDispose(() => {
        order.push("disposed:emitter");
      });
      bus.emit(key, undefined);
      order.push("emitted");
    });
    controller.abort();
    let flushed = false;
    const flushing = bus.flush().then(() => {
      flushed = true;
    });

    try {
      await Promise.resolve();
      expect(order).toEqual(["first", "second", "emitted", "disposed:emitter"]);
      expect(flushed).toBe(false);
      expect(signals.every((value) => !value.aborted)).toBe(true);
      expect(signals[0]).not.toBe(signals[1]);
      expect(scopes[0]).not.toBe(scopes[1]);
      expect(scopes).not.toContain(emitterScope);
      expect(synchronousScope).toBe(emitterScope);
    } finally {
      release.resolve();
    }
    await flushing;
    expect(order.slice(4).sort()).toEqual([
      "disposed:first",
      "disposed:second",
      "finished:first",
      "finished:second",
    ]);
    for (const name of ["first", "second"]) {
      expect(order.indexOf(`finished:${name}`)).toBeLessThan(order.indexOf(`disposed:${name}`));
    }
    await bus.close();
  });

  test("reentrant close stops new admission but joins every listener in the admitted snapshot", async () => {
    const bus = new EventBus();
    const key = eventKey<void>("changed");
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const cancellations: boolean[] = [];
    let reentrant: Promise<void> | undefined;
    let rejectedEmission: unknown;
    bus.on(key, () => {
      order.push("first");
      offLast();
      reentrant = bus.close();
      try {
        bus.emit(key, undefined);
      } catch (error) {
        rejectedEmission = error;
      }
    });
    bus.onAsync(key, async () => {
      order.push("async");
      await release.promise;
      cancellations.push(signal().aborted);
      onDispose(() => {
        cancellations.push(signal().aborted);
      });
      order.push("finished");
    });
    const offLast = bus.on(key, () => {
      order.push("last");
    });

    bus.emit(key, undefined);
    const closing = bus.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(reentrant).toBe(closing);
      expect(rejectedEmission).toBeInstanceOf(LifecycleStateError);
      expect(rejectedEmission).toMatchObject({
        owner: "EventBus",
        operation: "emit",
        state: "closing",
      });
      expect(closed).toBe(false);
      expect(order).toEqual(["first", "async", "last"]);
      expect(bus.hasListeners(key)).toBe(false);
      expect(() => bus.onAsync(key, () => {})).toThrow(LifecycleStateError);
    } finally {
      release.resolve();
    }
    await closing;
    expect(order).toEqual(["first", "async", "last", "finished"]);
    expect(cancellations).toEqual([false, false]);
  });

  test("async subscription changes and nested emissions use separate membership snapshots", async () => {
    const bus = new EventBus();
    const key = eventKey<number>("changed");
    const order: string[] = [];
    bus.onAsync(key, (value) => {
      order.push(`first:${value}`);
      if (value === 1) {
        offSecond();
        bus.onAsync(key, (next) => {
          order.push(`third:${next}`);
        });
        bus.emit(key, 2);
      }
    });
    const offSecond = bus.onAsync(key, (value) => {
      order.push(`second:${value}`);
    });

    bus.emit(key, 1);
    await bus.close();
    expect(order).toEqual(["first:1", "first:2", "third:2", "second:1"]);
  });

  test("flush also joins later emissions and their asynchronous resource cleanup", async () => {
    const bus = new EventBus();
    const key = eventKey<number>("changed");
    const release = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const order: string[] = [];
    bus.onAsync(key, async (value) => {
      if (value === 1) {
        await release.promise;
        bus.emit(key, 2);
      } else {
        onDispose(async () => {
          cleanupStarted.resolve();
          await cleanup.promise;
          order.push("cleaned");
        });
      }
      order.push(`delivered:${value}`);
    });

    bus.emit(key, 1);
    let flushed = false;
    const flushing = bus.flush().then(() => {
      flushed = true;
    });
    release.resolve();
    await cleanupStarted.promise;
    try {
      expect(flushed).toBe(false);
      expect(order).toEqual(["delivered:2", "delivered:1"]);
    } finally {
      cleanup.resolve();
    }
    await flushing;
    expect(order).toEqual(["delivered:2", "delivered:1", "cleaned"]);
    await bus.close();
  });

  test("asynchronous deliveries share application providers but own their resources", async () => {
    await using app = new ApplicationLifecycle();
    const Registry = token<{ name: string }>("registry");
    const Local = token<{ id: number }>("delivery resource");
    const key = eventKey<void>("changed");
    const registries: unknown[] = [];
    const reused: boolean[] = [];
    const ids: number[] = [];
    const disposals: number[] = [];
    let acquired = 0;
    app.scope.provide(Registry, () => ({ name: "app" }));

    for (let index = 0; index < 2; index++) {
      app.events.onAsync(key, async () => {
        registries.push(inject(Registry));
        const local = scoped(
          Local,
          () => ({ id: ++acquired }),
          (value) => disposals.push(value.id),
        );

        await Promise.resolve();

        reused.push(scoped(Local, () => ({ id: -1 })) === local);
        ids.push(local.id);
      });
    }

    await app.start();
    app.events.emit(key, undefined);
    await app.events.flush();

    const registry = app.scope.get(Registry);
    expect(registries[0]).toBe(registry);
    expect(registries[1]).toBe(registry);
    expect(reused).toEqual([true, true]);
    expect(ids).toEqual([1, 2]);
    expect(disposals.toSorted()).toEqual([1, 2]);
  });

  test("a delivery emitted during startup does not inherit the constructing scope", async () => {
    await using app = new ApplicationLifecycle();
    const Registry = token<{ name: string }>("registry");
    const key = eventKey<void>("changed");
    const cleanups: string[] = [];
    let deliveryScope: unknown;
    let resolved: unknown;
    app.scope.provide(Registry, () => ({ name: "app" }));
    app.events.onAsync(key, () => {
      deliveryScope = currentScope();
      resolved = inject(Registry);
      onDispose(() => {
        cleanups.push("delivery");
      });
    });

    class Emitter {
      constructor() {
        onStart(async () => {
          app.events.emit(key, undefined);
          await app.events.flush();
          expect(cleanups).toEqual(["delivery"]);
        });
      }
    }
    app.scope.get(Emitter);
    await app.start();
    await app.events.flush();

    expect(deliveryScope).not.toBe(app.scope);
    expect(resolved).toBe(app.scope.get(Registry));
    expect(cleanups).toEqual(["delivery"]);
  });
  test("event barriers preserve work and cleanup failures without rejecting the publisher", async () => {
    const bus = new EventBus();
    const key = eventKey<void>("failed delivery");
    const workCause = new Error("work cause");
    const cleanupCause = new Error("cleanup cause");
    const workFailure = new AggregateError([new Error("work")], "listener failure", {
      cause: workCause,
    });
    const cleanupFailure = new Error("cleanup", { cause: cleanupCause });
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    let delivered = false;
    bus.onAsync(key, () => {
      onDispose(() => {
        throw cleanupFailure;
      });
      throw workFailure;
    });
    bus.onAsync(key, () => {
      delivered = true;
    });
    try {
      bus.emit(key, undefined);
      await bus.flush();
      await bus.close();

      expect(delivered).toBe(true);
      const failure = report.mock.calls[0]?.[1] as AggregateError;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors[0]).toBe(workFailure);
      expect(failure.errors[1]).toBe(cleanupFailure);
      expect(failure.errors[0].cause).toBe(workCause);
      expect(failure.errors[1].cause).toBe(cleanupCause);
    } finally {
      report.mockRestore();
    }
  });

  test("invalid reporters are rejected before acquiring a delivery scope", async () => {
    const scope = new Scope();
    await scope[Symbol.asyncDispose]();
    expect(() => new EventBus(scope, { onError: 42 } as unknown as EventBusOptions)).toThrow(
      TypeError,
    );
  });

  test("an empty bus rejects emission and subscription throughout shutdown", async () => {
    const bus = new EventBus();
    const key = eventKey<void>("never subscribed");
    const closing = bus.close();
    expect(() => bus.emit(key, undefined)).toThrow(LifecycleStateError);
    expect(() => bus.on(key, () => {})).toThrow(LifecycleStateError);
    await closing;
    let failure: unknown;
    try {
      bus.emit(key, undefined);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LifecycleStateError);
    expect(failure).toMatchObject({ owner: "EventBus", operation: "emit", state: "closed" });
  });

  test("custom diagnostics preserve sync and async errors with their event descriptions", async () => {
    const reports: { error: unknown; context: EventErrorContext }[] = [];
    const bus = new EventBus(undefined, {
      onError(error, context) {
        reports.push({ error, context });
      },
    });
    const sync = eventKey<void>("sync failure");
    const async = eventKey<void>("async failure");
    const cause = new Error("original cause");
    const syncFailure = new Error("sync", { cause });
    const asyncFailure = new AggregateError([cause], "async", { cause });
    bus.on(sync, () => {
      throw syncFailure;
    });
    bus.onAsync(async, async () => {
      await Promise.resolve();
      throw asyncFailure;
    });
    bus.emit(sync, undefined);
    bus.emit(async, undefined);
    await bus.close();
    expect(reports).toEqual([
      { error: syncFailure, context: { event: sync.description } },
      { error: asyncFailure, context: { event: async.description } },
    ]);
    expect(reports[0]?.error).toBe(syncFailure);
    expect(reports[1]?.error).toBe(asyncFailure);
    expect(syncFailure.cause).toBe(cause);
    expect(asyncFailure.cause).toBe(cause);
  });

  test("throwing custom diagnostics safely report both failures without starving delivery", async () => {
    const reporterFailure = new Error("reporter failed");
    const syncFailure = new Error("sync listener failed");
    const asyncFailure = new Error("async listener failed");
    const reports: unknown[] = [];
    const received: string[] = [];
    const bus = new EventBus(undefined, {
      onError(error) {
        reports.push(error);
        throw reporterFailure;
      },
    });
    const key = eventKey<void>("changed");
    bus.on(key, () => {
      throw syncFailure;
    });
    bus.onAsync(key, async () => {
      await Promise.resolve();
      throw asyncFailure;
    });
    bus.on(key, () => {
      received.push("sync");
    });
    bus.onAsync(key, () => {
      received.push("async");
    });
    const fallback = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("fallback failed too");
    });
    try {
      bus.emit(key, undefined);
      await bus.close();
      expect(reports).toEqual([syncFailure, asyncFailure]);
      expect(received).toEqual(["sync", "async"]);
      expect(fallback.mock.calls.map((call) => call[1])).toEqual([
        syncFailure,
        reporterFailure,
        asyncFailure,
        reporterFailure,
      ]);
    } finally {
      fallback.mockRestore();
    }
  });

  test("diagnostics cannot borrow publisher execution or construction resources", async () => {
    const failures: unknown[] = [];
    const bus = new EventBus(undefined, {
      onError() {
        try {
          onDispose(() => {});
        } catch (error) {
          failures.push(error);
        }
      },
    });
    const key = eventKey<void>("failed");
    bus.on(key, () => {
      throw new Error("listener failed");
    });
    await using scope = new Scope();
    class Emitter {
      constructor() {
        bus.emit(key, undefined);
      }
    }
    await execute({ scope }, () => {
      scope.get(Emitter);
      bus.emit(key, undefined);
    });
    await bus.close();
    expect(failures).toHaveLength(2);
    expect(failures.every((error) => error instanceof Error)).toBe(true);
  });

  test("diagnostic work is independent of listener dependencies and not joined by the bus", async () => {
    const release = Promise.withResolvers<void>();
    const dependencyFailures: unknown[] = [];
    let diagnostic: Promise<void> | undefined;
    let finished = false;
    const bus = new EventBus(undefined, {
      onError() {
        try {
          bus.assertCanJoin("flush");
        } catch (error) {
          dependencyFailures.push(error);
        }
        diagnostic = execute({}, async () => {
          await release.promise;
          finished = true;
        });
      },
    });
    const outer = eventKey<void>("async delivery");
    const inner = eventKey<void>("sync failure");
    bus.on(inner, () => {
      throw new Error("listener failed");
    });
    bus.onAsync(outer, () => {
      bus.emit(inner, undefined);
    });
    try {
      bus.emit(outer, undefined);
      await bus.close();
      expect(dependencyFailures).toEqual([]);
      expect(diagnostic).toBeDefined();
      expect(finished).toBe(false);
    } finally {
      release.resolve();
      await diagnostic;
    }
    expect(finished).toBe(true);
  });

  test.each(["flush", "close"] as const)(
    "a listener cannot join its own %s barrier and rejected closure leaves admission open",
    async (operation) => {
      const bus = new EventBus();
      const key = eventKey<void>("changed");
      const failures: unknown[] = [];
      let received = 0;
      const off = bus.onAsync(key, async () => {
        await Promise.resolve();
        try {
          await bus[operation]();
        } catch (error) {
          failures.push(error);
        }
        received++;
      });
      bus.emit(key, undefined);
      await bus.flush();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toBeInstanceOf(LifecycleDependencyError);
      expect(failures[0]).toMatchObject({ owner: "EventBus", operation });
      off();
      bus.on(key, () => {
        received++;
      });
      bus.emit(key, undefined);
      await bus.close();
      expect(received).toBe(2);
    },
  );

  test("a listener cannot join an already-closing bus", async () => {
    const bus = new EventBus();
    const key = eventKey<void>("changed");
    const release = Promise.withResolvers<void>();
    let failure: unknown;
    bus.onAsync(key, async () => {
      await release.promise;
      try {
        await bus.close();
      } catch (error) {
        failure = error;
      }
    });
    bus.emit(key, undefined);
    const closing = bus.close();
    release.resolve();
    await closing;
    expect(failure).toBeInstanceOf(LifecycleDependencyError);
    expect(failure).toMatchObject({ owner: "EventBus", operation: "close" });
    expect(bus.close()).toBe(closing);
  });
});
