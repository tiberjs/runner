import { Job } from "../job/job.js";
import { TaskGroup, type GroupMember } from "./task-group.js";

/** Per-submission policy boundaries; these do not own or activate Jobs. */
export interface GroupBoundary {
  readonly parent: GroupBoundary | undefined;
  readonly failure: "fail-fast" | "isolate";
  readonly leaves: GroupLeaf[];
  readonly start: number;
  end: number;
  cancelled: boolean;
}

export interface GroupLeaf {
  readonly job: Job<unknown, unknown>;
  readonly boundary: GroupBoundary;
  readonly results: unknown[];
  readonly index: number;
}

/** Interpret structure only. Admission and activation belong to the GroupRunner. */
export function planGroup(group: TaskGroup<readonly GroupMember[]>): {
  leaves: GroupLeaf[];
  results: unknown[];
} {
  const leaves: GroupLeaf[] = [];
  const seen = new Set<Job<unknown, unknown>>();

  const visit = (
    declaration: TaskGroup<readonly GroupMember[]>,
    parent?: GroupBoundary,
  ): unknown[] => {
    const boundary: GroupBoundary = {
      parent,
      failure: declaration.failure,
      leaves,
      start: leaves.length,
      end: 0,
      cancelled: false,
    };
    const results: unknown[] = [];
    for (let index = 0; index < declaration.members.length; index++) {
      const member = declaration.members[index];
      if (member instanceof TaskGroup) {
        results[index] = visit(member, boundary);
      } else if (member instanceof Job) {
        if (seen.has(member)) {
          throw new TypeError("A Job may occur only once in a TaskGroup execution.");
        }
        seen.add(member);
        leaves.push({ job: member, boundary, results, index });
      } else {
        throw new TypeError("TaskGroup members must be Jobs or TaskGroups.");
      }
    }
    boundary.end = leaves.length;
    return results;
  };

  const results = visit(group);
  return { leaves, results };
}
