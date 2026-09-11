import { expect, test } from "vitest";
import {
  Cancelable,
  call,
  contextKey,
  defer,
  execute,
  provide,
  signal,
  use,
  type CallContext,
} from "../src/index.js";

class CancelProbe extends Cancelable {
  readonly reasons: unknown[] = [];

  cancel(reason: unknown): void | PromiseLike<void> {
    this.reasons.push(reason);
  }
}

test("construction does not bind an instance, and explicit registration works outside Runner", async () => {
  const creator = new AbortController();
  const owner = new AbortController();
  const operation = await execute({ signal: creator.signal }, () => new CancelProbe());
  creator.abort("constructor execution ended");
  expect(operation.reasons).toEqual([]);
  expect(() => operation.cancelable()).toThrow();
  await using _registration = operation.cancelable(owner.signal);
  owner.abort("registered owner");
  expect(operation.reasons).toEqual(["registered owner"]);
});

test("implicit cancellation uses the registration context rather than the aborting execution", async () => {
  const Tenant = contextKey<string>("tenant");
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reason = new Error("owner cancelled");
  const seen: unknown[] = [];
  class Operation extends Cancelable {
    cancel(value: unknown): void {
      seen.push(value, use(Tenant), signal());
    }
  }
  const operation = new Operation();
  const result = execute(
    { signal: controller.signal, values: [provide(Tenant, "owner")] },
    async () => {
      await using _registration = operation.cancelable();
      entered.resolve();
      await release.promise;
    },
  ).catch((error: unknown) => error);
  await entered.promise;
  try {
    await execute({ values: [provide(Tenant, "abort caller")] }, () => {
      controller.abort(reason);
    });
  } finally {
    release.resolve();
  }
  expect(await result).toBe(reason);
  expect(seen).toEqual([reason, "owner", controller.signal]);
});

test("lazy class cancellation and its continuation use the registration context", async () => {
  const Tenant = contextKey<string>("tenant");
  const controller = new AbortController();
  const seen: (string | undefined)[] = [];
  class Operation extends Cancelable {
    cancel(): PromiseLike<void> {
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- Deliberately exercise the PromiseLike cancellation contract, as Task does.
        then(resolve, reject) {
          seen.push(use(Tenant));
          return Promise.resolve()
            .then(() => {
              seen.push(use(Tenant));
            })
            .then(resolve, reject);
        },
      };
    }
  }
  await execute({ values: [provide(Tenant, "owner")] }, async () => {
    await using _registration = new Operation().cancelable(controller.signal);
    await execute({ values: [provide(Tenant, "abort caller")] }, () => controller.abort());
  });
  expect(seen).toEqual(["owner", "owner"]);
});

test("functional cancellation assimilates nested thenables in the registration context", async () => {
  const Tenant = contextKey<string>("tenant");
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const native = Promise.withResolvers<void>();
  const reason = new Error("stop native operation");
  const seen: (string | undefined)[] = [];
  const result = execute({ signal: controller.signal, values: [provide(Tenant, "owner")] }, () =>
    call(({ onCancel }) => {
      onCancel(() => ({
        // oxlint-disable-next-line unicorn/no-thenable -- Cancellation must assimilate this lazy PromiseLike in its owner's context.
        then(resolve, reject) {
          seen.push(use(Tenant));
          const inner: PromiseLike<void> = {
            // oxlint-disable-next-line unicorn/no-thenable -- Nested assimilation must retain the same execution context.
            then(innerResolve, innerReject) {
              seen.push(use(Tenant));
              native.resolve();
              return Promise.resolve().then(innerResolve, innerReject);
            },
          };
          return Promise.resolve(inner).then(resolve, reject);
        },
      }));
      entered.resolve();
      return native.promise;
    }),
  ).catch((error: unknown) => error);
  await entered.promise;
  try {
    await execute({ values: [provide(Tenant, "abort caller")] }, () => controller.abort(reason));
  } finally {
    native.resolve();
  }
  expect(await result).toBe(reason);
  expect(seen).toEqual(["owner", "owner"]);
});

