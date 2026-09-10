import { expect, test } from "vitest";
import {
  AppClosed,
  AppClosing,
  AppStarted,
  ApplicationLifecycle,
  EventBus,
  eventKey,
  inject,
  onDispose,
  onStart,
} from "../src/index.js";

test("startup is shared, dependency ordered, and services observe the application bus", async () => {
  const app = new ApplicationLifecycle();
  const order: string[] = [];
  const release = Promise.withResolvers<void>();

  class Dependency {
    constructor() {
      onStart(async () => {
        await release.promise;
        order.push("dependency");
      });
      onDispose(() => {
        order.push("dispose:dependency");
      });
    }
  }
  class Service {
    dependency = inject(Dependency);
    constructor() {
      inject(EventBus).on(AppStarted, () => {
        order.push("started");
      });

      onStart(() => {
        order.push("service");
      });
      onDispose(() => {
        order.push("dispose:service");
      });
    }
  }

  app.scope.get(Service);

  const starting = app.start();

  try {
    expect(app.start()).toBe(starting);
    expect(app.started).toBe(false);
  } finally {
    release.resolve();
  }

  await starting;
  await app.start();

  expect(app.started).toBe(true);
  expect(order).toEqual(["dependency", "service", "started"]);

  await app.close();

  expect(order).toEqual([
    "dependency",
    "service",
    "started",
    "dispose:service",
    "dispose:dependency",
  ]);
});

test("close invokes all drainers while startup is pending and waits before releasing resources", async () => {
  const app = new ApplicationLifecycle();
  const startup = Promise.withResolvers<void>();
  const draining = Promise.withResolvers<void>();
  const order: string[] = [];
  let closingAtNotification: Promise<void> | undefined;
  let reentrantClosing: Promise<void> | undefined;

  app.scope.addStartup(async () => {
    await startup.promise;
    order.push("initialized");
  });
  app.scope.defer(() => {
    order.push("disposed");
  });
  app.events.on(AppStarted, () => {
    order.push("started");
  });
  app.events.on(AppClosing, () => {
    closingAtNotification = app.closing;
    reentrantClosing = app.close();
    order.push("closing");
  });
  app.events.on(AppClosed, () => {
    order.push("closed");
  });

  app.onDrain(async () => {
    order.push("drain:first");
    await draining.promise;
  });
  app.onDrain(() => {
    order.push("drain:second");
    startup.resolve();
  });

  const starting = app.start();
  const closing = app.close();

  try {
    expect(closingAtNotification).toBe(closing);
    expect(reentrantClosing).toBe(closing);
    expect(app.close()).toBe(closing);
    expect(order).toEqual(["closing", "drain:first", "drain:second"]);
    await expect(app.start()).rejects.toThrow();
    expect(() => app.onDrain(() => {})).toThrow();

    await starting;

    expect(order).toEqual(["closing", "drain:first", "drain:second", "initialized"]);
  } finally {
    draining.resolve();
  }

  await closing;

  expect(app.started).toBe(false);
  expect(order).toEqual([
    "closing",
    "drain:first",
    "drain:second",
    "initialized",
    "disposed",
    "closed",
  ]);
  expect(() => app.events.on(AppClosed, () => {})).toThrow();
});

test("startup rejection survives shutdown once by identity, including undefined", async () => {
  const app = new ApplicationLifecycle();
  app.scope.addStartup(() => {
    throw undefined;
  });

  let disposed = false;
  let notification: { error?: unknown } | undefined;
  app.scope.defer(() => {
    disposed = true;
  });
  app.events.on(AppClosed, (event) => {
    notification = event;
  });

  await expect(app.start()).rejects.toBeUndefined();
  const closing = app.close();

  await expect(closing).rejects.toBeUndefined();
  await expect(app.close()).rejects.toBeUndefined();

  expect(disposed).toBe(true);
  expect(notification).toEqual({ error: undefined });
  expect(Object.hasOwn(notification!, "error")).toBe(true);
});

test("a NaN startup rejection remains the same single shutdown failure", async () => {
  const app = new ApplicationLifecycle();
  const failure = NaN;
  let disposed = false;
  let notified: unknown;

  app.scope.addStartup(() => {
    throw failure;
  });
  app.scope.defer(() => {
    disposed = true;
  });
  app.events.on(AppClosed, ({ error }) => {
    notified = error;
  });

  await expect(app.start()).rejects.toBe(failure);
  const closing = app.close();

  await expect(closing).rejects.toBe(failure);

  expect(notified).toBe(failure);
  expect(disposed).toBe(true);
});

