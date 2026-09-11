import { activeScope } from "../di/active-scope.js";
import type { Scope } from "../di/scope.js";
import type { StartupContext } from "../di/startup-context.js";
import { createExecutionState, runExecution } from "../runtime/managed-execution.js";
import { withoutExecution } from "../runtime/state.js";
import {
  dependencyFrame,
  LifecycleStateError,
  releaseDependency,
  runWithDependency,
  startupDependency,
} from "./diagnostics.js";

class HookStartupContext implements StartupContext {
  #scope: Scope | undefined;

  constructor(scope: Scope) {
    this.#scope = scope;
  }

  readonly execute = <T>(handler: () => T | PromiseLike<T>): Promise<T> => {
    const scope = this.#scope;
    if (!scope) {
      return Promise.reject(new LifecycleStateError("StartupContext", "execute", "closed"));
    }
    return withoutExecution(() => runExecution(createExecutionState(scope), handler, false));
  };

  release(): void {
    this.#scope = undefined;
  }
}

/** @internal Compose hook isolation, optional managed warmup, and dependency tracking. */
export async function runStartupHook(
  scope: Scope,
  hook: (context: StartupContext) => void | PromiseLike<void>,
): Promise<void> {
  const context = new HookStartupContext(scope);
  const frame = dependencyFrame(startupDependency(scope));
  try {
    await withoutExecution(() =>
      runWithDependency(frame, () =>
        activeScope.run(scope, async () => {
          await hook(context);
        }),
      ),
    );
  } finally {
    context.release();
    releaseDependency(frame);
  }
}
