import { describe, expect, test, vi } from "vitest";
import {
  EventBus,
  currentScope,
  eventKey,
  execute,
  fork,
  onDispose,
  signal,
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
    bus.emit(key, 3);

    expect(received).toStrictEqual([1, 2]);
    expect(bus.hasListeners(key)).toBe(false);
    expect(() => bus.on(key, listener)).toThrow();
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
    let reentrant: Promise<void> | undefined;
    bus.on(key, () => {
      order.push("first");
      offLast();
      reentrant = bus.close();
      bus.emit(key, undefined);
    });
    bus.onAsync(key, async () => {
      order.push("async");
      await release.promise;
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
      expect(closed).toBe(false);
      expect(order).toEqual(["first", "async", "last"]);
      expect(bus.hasListeners(key)).toBe(false);
      expect(() => bus.onAsync(key, () => {})).toThrow();
    } finally {
      release.resolve();
    }
    await closing;
    expect(order).toEqual(["first", "async", "last", "finished"]);
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
});