test("one failing drainer cannot skip other drainers, startup failure, or resource teardown", async () => {
  const app = new ApplicationLifecycle();
  const startupError = new Error("startup");
  const drainError = new Error("drain");
  const cleanupError = new Error("cleanup");
  const order: string[] = [];
  let notified: unknown;

  app.scope.addStartup(() => {
    throw startupError;
  });
  app.scope.defer(() => {
    order.push("cleanup");
    throw cleanupError;
  });
  app.onDrain(() => {
    throw drainError;
  });
  app.onDrain(() => {
    order.push("other drain");
  });
  app.events.on(AppClosed, ({ error }) => {
    notified = error;
  });

  await expect(app.start()).rejects.toBe(startupError);
  const [outcome] = await Promise.allSettled([app.close()]);

  expect(outcome.status).toBe("rejected");
  const failure = (outcome as PromiseRejectedResult).reason as unknown;
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = (failure as AggregateError).errors as unknown[];
  expect(errors[0]).toBe(drainError);
  expect(errors).toHaveLength(2);
  expect(errors[1]).toBeInstanceOf(AggregateError);
  expect((errors[1] as AggregateError).errors[0]).toBe(startupError);
  expect((errors[1] as AggregateError).errors[1]).toBe(cleanupError);
  expect(notified).toBe(failure);
  await expect(app.close()).rejects.toBe(failure);
  expect(order).toEqual(["other drain", "cleanup"]);
});

test("a sole drain failure is preserved and unregistered hooks do not run", async () => {
  const app = new ApplicationLifecycle();
  const error = new Error("drain");
  let calls = 0;
  const callback = () => {
    calls++;
  };
  const off = app.onDrain(callback);
  app.onDrain(callback);
  off();
  app.onDrain(() => {
    throw error;
  });

  await expect(app.close()).rejects.toBe(error);

  expect(calls).toBe(1);
});

test("producer notifications finish before singleton disposal and AppClosed deliveries are joined afterward", async () => {
  const app = new ApplicationLifecycle();
  const completed = eventKey<void>("producer.completed");
  const producer = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const deliveryStarted = Promise.withResolvers<void>();
  const closedDelivery = Promise.withResolvers<void>();
  const closedStarted = Promise.withResolvers<void>();
  const order: string[] = [];

  class Sink {
    constructor() {
      // Resolving the bus through DI must not auto-adopt it as a root resource.
      inject(EventBus).onAsync(completed, async () => {
        order.push("delivery");
        deliveryStarted.resolve();
        await delivered.promise;
        order.push("delivered");
      });
      onDispose(() => {
        order.push("disposed");
      });
    }
  }
  app.scope.get(Sink);
  app.onDrain(async () => {
    await producer.promise;
    order.push("producer");
    app.events.emit(completed, undefined);
  });
  app.events.onAsync(AppClosed, async () => {
    order.push("closed");
    closedStarted.resolve();
    await closedDelivery.promise;
    order.push("closed:delivered");
  });

  let settled = false;
  const closing = app.close();
  void closing.then(() => {
    settled = true;
  });
  producer.resolve();
  await deliveryStarted.promise;
  expect(order).toEqual(["producer", "delivery"]);
  expect(settled).toBe(false);
  delivered.resolve();
  await closedStarted.promise;
  expect(order).toEqual(["producer", "delivery", "delivered", "disposed", "closed"]);
  expect(settled).toBe(false);
  closedDelivery.resolve();
  await closing;
  expect(order).toEqual([
    "producer",
    "delivery",
    "delivered",
    "disposed",
    "closed",
    "closed:delivered",
  ]);
});

test("an async started observer can initiate shutdown without racing startup or its own disposal", async () => {
  const app = new ApplicationLifecycle();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  let reentrant: Promise<void> | undefined;
  app.scope.defer(() => {
    order.push("disposed");
  });
  app.events.onAsync(AppStarted, async () => {
    order.push("started");
    reentrant = app.close();
    await release.promise;
    order.push("observer:finished");
  });
  app.events.on(AppClosing, () => {
    order.push("closing");
  });

  await app.start();
  const closing = app.close();
  try {
    expect(reentrant).toBe(closing);
    expect(order).toEqual(["started", "closing"]);
  } finally {
    release.resolve();
  }
  await closing;
  expect(order).toEqual(["started", "closing", "observer:finished", "disposed"]);
});
