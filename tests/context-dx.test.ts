import { expect, expectTypeOf, test } from "vitest";
import {
  contextKey,
  execute,
  hasContext,
  MissingContextError,
  provide,
  requireContext,
  use,
  withContext,
} from "../src/index.js";

test("required context distinguishes an absent identity from a bound undefined", async () => {
  const Bound = contextKey<string | undefined>("optional");
  const Missing = contextKey<string | undefined>("optional");
  await execute({ values: [provide(Bound, undefined)] }, () => {
    expect(hasContext(Bound)).toBe(true);
    expect(requireContext(Bound)).toBeUndefined();
    expectTypeOf(requireContext(Bound)).toEqualTypeOf<string | undefined>();
    expect(use(Bound)).toBeUndefined();
    expect(use(Missing)).toBeUndefined();
    expect(hasContext(Missing)).toBe(false);

    let failure: unknown;
    try {
      requireContext(Missing);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MissingContextError);
    expect((failure as MissingContextError).key).toBe(Missing);
    expect((failure as MissingContextError).key.id).not.toBe(Bound.id);
    expect((failure as MissingContextError).key.description).toBe("optional");
  });
});

test("presence and required values respect inherited bindings and undefined shadowing", async () => {
  const Tenant = contextKey<string>("tenant");
  const Optional = contextKey<string | undefined>("optional");
  await execute({ values: [provide(Tenant, "parent"), provide(Optional, "parent")] }, async () => {
    const release = Promise.withResolvers<void>();
    const first = withContext([provide(Optional, undefined)], async () => {
      await release.promise;
      expect(hasContext(Tenant)).toBe(true);
      expect(requireContext(Tenant)).toBe("parent");
      expectTypeOf(requireContext(Tenant)).toEqualTypeOf<string>();
      expect(hasContext(Optional)).toBe(true);
      expect(requireContext(Optional)).toBeUndefined();
    });
    const second = withContext([provide(Tenant, "sibling")], async () => {
      release.resolve();
      await Promise.resolve();
      expect(requireContext(Tenant)).toBe("sibling");
      expect(requireContext(Optional)).toBe("parent");
    });
    await Promise.all([first, second]);
    expect(requireContext(Tenant)).toBe("parent");
    expect(requireContext(Optional)).toBe("parent");
  });
});

test("missing context diagnostics do not expose other bound values", async () => {
  const Secret = contextKey<string>("secret");
  const Missing = contextKey<string>("missing");
  const secret = "private execution value";
  const failure = await execute({ values: [provide(Secret, secret)] }, () =>
    requireContext(Missing),
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(MissingContextError);
  expect((failure as Error).message).not.toContain(secret);
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(Object.values(failure as MissingContextError)).not.toContain(secret);
});

test("context presence and requirements retain the existing outside-execution failure", () => {
  const Key = contextKey<string>("key");
  for (const read of [() => hasContext(Key), () => requireContext(Key)]) {
    let failure: unknown;
    try {
      read();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(MissingContextError);
    expect((failure as Error).message).toMatch(/No active execution/);
  }
});
