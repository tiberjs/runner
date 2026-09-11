import { expect, expectTypeOf, test } from "vitest";
import {
  begin,
  COMPLETED,
  currentScope,
  execute,
  fork,
  onDispose,
  runWith,
  Scope,
  signal,
  token,
  type ExecutionSeed,
} from "../src/index.js";

test("parentScope inherits providers, joins descendants, and disposes only the execution child", async () => {
  const parent = new Scope();
  const Shared = token<object>("shared");
  const shared = {};
  const order: string[] = [];
  parent.provide(Shared, () => shared);
  parent.defer(() => {
    order.push("parent disposed");
  });

  try {
    await execute({ parentScope: parent }, () => {
      expect(currentScope()).not.toBe(parent);
      expect(currentScope().get(Shared)).toBe(shared);
      onDispose(() => {
        order.push("child disposed");
      });
      fork(async () => {
        const current = signal();
        await new Promise<void>((resolve) => {
          current.addEventListener("abort", () => resolve(), { once: true });
        });
        await Promise.resolve();
        expect(currentScope().get(Shared)).toBe(shared);
        order.push("descendant finished");
      });
    });

    expect(order).toEqual(["descendant finished", "child disposed"]);
    expect(parent.get(Shared)).toBe(shared);
  } finally {
    await parent[Symbol.asyncDispose]();
  }
  expect(order).toEqual(["descendant finished", "child disposed", "parent disposed"]);
});

test("child ownership preserves handler and native disposal failures together", async () => {
  const parent = new Scope();
  const handlerFailure = new Error("handler", { cause: new Error("handler cause") });
  const cleanupFailure = new Error("cleanup", { cause: new Error("cleanup cause") });

  try {
    const failure = await execute({ parentScope: parent }, () => {
      onDispose(() => {
        throw cleanupFailure;
      });
      throw handlerFailure;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors[0]).toBe(handlerFailure);
    expect((failure as AggregateError).errors[1]).toBe(cleanupFailure);
    const StillOpen = token<number>("still open");
    parent.provide(StillOpen, () => 42);
    expect(parent.get(StillOpen)).toBe(42);
  } finally {
    await parent[Symbol.asyncDispose]();
  }
});

test("an explicitly borrowed scope keeps its resources until its caller disposes it", async () => {
  const borrowed = new Scope();
  const order: string[] = [];
  try {
    await execute({ scope: borrowed }, () => {
      expect(currentScope()).toBe(borrowed);
      onDispose(() => {
        order.push("disposed");
      });
    });
    expect(order).toEqual([]);
  } finally {
    await borrowed[Symbol.asyncDispose]();
  }
  expect(order).toEqual(["disposed"]);
});

test.each([true, false])(
  "scope accessors cannot change disposal ownership (borrowed: %s)",
  async (borrowedFirst) => {
    const borrowed = new Scope();
    const order: string[] = [];
    let nextScope: Scope | undefined = borrowedFirst ? borrowed : undefined;
    const seed: ExecutionSeed = {
      get scope() {
        const scope = nextScope;
        nextScope = scope === undefined ? borrowed : undefined;
        return scope;
      },
    };

    try {
      await execute(seed, () => {
        onDispose(() => {
          order.push("disposed");
        });
      });
      expect(order).toEqual(borrowedFirst ? [] : ["disposed"]);
    } finally {
      await borrowed[Symbol.asyncDispose]();
    }
    expect(order).toEqual(["disposed"]);
  },
);

test("conflicting scope seeds fail before unrelated getters, values, or handler execution", async () => {
  const scope = new Scope();
  const parentScope = new Scope();
  const touched: string[] = [];
  const conflicting = {
    scope,
    parentScope,
    get values() {
      touched.push("values");
      throw new Error("values must not be read");
    },
    get attachment() {
      touched.push("attachment");
      throw new Error("attachment must not be read");
    },
  };
  expectTypeOf(conflicting).not.toExtend<ExecutionSeed>();
  const seed = conflicting as unknown as ExecutionSeed;
  try {
    expect(() => begin(seed)).toThrow(TypeError);
    await expect(
      execute(seed, () => {
        touched.push("handler");
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(touched).toEqual([]);
  } finally {
    await scope[Symbol.asyncDispose]();
    await parentScope[Symbol.asyncDispose]();
  }
});

test("begin leaves child scope cleanup to the manual execution owner", async () => {
  const parent = new Scope();
  const state = begin({ parentScope: parent });
  const order: string[] = [];
  parent.defer(() => {
    order.push("parent disposed");
  });
  try {
    runWith(state, () => {
      expect(currentScope()).not.toBe(parent);
      onDispose(() => {
        order.push("child disposed");
      });
    });
    await state.tasks.close(COMPLETED);
    expect(order).toEqual([]);
    await state.scope[Symbol.asyncDispose]();
    expect(order).toEqual(["child disposed"]);
  } finally {
    await state.scope[Symbol.asyncDispose]();
    await parent[Symbol.asyncDispose]();
  }
  expect(order).toEqual(["child disposed", "parent disposed"]);
});
