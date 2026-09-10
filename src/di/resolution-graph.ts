import { describeToken, type InjectionToken } from "./tokens.js";

/** The root scope's resolution attempts: `from` resolves `to`. */
export interface ResolutionGraph {
  readonly nodes: ReadonlyArray<{ readonly id: number; readonly name: string }>;
  readonly edges: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

/** Root-local diagnostics, with node identity tied to the owning scope. */
export class ResolutionTracker {
  readonly stack: number[] = [];
  #nextId = 0;
  #owners = new WeakMap<object, Map<InjectionToken<unknown>, number>>();
  #nodes = new Map<number, string>();
  #edges = new Map<number, Set<number>>();

  record(owner: object, token: InjectionToken<unknown>): number {
    let ids = this.#owners.get(owner);
    if (!ids) {
      this.#owners.set(owner, (ids = new Map()));
    }

    let id = ids.get(token);
    if (id === undefined) {
      id = this.#nextId++;
      ids.set(token, id);
      this.#nodes.set(id, describeToken(token));
    }

    const parent = this.stack[this.stack.length - 1];
    if (parent !== undefined && parent !== id) {
      let targets = this.#edges.get(parent);
      if (!targets) {
        this.#edges.set(parent, (targets = new Set()));
      }
      targets.add(id);
    }

    return id;
  }

  snapshot(): ResolutionGraph {
    const edges: Array<{ from: number; to: number }> = [];
    for (const [from, targets] of this.#edges) {
      for (const to of targets) {
        edges.push({ from, to });
      }
    }

    return { nodes: Array.from(this.#nodes, ([id, name]) => ({ id, name })), edges };
  }

  remove(owner: object): void {
    const ids = this.#owners.get(owner);
    if (!ids) {
      return;
    }

    for (const id of ids.values()) {
      this.#nodes.delete(id);
      this.#edges.delete(id);
    }

    for (const [from, targets] of this.#edges) {
      for (const to of targets) {
        if (!this.#nodes.has(to)) {
          targets.delete(to);
        }
      }

      if (targets.size === 0) {
        this.#edges.delete(from);
      }
    }

    this.#owners.delete(owner);
  }
}
