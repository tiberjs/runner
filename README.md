# @tiberjs/runner

`@tiberjs/runner` is an execution runtime for Node.js. It provides immutable execution context, structured concurrency, scoped dependency injection, resource lifecycle management, application lifecycle events, cancellation, deadlines, and tracing.

Runner is a Node.js ESM package. It requires Node.js 20 or newer.

## Installation

```sh
pnpm add @tiberjs/runner
```

```sh
npm install @tiberjs/runner
```

## What runner owns

- An ambient `ExecutionContext` containing immutable values, an `AbortSignal`, and an optional deadline.
- A `TaskGroup` that owns every task created with `fork()` and joins that work before its execution boundary closes.
- Hierarchical `Scope` instances for dependency identity, startup hooks, and deterministic resource disposal.
- `ApplicationLifecycle` for startup, work admission, producer draining, events, and singleton teardown.
- Runtime primitives such as `timeout()`, `span()`, and `scheduleDeadline()`.

## Managed execution

Use `execute()` when one callback defines the complete lifetime of an operation. Runner creates a task group, establishes ambient state, rejects cancelled work, joins child tasks, and disposes the execution scope before the returned promise settles.

```ts
import { ContextFrame, contextKey, execute, forkGroup, onDispose, use } from "@tiberjs/runner";

const RunId = contextKey<string>("run.id");
const controller = new AbortController();

const result = await execute(
  {
    signal: controller.signal,
    attachment: { source: "example" },
    values: ContextFrame.empty.with({ [RunId.id]: "run-42" }),
  },
  async () => {
    onDispose(() => {
      console.log("execution resources released");
    });

    const [profile, permissions] = await forkGroup(
      async () => ({ name: "Ada" }),
      async () => ["articles:read"],
    );

    return {
      runId: use(RunId),
      profile,
      permissions,
    };
  },
);
```

A scope supplied through `ExecutionSeed.scope` remains owned by the caller. If the seed omits a scope, `execute()` creates and disposes one automatically.

Use `begin()` with `runWith()` when the caller needs to control the execution lifetime manually. The caller owns the returned `RuntimeState`, including its task group and scope, and must close both.

## Structured concurrency

`fork()` creates an awaitable `Task` owned by the current execution's `TaskGroup`.

```ts
import { execute, fork, signal } from "@tiberjs/runner";

await execute({ signal: new AbortController().signal, attachment: undefined }, async () => {
  const task = fork(async () => {
    signal().throwIfAborted();
    return "done";
  });

  console.log(await task);
});
```

The ownership rules are deliberate:

- Closing a task group cancels active tasks and then joins them.
- Awaiting or chaining a `Task` transfers responsibility for its result to the caller.
- A genuine failure from an unobserved task is surfaced when the execution boundary closes.
- Cancellation does not hide an independent error raised during cleanup.
- `forkGroup()` cancels and joins sibling work when one member fails, then preserves every genuine failure.

## Cancellation and deadlines

`signal()` returns the current execution's live cancellation signal. `deadline()` returns the current absolute deadline in epoch milliseconds when one exists.

`timeout()` derives a child signal, deadline, and task group. Timeout or parent cancellation aborts the child, and all work forked inside the callback is joined before `timeout()` settles.

```ts
import { setTimeout } from "node:timers/promises";
import { signal, timeout } from "@tiberjs/runner";

const value = await timeout(1_000, async () => {
  const current = signal();
  current.throwIfAborted();
  return setTimeout(250, "ready", { signal: current });
});
```

`AbortSignal` is cooperative. Code that performs asynchronous work must pass the current signal to cancellable APIs or observe it after awaits and before irreversible effects.

## Execution context

Create typed identities with `contextKey()`, bind values with `provide()`, and read them with `use()`.

```ts
import { ContextFrame, contextKey, execute, provide, use } from "@tiberjs/runner";

const Tenant = contextKey<string>("tenant");
const [key, value] = provide(Tenant, "acme");
const values = ContextFrame.empty.with({ [key.id]: value });

await execute({ signal: new AbortController().signal, attachment: undefined, values }, () => {
  console.log(use(Tenant)); // "acme"
});
```

`ContextFrame` is immutable. A derived frame shadows matching keys without modifying its parent, so sibling executions can share inherited context safely. `provide()` returns a `ContextEntry`; applying entries to downstream state is the responsibility of the calling execution pipeline.

## Dependency injection and resources

Classes can be used directly as injection tokens. Use `token<T>()` for values and interfaces that do not have a runtime constructor.

