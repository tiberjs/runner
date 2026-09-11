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
import { contextKey, execute, forkGroup, onDispose, provide, use } from "@tiberjs/runner";

const RunId = contextKey<string>("run.id");
const controller = new AbortController();

const result = await execute(
  {
    signal: controller.signal,
    attachment: { source: "example" },
    values: [provide(RunId, "run-42")],
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

`execute(handler)` uses a fresh, non-aborted signal and an `undefined` attachment. Use `execute(options, handler)` when supplying context values, an external cancellation signal, an attachment, a deadline, or a scope.

Use `begin()` with `runWith()` when the caller needs to control the execution lifetime manually. The caller owns the returned `RuntimeState`, including its task group and scope, and must close both.

## Structured concurrency

`fork()` creates an awaitable `Task` owned by the current execution's `TaskGroup`.

```ts
import { execute, fork, signal } from "@tiberjs/runner";

await execute(async () => {
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

`AbortSignal` is cooperative. Code that performs asynchronous work must pass the current signal to cancellable APIs or observe it after awaits and before irreversible effects. Rejections those APIs produce for that cancellation, including Node's `AbortError`, are treated as cancellation rather than failure.

### Binding native cancellation

Extend `Cancelable` when an operation already has a native cancellation capability. The only abstract method is `cancel(reason)`; construction does not access Runner or register listeners. Call `operation.cancelable()` explicitly to bind the fully constructed instance to the current execution signal.

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Cancelable } from "@tiberjs/runner";

class Command extends Cancelable {
  constructor(readonly child: ChildProcess) {
    super();
  }

  cancel(_reason: unknown): void {
    this.child.kill("SIGTERM");
  }
}

// Invoke inside a Runner execution.
async function runCommand(command: string, args: string[]) {
  const child = spawn(command, args);
  const closed = once(child, "close");
  const operation = new Command(child);
  await using registration = operation.cancelable();
  return await closed;
}
```

`cancelable(signal)` also works outside Runner. Omitting the signal requires an active execution. An already-aborted explicit signal invokes `cancel(reason)` immediately. Each instance permits one registration at a time; another is allowed after disposal finishes, including failed disposal.

The returned registration is a **separate `AsyncDisposable`**, not the operation:

- Disposal disconnects the listener and joins any cancellation action already invoked. It never requests cancellation itself and never calls the operation's disposer.
- A derived `[Symbol.asyncDispose]()`, managed `onDispose()`, and method-local `defer()` keep their own lifetimes. Register each resource's cleanup separately.
- Cancellation executes in the registration's execution context, not the context that calls `abort()`. Explicit registration outside Runner does not borrow the aborting execution's context.
- Cancellation failures surface from registration disposal with their original identity and cause. If the body also fails, `await using` preserves both through `SuppressedError`.
- Do not await the registration's disposal inside its own `cancel()`; that would wait on itself.

For a function rather than a class, `call(({ onCancel }) => ...)` uses the same binding machinery:

```ts
import { spawn } from "node:child_process";
import { once } from "node:events";
import { call } from "@tiberjs/runner";

function runCommand(command: string, args: string[]) {
  return call(({ onCancel }) => {
    const child = spawn(command, args);
    const closed = once(child, "close");
    onCancel(() => {
      child.kill("SIGTERM");
    });
    return closed;
  });
}
```

`call()` requires an active execution and does not start its handler when already cancelled. Register each native cancellation action with `onCancel()`; an action registered after an abort during setup is invoked immediately. Multiple actions start in registration order without waiting for one another, and disposal joins all of them. Multiple cancellation failures form an `AggregateError`. A retained `onCancel` function cannot register actions after the call closes.

Both forms await invoked cancellation actions, but neither can force an API without a real cancellation mechanism to stop. Keep awaiting the native operation's actual completion: a class registration does not own its result or change how it settles. `call()` awaits the handler and cancellation cleanup before returning, and rejects with the execution's cancellation reason when otherwise-successful work was cancelled. It does not race the result, fork a task, or create a resource scope.

## Execution context

Create typed identities with `contextKey()`, bind values with `provide()`, and read them with `use()`. `execute()` accepts bindings directly, so application code does not need to construct a frame.

```ts
import { contextKey, execute, provide, use, withContext } from "@tiberjs/runner";

const Tenant = contextKey<string>("tenant");

await execute(
  {
    values: [provide(Tenant, "acme")],
  },
  async () => {
    console.log(use(Tenant)); // "acme"

    await withContext([provide(Tenant, "internal")], async () => {
      await Promise.resolve();
      console.log(use(Tenant)); // "internal"
    });

    console.log(use(Tenant)); // "acme"
  },
);
```

`withContext()` derives an immutable child frame for one synchronous or asynchronous call chain. A derived binding shadows its parent without modifying it, so concurrent children remain isolated. Each non-empty derivation creates a frame and ambient runtime state; lookup walks from the newest frame toward the root. Keep nesting bounded on hot paths. An empty binding list is a no-op.

Frame immutability covers binding identity and shadowing, not deep immutability of bound values. Values are stored by reference and are not cloned or frozen. Prefer execution-scoped metadata such as tenant, request, trace, or transaction identity; put services and owned resources in `Scope` rather than using context as a service locator.

`use()` returns `undefined` both when no binding exists and when a key is explicitly bound to `undefined`. This is intentional. Encode a distinct sentinel in the value type when three-state semantics are required. Framework code that must inspect binding presence can use `ContextFrame.has()`.

As with every `AsyncLocalStorage` context, asynchronous work created inside `withContext()` retains the derived state until that work settles, even if the handler has returned. Await or return such work, or start owned concurrent work with `fork()` so its `TaskGroup` cancels and joins it at the execution boundary.

Framework code that needs to retain or compose frames directly can use `ContextFrame.from(entries)`, `frame.withEntries(entries)`, and the lower-level `ContextFrame.with(record)` API. `provide()` returns a `ContextEntry`; it does not mutate the active context.

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

`inject()`, `scoped()`, `onStart()`, and `onDispose()` resolve against the scope that constructs the surrounding resource, and otherwise against the current execution's scope. An execution started from a factory or a startup hook resolves and cleans up in its own scope, not the constructing one.

## Application lifecycle and events

`ApplicationLifecycle` owns a root `Scope`, an `EventBus`, and a background `TaskSupervisor`.

- `start()` runs registered startup hooks in dependency order and emits `AppStarted`.
- `admit()` joins pending startup or seals synchronous startup before accepting work.
- `onDrain()` registers producer shutdown hooks that complete before resources are disposed.
- `close()` stops admission, cancels background work, emits `AppClosing`, joins producers and background cleanup, flushes event deliveries, disposes the root scope, emits `AppClosed`, and closes the event bus.
- `close()` is idempotent, and `ApplicationLifecycle` implements `AsyncDisposable`.

Startup hooks run in the application scope without inheriting the initiating request, task, or construction context; `AppStarted` is emitted outside that caller context too. Explicit `start()` and startup triggered by `admit()` have the same isolation. Startup does not implicitly create a managed execution: a hook that needs `signal()` or `fork()` must start and await an explicit `execute()` (pass `{ scope: app.scope }` to use application providers). Cancelling an individual background task does not cancel shared initialization.

Events use identity-based keys created by `eventKey<T>()`. Equal descriptions do not make two keys equal. Synchronous listeners run during `emit()` and share the emitter's scope. Asynchronous listeners run in bus-owned managed executions joined by `flush()` or `close()`; each delivery owns a child of the bus scope, so a listener resolves application providers, and resources it acquires with `scoped()` or `onDispose()` are released when that delivery ends.

EventBus uses a separate `TaskSupervisor`, not `app.background`. It applies no startup admission gate and drains all admitted deliveries before closing its supervisor, so neither startup notifications nor shutdown notifications are cancelled. Asynchronous listener and per-delivery cleanup failures are reported after delivery settles without rejecting the publisher or delivery barriers; simultaneous failures preserve their original causes in an `AggregateError`.

### Application-owned background work

Use `app.background.run()` for process-local work that may outlive its submitting request. It waits for application startup and returns an awaitable `Task<T>`; `task.cancel(reason)` cancels only that task.

```ts
import { setTimeout } from "node:timers/promises";
import { ApplicationLifecycle, contextKey, provide, signal, use } from "@tiberjs/runner";

const Tenant = contextKey<string>("tenant");

await using app = new ApplicationLifecycle();
await app.start();

const task = app.background.run({ values: [provide(Tenant, "acme")] }, () =>
  setTimeout(25, use(Tenant), { signal: signal() }),
);

console.log(await task); // "acme"
```

Each task starts with a fresh cancellation signal and its own child of the application scope. It inherits no caller context, attachment, deadline, or construction scope. Supply context values explicitly; bindings are captured at submission, but their values are not cloned. Closures can still capture request resources—pass the needed data and acquire resources inside the background handler instead.

The returned task settles after its handler, child tasks, and scope cleanup finish. Awaiting the task transfers responsibility for its failure to the caller and releases the supervisor's failure record, even after an earlier `flush()` reported it. Otherwise failures remain retained by the supervisor and reject `flush()` or `close()`; a failed task does not cancel siblings.

- `await app.background.flush()` waits without cancelling work and leaves admission open.
- `await app.background.close()` permanently stops admission, cancels active work, and joins cleanup. `app.close()` does this automatically, before shared resources are disposed.

Cancellation is cooperative. Flush before application shutdown if work must finish naturally; do not await a supervisor's flush/close (or `app.close()`) inside a task it must join. Background handlers wait for startup, so startup hooks must not await those handlers.

For a separately owned supervisor, use `new TaskSupervisor(scope)` and close it before disposing the borrowed scope. An optional second argument supplies an admission callback. No jobs are persisted or restarted.

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

| Area             | Exports                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Execution        | `execute`, `begin`, `runWith`, `currentState`, `peekState`, `currentAttachment`          |
| Context          | `contextKey`, `provide`, `use`, `withContext`, `ContextFrame`                            |
| Concurrency      | `Task`, `TaskGroup`, `fork`, `forkGroup`                                                 |
| Cancellation     | `signal`, `deadline`, `timeout`, `scheduleDeadline`, `Cancelable`, `call`, `CallContext` |
| DI and resources | `Scope`, `token`, `inject`, `scoped`, `currentScope`, `onStart`, `onDispose`             |
| Lifecycle        | `ApplicationLifecycle`, `AppStarted`, `AppClosing`, `AppClosed`                          |
| Background work  | `TaskSupervisor`, `BackgroundSeed`                                                       |
| Events           | `EventBus`, `eventKey`                                                                   |
| Tracing          | `setTracer`, `span`, `Tracer`, `TraceSpan`                                               |
| Utilities        | `defer`, `combinedError`                                                                 |

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm pack
```

`pnpm build` creates an ESM bundle with Rspack and emits TypeScript declarations into `dist/`. `pnpm pack` is the final check for the npm artifact.
