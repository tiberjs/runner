import type { ExecutionSeed } from "./context/execution-context.js";
import { Job } from "../job/job.js";
import { currentState } from "./state.js";

type ExecutionHandler<T> = () => T | PromiseLike<T>;

/** A lexical child boundary, returning only after its body and descendants finish. */
export function execute<T>(handler: ExecutionHandler<T>): Promise<T>;
export function execute<T>(seed: ExecutionSeed, handler: ExecutionHandler<T>): Promise<T>;
export function execute<T>(
  seedOrHandler: ExecutionSeed | ExecutionHandler<T>,
  suppliedHandler?: ExecutionHandler<T>,
): Promise<T> {
  try {
    const handler = typeof seedOrHandler === "function" ? seedOrHandler : suppliedHandler;
    if (typeof handler !== "function") {
      throw new TypeError("execute() requires a handler.");
    }
    const seed = typeof seedOrHandler === "function" ? undefined : seedOrHandler;
    return new Job(handler, seed).start({ propagation: "isolate" }).join();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Start a real child Job in the current call-chain context. */
export function fork<T>(handler: ExecutionHandler<T>): Job<T> {
  currentState();
  return new Job(handler).start();
}

/** A lexical child whose deadline constrains its whole descendant lifetime. */
export async function timeout<T>(ms: number, handler: ExecutionHandler<T>): Promise<T> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError("Timeout must be finite and non-negative.");
  }
  currentState();
  return await execute({ deadline: Date.now() + ms }, handler);
}