test("normal unbinding preserves inner defer and derived disposal without requesting cancellation", async () => {
  const controller = new AbortController();
  const order: string[] = [];
  class Operation extends CancelProbe implements AsyncDisposable {
    async query(): Promise<number> {
      await using _cleanup = defer(() => {
        order.push("inner cleanup");
      });
      return 42;
    }

    async [Symbol.asyncDispose](): Promise<void> {
      order.push("operation disposed");
    }
  }
  const operation = new Operation();
  {
    await using _resource = operation;
    {
      await using _registration = operation.cancelable(controller.signal);
      expect(await operation.query()).toBe(42);
    }
    controller.abort("after unbinding");
    order.push("unbound");
  }
  expect(operation.reasons).toEqual([]);
  expect(order).toEqual(["inner cleanup", "unbound", "operation disposed"]);
});

test("already aborted registration invokes the fully constructed instance exactly once", async () => {
  const reason = new Error("already aborted");
  const handle = {};
  const seen: unknown[] = [];
  class Operation extends Cancelable {
    readonly handle = handle;

    cancel(value: unknown): void {
      seen.push(this.handle, value);
    }
  }
  const operation = new Operation();
  const registration = operation.cancelable(AbortSignal.abort(reason));
  expect(seen).toEqual([handle, reason]);
  await registration[Symbol.asyncDispose]();
  await registration[Symbol.asyncDispose]();
  expect(seen).toEqual([handle, reason]);
});

test("a registration stays exclusive until cancellation finishes and stale disposal cannot unbind a successor", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const release = Promise.withResolvers<void>();
  class Operation extends CancelProbe {
    override async cancel(reason: unknown): Promise<void> {
      this.reasons.push(reason);
      await release.promise;
    }
  }
  const operation = new Operation();
  const registration = operation.cancelable(first.signal);
  expect(() => operation.cancelable(second.signal)).toThrow();
  first.abort("first");
  const closing = registration[Symbol.asyncDispose]();
  expect(registration[Symbol.asyncDispose]()).toBe(closing);
  try {
    expect(() => operation.cancelable(second.signal)).toThrow();
  } finally {
    release.resolve();
  }
  await closing;
  await using _successor = operation.cancelable(second.signal);
  await registration[Symbol.asyncDispose]();
  second.abort("second");
  expect(operation.reasons).toEqual(["first", "second"]);
});

test("disposal initiated inside cancel still waits for the returned asynchronous action", async () => {
  const controller = new AbortController();
  const release = Promise.withResolvers<void>();
  let registration!: AsyncDisposable;
  let closing: PromiseLike<void> | undefined;
  let closed = false;
  class Operation extends Cancelable {
    cancel(): Promise<void> {
      closing = registration[Symbol.asyncDispose]();
      void closing.then(() => {
        closed = true;
      });
      return release.promise;
    }
  }
  registration = new Operation().cancelable(controller.signal);
  controller.abort();
  try {
    await Promise.resolve();
    expect(closed).toBe(false);
  } finally {
    release.resolve();
  }
  await closing;
  expect(closed).toBe(true);
});

