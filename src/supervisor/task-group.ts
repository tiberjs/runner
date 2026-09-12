import type { Job } from "../job/job.js";

export type GroupMember = Job<unknown, unknown> | TaskGroup<readonly GroupMember[]>;

export type GroupResults<Members extends readonly GroupMember[]> = {
  -readonly [Index in keyof Members]: Members[Index] extends Job<infer Result, infer _Published>
    ? Result
    : Members[Index] extends TaskGroup<infer Nested>
      ? GroupResults<Nested>
      : never;
};

export interface TaskGroupOptions {
  readonly failure?: "fail-fast" | "isolate";
}

/** An immutable declaration of jobs and nested result shape, never an execution owner. */
export class TaskGroup<const Members extends readonly GroupMember[]> {
  readonly members: Readonly<Members>;
  readonly failure: "fail-fast" | "isolate";

  constructor(members: Members, options: TaskGroupOptions = {}) {
    const failure = options.failure ?? "fail-fast";
    if (failure !== "fail-fast" && failure !== "isolate") {
      throw new TypeError("TaskGroup failure must be fail-fast or isolate.");
    }
    this.members = Object.freeze([...members]) as unknown as Readonly<Members>;
    this.failure = failure;
    Object.freeze(this);
  }
}
