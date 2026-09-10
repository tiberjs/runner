import { describe, expect, test } from "vitest";
import type { ResolutionGraph } from "../src/index.js";
import { inject, Scope, scoped, token } from "../src/index.js";

function namedEdges(graph: ResolutionGraph): string[] {
  const names = new Map(graph.nodes.map(({ id, name }) => [id, name]));

  return graph.edges
    .map(({ from, to }) => {
      expect(names.has(from), "edge source must be an active graph node").toBe(true);
      expect(names.has(to), "edge target must be an active graph node").toBe(true);

      return `${names.get(from)} -> ${names.get(to)}`;
    })
    .sort();
}

function nodeId(graph: ResolutionGraph, name: string): number {
  const matches = graph.nodes.filter((node) => node.name === name);
  expect(matches.length, `expected one ${name} node`).toBe(1);

  return matches[0]!.id;
}

describe("resolution graph", () => {
  test("records every consumer of an already cached shared dependency", async () => {
    const scope = new Scope();
    class Shared {}
    class First {
      readonly shared = inject(Shared);
    }
    class Second {
      readonly shared = inject(Shared);
    }

    const shared = scope.get(Shared);
    expect(scope.get(First).shared).toBe(shared);
    expect(scope.get(Second).shared).toBe(shared);
    scope.get(Second);

    const graph = scope.resolutionGraph();

    expect(graph.nodes.map(({ name }) => name).sort()).toEqual(["First", "Second", "Shared"]);
    expect(namedEdges(graph)).toEqual(["First -> Shared", "Second -> Shared"]);

    await scope[Symbol.asyncDispose]();
  });

  test("distinguishes identical class names, opaque tokens, and aliases by identity", async () => {
    const scope = new Scope();
    const FirstStore = class Store {};
    const SecondStore = class Store {};
    const firstAlias = token<object>("Store");
    const secondAlias = token<object>("Store");
    const firstConsumer = token<object>("first");
    const secondConsumer = token<object>("second");

    scope.provide(firstAlias, () => inject(FirstStore));
    scope.provide(secondAlias, () => inject(SecondStore));
    scope.provide(firstConsumer, () => inject(firstAlias));
    scope.provide(secondConsumer, () => inject(secondAlias));

    scope.get(FirstStore);
    scope.get(SecondStore);

    expect(scope.get(firstConsumer)).toBe(scope.get(FirstStore));
    expect(scope.get(secondConsumer)).toBe(scope.get(SecondStore));
    expect(scope.get(firstConsumer)).not.toBe(scope.get(secondConsumer));

    const graph = scope.resolutionGraph();
    const first = nodeId(graph, "first");
    const second = nodeId(graph, "second");
    const dependencyOf = (id: number): number => {
      const edges = graph.edges.filter(({ from }) => from === id);
      expect(edges.length).toBe(1);
      return edges[0]!.to;
    };

    const firstAliasId = dependencyOf(first);
    const secondAliasId = dependencyOf(second);
    const storeIds = [
      firstAliasId,
      secondAliasId,
      dependencyOf(firstAliasId),
      dependencyOf(secondAliasId),
    ];

    expect(new Set(storeIds).size).toBe(4);
    expect(
      graph.nodes
        .filter(({ name }) => name === "Store")
        .map(({ id }) => id)
        .sort(),
    ).toEqual(storeIds.sort());
    expect(graph.nodes.length).toBe(6);
    expect(graph.edges.length).toBe(4);

    await scope[Symbol.asyncDispose]();
  });

  test("nested resolution across independent roots never creates cross-root edges", async () => {
    const first = new Scope();
    const second = new Scope();
    const external = token<object>("external");
    const dependency = token<object>("dependency");
    const consumer = token<object>("consumer");

    second.provide(dependency, () => ({}));
    second.provide(external, () => inject(dependency));
    first.provide(consumer, () => second.get(external));

    expect(first.get(consumer)).toBe(second.get(external));
    expect(first.resolutionGraph().nodes.map(({ name }) => name)).toEqual(["consumer"]);
    expect(first.resolutionGraph().edges).toEqual([]);
    expect(namedEdges(second.resolutionGraph())).toEqual(["external -> dependency"]);

    await first[Symbol.asyncDispose]();
    await second[Symbol.asyncDispose]();
  });

  test("child-local providers have distinct ownership and disposal removes both incoming and outgoing edges", async () => {
    const root = new Scope();
    const child = root.child();
    const sibling = root.child();
    const shared = token<object>("shared");
    const local = token<object>("local");
    const consumer = token<object>("consumer");
    const borrowed = token<object>("borrowed");
    const events: string[] = [];

    root.provide(shared, () => ({}));
    root.provide(local, () => ({}));
    const rootLocal = root.get(local);
    root.get(shared);

    child.provide(local, () => ({ shared: inject(shared) }));
    sibling.provide(local, () => ({ shared: inject(shared) }));
    child.provide(consumer, () => inject(local));
    sibling.provide(consumer, () => inject(local));
    root.provide(borrowed, () => child.get(consumer));

    expect(root.get(borrowed)).toBe(child.get(consumer));
    expect(child.get(consumer)).not.toBe(sibling.get(consumer));
    expect(child.get(local)).not.toBe(rootLocal);

    child.defer(() => {
      events.push("child disposed");
    });

    const graph = root.resolutionGraph();

    expect(child.resolutionGraph()).toEqual(graph);
    expect(graph.nodes.filter(({ name }) => name === "local").length).toBe(3);
    expect(namedEdges(graph)).toEqual([
      "borrowed -> consumer",
      "consumer -> local",
      "consumer -> local",
      "local -> shared",
      "local -> shared",
    ]);

    await child[Symbol.asyncDispose]();

    expect(events).toEqual(["child disposed"]);
    expect(
      root
        .resolutionGraph()
        .nodes.map(({ name }) => name)
        .sort(),
    ).toEqual(["borrowed", "consumer", "local", "local", "shared"]);
    expect(namedEdges(root.resolutionGraph())).toEqual(["consumer -> local", "local -> shared"]);
    expect(root.get(local)).toBe(rootLocal);

    await sibling[Symbol.asyncDispose]();

    expect(
      root
        .resolutionGraph()
        .nodes.map(({ name }) => name)
        .sort(),
    ).toEqual(["borrowed", "local", "shared"]);
    expect(root.resolutionGraph().edges).toEqual([]);

    await root[Symbol.asyncDispose]();

    expect(root.resolutionGraph()).toEqual({ nodes: [], edges: [] });
  });

  test("inline resources record cached edges and root disposal cannot be repopulated by a surviving child", async () => {
    const root = new Scope();
    const child = root.child();
    const resource = token<object>("resource");
    const consumer = token<object>("consumer");
    const later = token<object>("later");
    let disposed = 0;
    const value = child.use(
      resource,
      () => ({}),
      () => {
        disposed++;
      },
    );

    expect(
      child.use(consumer, () => scoped(resource, () => expect.unreachable("must use cache"))),
    ).toBe(value);
    expect(namedEdges(root.resolutionGraph())).toEqual(["consumer -> resource"]);

    await root[Symbol.asyncDispose]();

    expect(disposed).toBe(0);
    expect(child.get(resource)).toBe(value);

    child.use(later, () => ({}));

    expect(root.resolutionGraph()).toEqual({ nodes: [], edges: [] });
    expect(child.resolutionGraph()).toEqual({ nodes: [], edges: [] });

    await child[Symbol.asyncDispose]();

    expect(disposed).toBe(1);
  });

  test("failed attempts remain diagnostic evidence without contaminating later resolutions", async () => {
    const scope = new Scope();
    const failing = token<object>("failing");
    const dependency = token<object>("dependency");
    const later = token<object>("later");
    const failure = new Error("construction failed");
    let attempts = 0;

    scope.provide(dependency, () => ({}));
    scope.provide(failing, () => {
      const value = inject(dependency);
      if (++attempts === 1) {
        throw failure;
      }

      return value;
    });
    scope.provide(later, () => inject(dependency));

    let constructionFailure: unknown;
    try {
      scope.get(failing);
    } catch (error) {
      constructionFailure = error;
    }

    expect(constructionFailure).toBe(failure);

    expect(namedEdges(scope.resolutionGraph())).toEqual(["failing -> dependency"]);

    expect(scope.get(later)).toBe(scope.get(failing));

    expect(namedEdges(scope.resolutionGraph())).toEqual([
      "failing -> dependency",
      "later -> dependency",
    ]);

    scope.defer(() => {
      throw failure;
    });
    await expect(scope[Symbol.asyncDispose]()).rejects.toBe(failure);

    expect(scope.resolutionGraph()).toEqual({ nodes: [], edges: [] });
  });
});
