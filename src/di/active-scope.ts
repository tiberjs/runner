import { AsyncLocalStorage } from "node:async_hooks";
import type { Scope } from "./scope.js";

/** Scope active during resource construction, startup, or teardown. */
export const activeScope = new AsyncLocalStorage<Scope>();
