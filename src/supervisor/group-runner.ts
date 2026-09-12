import { combinedError, LifecycleDependencyError, LifecycleStateError } from "../errors.js";
import { peekState, withoutExecution } from "../execution/state.js";
import type { Job } from "../job/job.js";
import type { GroupMember, TaskGroup } from "./task-group.js";
import { isCancellation } from "../job/abort.js";
import { planGroup, type GroupBoundary, type GroupLeaf } from "./group-plan.js";

const GROUP_FAILED = new DOMException("A TaskGroup member failed", "AbortError");

/** Submission metadata and policy only; every leaf belongs to the supplied owner. */
export class GroupRunner {
  readonly #members = new Map<Job<unknown, unknown>, GroupBoundary>();

  constructor(private readonly owner: Job<unknown, unknown>) {}

  /** Apply declaration policy before the Supervisor decides root propagation. */
  childFailed(child: Job<unknown, unknown>): boolean {
    let boundary = this.#members.get(child);
    while (boundary) {
      if (boundary.failure === "isolate") {
        return false;
      }
      if (!boundary.cancelled) {
        boundary.cancelled = true;
        for (let index = boundary.start; index < boundary.end; index++) {
          boundary.leaves[index]!.job.cancel(GROUP_FAILED);
        }
      }
      boundary = boundary.parent;
    }
    return true;
  }

  run(group: TaskGroup<readonly GroupMember[]>): Promise<unknown[]> {
    const { leaves, results } = planGroup(group);
    const current = peekState()?.job;

    // Complete preflight before registration or activation can reenter submission.
    for (const { job } of leaves) {
      if (this.#members.has(job)) {
        throw new TypeError("A Job may occur only once in a TaskGroup execution.");
      }
      if (job.owns(current) || job.owns(this.owner)) {
        throw new LifecycleDependencyError("TaskGroup", "run", "its owner");
      }
      if (job.state !== "created") {
        throw new LifecycleStateError("TaskGroup", "run", job.state);
      }
    }

    for (const leaf of leaves) {
      this.#members.set(leaf.job, leaf.boundary);
    }
    return withoutExecution(() => this.#execute(leaves, results));
  }

  async #execute(leaves: readonly GroupLeaf[], results: unknown[]): Promise<unknown[]> {
    const errors = new Set<unknown>();
    let interrupted = false;
    let interruption: unknown;
    try {
      for (const leaf of leaves) {
        if (!interrupted) {
          try {
            leaf.job.start({ parent: this.owner });
          } catch (error) {
            interrupted = true;
            interruption =
              this.owner.signal.aborted && leaf.job.state === "created"
                ? this.owner.signal.reason
                : error;
            if (!isCancellation(interruption, this.owner.signal)) {
              errors.add(interruption);
            }
            for (const member of leaves) {
              member.job.cancel(GROUP_FAILED);
            }
          }
        }
        if (interrupted && leaf.job.state === "created") {
          void leaf.job.close(GROUP_FAILED).catch(() => {});
        }
      }

      let cancelled = interrupted;
      let reason = interruption;
      const completed = await Promise.all(leaves.map(({ job }) => job.result()));
      for (let index = 0; index < leaves.length; index++) {
        const leaf = leaves[index]!;
        const result = completed[index]!;
        if (result.ok) {
          leaf.results[leaf.index] = result.value;
        } else if (leaf.job.failed) {
          errors.add(leaf.job.failure);
        } else if (!cancelled) {
          cancelled = true;
          reason = result.error;
        }
      }
      if (errors.size) {
        throw combinedError([...errors], "TaskGroup execution failed.");
      }
      if (cancelled) {
        throw reason;
      }
      return results;
    } finally {
      // Finished leaves remain reserved until all group lifetimes have settled.
      for (const leaf of leaves) {
        this.#members.delete(leaf.job);
      }
    }
  }
}
