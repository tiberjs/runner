import { expect, test } from "vitest";
import { ContextFrame, contextKey, execute, provide, use, withContext } from "../src/index.js";

const seed = () => ({ signal: new AbortController().signal, attachment: undefined });

test("context derivation requires an active execution even without bindings", () => {
  expect(() => withContext([], () => undefined)).toThrowError(/No active execution/);
});

test("execution accepts context bindings without exposing frame construction", async () => {
  const Tenant = contextKey<string>("tenant");

  await execute({ ...seed(), values: [provide(Tenant, "acme")] }, async () => {
    expect(use(Tenant)).toBe("acme");
    await Promise.resolve();
    expect(use(Tenant)).toBe("acme");
  });
});

test("derived bindings remain isolated across concurrent call chains", async () => {
  const Tenant = contextKey<string>("tenant");
  const release = Promise.withResolvers<void>();

  await execute({ ...seed(), values: [provide(Tenant, "parent")] }, async () => {
    const first = withContext([provide(Tenant, "first")], async () => {
      await release.promise;
      return use(Tenant);
    });
    const second = withContext([provide(Tenant, "second")], async () => {
      release.resolve();
      await Promise.resolve();
      return use(Tenant);
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(use(Tenant)).toBe("parent");
  });
});

test("raw frames and binding helpers share identity and shadowing semantics", async () => {
  const Tenant = contextKey<string>("tenant");
  const Trace = contextKey<string>("trace");
  const root = ContextFrame.from([provide(Tenant, "first"), provide(Tenant, "parent")]);
  const child = root.withEntries([provide(Tenant, "child"), provide(Trace, "trace-1")]);

  expect(root.get(Tenant.id)).toBe("parent");
  expect(root.has(Trace.id)).toBe(false);
  expect(child.get(Tenant.id)).toBe("child");
  expect(child.get(Trace.id)).toBe("trace-1");

  await execute({ ...seed(), values: child }, () => {
    expect(use(Tenant)).toBe("child");
    expect(use(Trace)).toBe("trace-1");
  });
});