```ts
import { ApplicationLifecycle, inject, onDispose, onStart, token } from "@tiberjs/runner";

const DatabaseUrl = token<string>("database.url");

class Database {
  readonly url = inject(DatabaseUrl);

  constructor() {
    onStart(() => {
      console.log(`connect ${this.url}`);
    });

    onDispose(() => {
      console.log("disconnect");
    });
  }
}

await using app = new ApplicationLifecycle();
app.scope.provide(DatabaseUrl, () => "postgres://localhost/app");

const database = app.scope.get(Database);
await app.start();

console.log(database.url);
```

A `Scope` caches each resolved token once. Child scopes can resolve providers from their ancestors while retaining ownership of resources created locally. Cleanup runs in LIFO order. Objects implementing `Symbol.asyncDispose`, `Symbol.dispose`, or `ScopeObject.onClose()` are adopted automatically; conflicting disposal protocols are rejected rather than invoked ambiguously.

Use `scoped()` when a resource should be acquired once in the active scope without registering a provider first. Use `onStart()` during managed construction to register dependency-ordered initialization and `onDispose()` to register LIFO cleanup.

## Application lifecycle and events

`ApplicationLifecycle` owns a root `Scope` and an `EventBus`.

- `start()` runs registered startup hooks in dependency order and emits `AppStarted`.
- `admit()` joins pending startup or seals synchronous startup before accepting work.
- `onDrain()` registers producer shutdown hooks that complete before resources are disposed.
- `close()` stops admission, emits `AppClosing`, drains producers, flushes event deliveries, disposes the root scope, emits `AppClosed`, and closes the event bus.
- `close()` is idempotent, and `ApplicationLifecycle` implements `AsyncDisposable`.

Events use identity-based keys created by `eventKey<T>()`. Equal descriptions do not make two keys equal. Synchronous listeners run during `emit()`. Asynchronous listeners run in bus-owned managed executions and are joined by `flush()` or `close()`.

## Tracing

Runner uses a no-op tracer until `setTracer()` installs a process-wide implementation. `span()` records thrown errors and always ends the created span.

```ts
import { setTracer, span } from "@tiberjs/runner";

setTracer({
  startSpan(name) {
    const startedAt = performance.now();

    return {
      setAttribute() {},
      recordError(error) {
        console.error(name, error);
      },
      end() {
        console.log(name, performance.now() - startedAt);
      },
    };
  },
});

await span("job.refresh", async () => {
  await Promise.resolve();
});
```

## Execution state API

Most code only needs `execute()`, `fork()`, context accessors, and DI helpers. Code that manages a longer execution lifetime can use the lower-level state API:

| API                              | Responsibility                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `begin()`                        | Create a `RuntimeState` without running or closing it.                                |
| `runWith()`                      | Make a `RuntimeState` ambient for one synchronous or asynchronous call chain.         |
| `currentState()` / `peekState()` | Read the active state, throwing or returning `undefined` when no execution is active. |
| `currentAttachment<T>()`         | Read caller-defined data associated with the current execution.                       |
| `TaskGroup`                      | Own tasks when their lifetime does not match one `execute()` call.                    |
| `scheduleDeadline()`             | Schedule a disposable absolute deadline without native timer overflow.                |
| `COMPLETED`                      | Standard cancellation reason used when an execution finishes normally.                |

The attachment is opaque to runner. The caller defines its shape and can expose a typed accessor for code running inside the execution:

```ts
import { currentAttachment, execute } from "@tiberjs/runner";

interface Job {
  id: string;
}

function currentJob(): Job {
  return currentAttachment<Job>();
}

await execute(
  {
    signal: new AbortController().signal,
    attachment: { id: "job-42" } satisfies Job,
  },
  () => {
    console.log(currentJob().id);
  },
);
```

## API overview

| Area             | Exports                                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| Execution        | `execute`, `begin`, `runWith`, `currentState`, `peekState`, `currentAttachment` |
| Context          | `ContextFrame`, `contextKey`, `provide`, `use`                                  |
| Concurrency      | `Task`, `TaskGroup`, `fork`, `forkGroup`                                        |
| Cancellation     | `signal`, `deadline`, `timeout`, `scheduleDeadline`                             |
| DI and resources | `Scope`, `token`, `inject`, `scoped`, `currentScope`, `onStart`, `onDispose`    |
| Lifecycle        | `ApplicationLifecycle`, `AppStarted`, `AppClosing`, `AppClosed`                 |
| Events           | `EventBus`, `eventKey`                                                          |
| Tracing          | `setTracer`, `span`, `Tracer`, `TraceSpan`                                      |
| Utilities        | `defer`, `combinedError`                                                        |

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm pack
```

`pnpm build` creates an ESM bundle with Rspack and emits TypeScript declarations into `dist/`. `pnpm pack` is the final check for the npm artifact.