test("work and asynchronous cancel failures keep native identities through await using", async () => {
  const controller = new AbortController();
  const workFailure = new Error("work");
  const cause = new Error("cancel cause");
  const cancelFailure = new Error("cancel", { cause });
  class Operation extends Cancelable {
    cancel(): Promise<void> {
      return Promise.reject(cancelFailure);
    }
  }
  const operation = new Operation();
  const failure = await execute({ signal: controller.signal }, async () => {
    await using _registration = operation.cancelable();
    controller.abort("stop");
    await Promise.resolve();
    throw workFailure;
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SuppressedError);
  expect((failure as SuppressedError).error).toBe(cancelFailure);
  expect((failure as SuppressedError).suppressed).toBe(workFailure);
  expect((failure as SuppressedError).error.cause).toBe(cause);
  await using _next = operation.cancelable(new AbortController().signal);
});

test("a synchronous undefined cancellation failure is reported by disposal, not abort dispatch", async () => {
  const controller = new AbortController();
  class Operation extends Cancelable {
    cancel(): never {
      throw undefined;
    }
  }
  const registration = new Operation().cancelable(controller.signal);
  controller.abort();
  await expect(registration[Symbol.asyncDispose]()).rejects.toBeUndefined();
});

test("another listener cannot suppress a registered cancellation action", async () => {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", (event) => event.stopImmediatePropagation());
  const operation = new CancelProbe();
  await using _registration = operation.cancelable(controller.signal);
  controller.abort("stop");
  expect(operation.reasons).toEqual(["stop"]);
});

test("call refuses to start new work once its execution is cancelled", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel before call");
  let ran = false;
  await expect(
    execute({ signal: controller.signal }, async () => {
      controller.abort(reason);
      await call(() => {
        ran = true;
      });
    }),
  ).rejects.toBe(reason);
  expect(ran).toBe(false);
});

test("call delivers cancellation registered after abort during native setup", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel during setup");
  const native = Promise.withResolvers<number>();
  const seen: unknown[] = [];
  await expect(
    execute({ signal: controller.signal }, () =>
      call(({ onCancel }) => {
        controller.abort(reason);
        onCancel((value) => {
          seen.push(value);
          native.resolve(42);
        });
        return native.promise;
      }),
    ),
  ).rejects.toBe(reason);
  expect(seen).toEqual([reason]);
});

test("completed and failed calls disconnect before a later call is cancelled", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel current call");
  const failure = new Error("earlier work failure");
  const cancelled: string[] = [];
  await expect(
    execute({ signal: controller.signal }, async () => {
      expect(
        await call(({ onCancel }) => {
          onCancel(() => {
            cancelled.push("completed");
          });
          return 42;
        }),
      ).toBe(42);
      await expect(
        call(({ onCancel }) => {
          onCancel(() => {
            cancelled.push("failed");
          });
          throw failure;
        }),
      ).rejects.toBe(failure);
      await call(({ onCancel }) => {
        onCancel(() => {
          cancelled.push("current");
        });
        controller.abort(reason);
      });
    }),
  ).rejects.toBe(reason);
  expect(cancelled).toEqual(["current"]);
});

test("call starts every cancellation action and still waits for native work and cancellation cleanup", async () => {
  const controller = new AbortController();
  const native = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const secondAction = Promise.withResolvers<void>();
  const reason = new Error("cancel request");
  const firstFailure = new Error("async cancellation failure");
  const secondFailure = new Error("sync cancellation failure");
  let settled = false;
  const result = execute({ signal: controller.signal }, () =>
    call(({ onCancel }) => {
      onCancel(async () => {
        await secondAction.promise;
        throw firstFailure;
      });
      onCancel(() => {
        secondAction.resolve();
        throw secondFailure;
      });
      entered.resolve();
      return native.promise;
    }),
  ).catch((error: unknown) => error);
  void result.then(() => {
    settled = true;
  });
  await entered.promise;
  controller.abort(reason);
  try {
    await secondAction.promise;
    expect(settled).toBe(false);
  } finally {
    native.resolve();
  }
  const failure = (await result) as SuppressedError;
  expect(failure).toBeInstanceOf(SuppressedError);
  expect(failure.suppressed).toBe(reason);
  expect(failure.error).toBeInstanceOf(AggregateError);
  expect(failure.error.errors).toHaveLength(2);
  expect(failure.error.errors).toContain(firstFailure);
  expect(failure.error.errors).toContain(secondFailure);
});

test("a retained call registration function cannot acquire new cancellation actions after return", async () => {
  let onCancel!: CallContext["onCancel"];
  await execute(async () => {
    expect(
      await call((context) => {
        onCancel = context.onCancel;
        return "finished";
      }),
    ).toBe("finished");
    expect(() => onCancel(() => {})).toThrow();
  });
});
