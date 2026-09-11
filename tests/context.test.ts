import { expect, test } from "vitest";
import {
  ContextFrame,
  contextKey,
  currentAttachment,
  currentState,
  execute,
  fork,
  Job,
  provide,
  use,
  withContext,
} from "../src/index.js";

test("frame bindings use key identity, last-entry precedence, and immutable shadowing", async () => {
  const Tenant = contextKey<string>("tenant");
  const Trace = contextKey<string>("trace");
  const OtherTenant = contextKey<string>("tenant");
  const root = ContextFrame.from([provide(Tenant, "first"), provide(Tenant, "parent")]);
  const child = root.withEntries([provide(Tenant, "child"), provide(Trace, "trace-1")]);

  expect(root.get(Tenant.id)).toBe("parent");
  expect(root.has(Trace.id)).toBe(false);
  expect(child.get(Tenant.id)).toBe("child");
  expect(child.get(Trace.id)).toBe("trace-1");
  expect(child.has(OtherTenant.id)).toBe(false);
  const keys = [...child.keys()];
  expect(keys).toHaveLength(2);
  expect(keys).toEqual(expect.arrayContaining([Tenant.id, Trace.id]));

  await execute({ values: child }, () => {
    expect(use(Tenant)).toBe("child");
    expect(use(Trace)).toBe("trace-1");
  });
});

test("frames capture binding entries without cloning or freezing bound objects", () => {
  const Value = contextKey<{ count: number }>("value");
  const Extra = contextKey<{ count: number }>("extra");
  const value = { count: 1 };
  const replacement = { count: 2 };
  const rootEntries: [typeof Value, typeof value][] = [[Value, value]];
  const root = ContextFrame.from(rootEntries);
  const childEntries: [typeof Value, typeof value][] = [[Value, replacement]];
  const child = root.withEntries(childEntries);

  rootEntries[0]![1] = replacement;
  rootEntries.push([Extra, replacement]);
  childEntries[0]![1] = value;
  childEntries.push([Extra, value]);
  value.count = 3;

  expect(root.get(Value.id)).toBe(value);
  expect((root.get(Value.id) as typeof value).count).toBe(3);
  expect(child.get(Value.id)).toBe(replacement);
  expect(root.has(Extra.id)).toBe(false);
  expect(child.has(Extra.id)).toBe(false);
});

test("record derivation snapshots own properties and excludes inherited bindings", () => {
  const symbol = Symbol("binding");
  const bindings = {
    __proto__: { inherited: "not a binding" },
    name: "captured",
    [symbol]: "symbol value",
  };
  Object.defineProperty(bindings, "hidden", { value: "non-enumerable", configurable: true });
  const root = ContextFrame.empty.with({ name: "parent" });
  const child = root.with(bindings);

  bindings.name = "changed";
  bindings[symbol] = "changed";
  Object.defineProperty(bindings, "hidden", { value: "changed" });

  expect(child.get("name")).toBe("captured");
  expect(child.get(symbol)).toBe("symbol value");
  expect(child.get("hidden")).toBe("non-enumerable");
  expect(child.has("inherited")).toBe(false);
  expect(root.get("name")).toBe("parent");
});

test("throwing record getters leave the parent frame unchanged", () => {
  const failure = new Error("getter failed");
  const root = ContextFrame.empty.with({ value: "parent" });
  const bindings = {
    value: "partial child",
    get broken(): string {
      throw failure;
    },
  };

  let thrown: unknown;
  try {
    root.with(bindings);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(failure);
  expect(root.get("value")).toBe("parent");
  expect(root.has("broken")).toBe(false);
  expect(root.with({ value: "later child" }).get("value")).toBe("later child");
});

test("failed binding capture does not enter a handler or replace the active context", async () => {
  const Tenant = contextKey<string>("tenant");
  const failure = new Error("key lookup failed");
  const broken = {
    description: "broken",
    get id(): symbol {
      throw failure;
    },
  };
  let entered = false;

  await execute({ values: [provide(Tenant, "parent")] }, () => {
    let thrown: unknown;
    try {
      withContext([provide(Tenant, "partial child"), provide(broken, "unused")], () => {
        entered = true;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(entered).toBe(false);
    expect(use(Tenant)).toBe("parent");
    expect(withContext([provide(Tenant, "later child")], () => use(Tenant))).toBe("later child");
    expect(use(Tenant)).toBe("parent");
  });
});

test("cold declarations capture activation context and seed bindings overlay inherited values", async () => {
  const Tenant = contextKey<string>("tenant");
  const Trace = contextKey<string>("trace");
  let declaration!: Job<readonly [string | undefined, string | undefined, unknown]>;
  await execute({ values: [provide(Tenant, "declaration")], attachment: "old" }, () => {
    declaration = new Job(
      async () => {
        await Promise.resolve();
        return [use(Tenant), use(Trace), currentAttachment()] as const;
      },
      { values: [provide(Trace, "seed")] },
    );
  });
  await execute({ values: [provide(Tenant, "activation")], attachment: "new" }, async () => {
    expect(await declaration.start()).toEqual(["activation", "seed", "new"]);
  });
});

test("parallel context derivations keep the same owner and fork each branch's bindings", async () => {
  const Tenant = contextKey<string>("tenant");
  await execute({ values: [provide(Tenant, "root")] }, async () => {
    const owner = currentState().job;
    const branch = (value: string) =>
      withContext([provide(Tenant, value)], async () => {
        await Promise.resolve();
        expect(currentState().job).toBe(owner);
        return await fork(async () => {
          await Promise.resolve();
          return use(Tenant);
        });
      });
    expect(await Promise.all([branch("first"), branch("second")])).toEqual(["first", "second"]);
    expect(use(Tenant)).toBe("root");
  });
});

test("lexical execution inherits its call chain while explicit ownership ignores submitter bindings", async () => {
  const Tenant = contextKey<string>("tenant");
  const Trace = contextKey<string>("trace");
  const release = Promise.withResolvers<void>();
  const owner = new Job(() => release.promise, {
    values: [provide(Tenant, "owner"), provide(Trace, "owner trace")],
    attachment: "owner attachment",
  }).start();
  try {
    await execute(
      { values: [provide(Tenant, "submitter")], attachment: "submitter attachment" },
      async () => {
        await withContext([provide(Tenant, "derived")], async () => {
          expect(await execute(() => use(Tenant))).toBe("derived");
          expect(
            await new Job(() => [use(Tenant), currentAttachment()]).start({ parent: owner }),
          ).toEqual(["owner", "owner attachment"]);
          expect(
            await new Job(() => [use(Tenant), use(Trace), currentAttachment()], {
              values: ContextFrame.from([provide(Tenant, "replacement")]),
              attachment: undefined,
            }).start({ parent: owner }),
          ).toEqual(["replacement", undefined, undefined]);
        });
      },
    );
  } finally {
    release.resolve();
    await owner;
  }
});

test("an explicitly root activation ignores an ambient owner's cancellation", async () => {
  const Tenant = contextKey<string>("tenant");
  const release = Promise.withResolvers<void>();
  let root!: Job<string | undefined>;
  const caller = new Job(
    () => {
      root = new Job(async () => {
        await release.promise;
        return use(Tenant);
      }).start({ parent: undefined });
      currentState().job.cancel();
    },
    { values: [provide(Tenant, "caller")] },
  ).start();
  await caller.close();
  release.resolve();
  expect(await root).toBeUndefined();
  expect(root.signal.aborted).toBe(false);
});
