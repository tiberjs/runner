# Pitfalls

Ownership, isolation, and notification contracts that can surprise callers. The
examples below describe the current APIs; they replace the earlier manual-scope,
context-sentinel, and startup-execution workarounds.

## 1. Scope parenting is not scope ownership

`execute()` without scope options creates and disposes a fresh root. It cannot see
application providers. A supplied `scope` is borrowed: its resources survive the
execution and are disposed by its owner.

Use `parentScope` when an operation needs application providers and local cleanup:

```ts
await execute({ parentScope: app.scope }, () => {
  const database = inject(Database);
  onDispose(() => releaseOperationResources());
  return database.query();
});
```

The execution creates a child, joins its tasks, and disposes that child before
settling. Providers resolved from an ancestor keep their existing ownership; this
does not make application singletons execution-local. Use `scoped()` for local
resource identity and `onDispose()` for local cleanup.

| Seed          | Scope             | Disposal owner       |
| ------------- | ----------------- | -------------------- |
| neither field | fresh root        | `execute()`          |
| `parentScope` | fresh child       | `execute()`          |
| `scope`       | supplied instance | caller               |
| both fields   | rejected          | no child is acquired |

`begin()` accepts the same alternatives, but is always manually managed: its caller
must close the returned task group and scope, including a newly created child.
An exception or cancellation does not change the ownership rule.

Source: `src/runtime/execution.ts`, `src/di/scope.ts`.

## 2. Missing context differs from an explicit `undefined`

`use()` deliberately returns `undefined` for both cases. Application code need not
inspect `key.id` or encode an artificial sentinel:

```ts
const Tenant = contextKey<string | undefined>("tenant");

await execute({ values: [provide(Tenant, undefined)] }, () => {
  hasContext(Tenant); // true
  requireContext(Tenant); // undefined: this is a bound value
});

await execute(() => {
  hasContext(Tenant); // false
  requireContext(Tenant); // throws MissingContextError
});
```

Both helpers follow inherited bindings and shadowing. `requireContext()` returns
exactly the key's value type, including `undefined` when declared. The error exposes
`key`, never the context's bound values. All three accessors require an active
execution. Frame immutability does not clone or freeze the bound objects.

Source: `src/runtime/context.ts`, `src/context/frame.ts`.

## 3. Background work is isolated, but closures and bound objects are not copied

`app.background.run()` inherits no submitting execution context, attachment,
deadline, cancellation signal, or construction scope. Each task owns an application
child scope and a fresh signal. Cancelling the request does not cancel it; use
`task.cancel(reason)` when that is required.

Bindings are materialized at submission, but their values remain references. Pass
selected data explicitly and acquire resources inside the task:

```ts
const tenant = requireContext(Tenant); // string
const jobId = request.jobId; // string snapshot, not the request object

const task = app.background.run({ values: [provide(Tenant, tenant)] }, () =>
  inject(JobStore).process(jobId),
);
```

Do not capture a request-scoped transaction or resource that will be disposed before
the task finishes. Copy mutable payloads explicitly when a snapshot is needed; Runner
does not choose a cloning policy for application data.

The task settles after its handler, descendants, and cleanup. Consuming its result
transfers failure responsibility to the caller. Otherwise a genuine failure remains
owned by the supervisor and rejects `flush()`, `close()`, or `app.close()`.

Source: `src/lifecycle/task-supervisor.ts`, `src/runtime/task-group.ts`.

## 4. Startup hooks remain unmanaged unless they request an execution

Hooks run in their owning scope, not the initiating request's execution. Calling
`signal()`, `fork()`, or `timeout()` directly is therefore invalid. A hook that needs
those primitives receives an explicit helper:

```ts
onStart(async ({ execute }) => {
  await execute(async () => {
    const a = fork(() => warm("a"));
    const b = fork(() => warm("b"));
    await a;
    await b;
  });
});
```

`StartupContext.execute()` borrows the hook's scope, creates fresh execution state,
and joins managed work. Warmup resources remain application-owned, rather than being
disposed at the helper's boundary. Always await or return its promise. The context
expires when its hook settles, on either success or failure; later calls reject with
`LifecycleStateError`. It is safe to destructure the helper as above.

The helper does not relax startup dependency ordering or permit late registration of
resources that themselves require startup. Existing no-argument hooks remain valid.

Source: `src/di/startup-context.ts`, `src/di/resources.ts`.

## 5. Direct lifecycle self-joins fail instead of hanging

An application background handler waits for startup admission. A startup hook cannot
consume that handler's task while startup is still pending: both `await task` and
`task.then(...)` reject with `LifecycleDependencyError`. Rejected early consumption
does not transfer the task's failure ownership.

Submitting work without consuming it during startup remains supported. Use the
startup execution helper for work that must complete before admission.

Runner also rejects direct joins of an owned barrier:

- A task joining its own task group or supervisor.
- Background work joining its application shutdown.
- An asynchronous listener joining its own bus or application shutdown.
- A startup hook joining its own startup or shutdown.
- A drain/disposal callback joining the application shutdown that is awaiting it.

Checks run before closing state is committed and before returning an already pending
close promise. Catching a rejected close does not accidentally seal admission. An
independent coordinator can still close and join the work normally; repeated closes
from that coordinator return the same promise.

Coordinate shutdown outside the work it must join, even if the work intends to call
`close()` without awaiting it. These are guards for Runner-owned dependency barriers,
not detection of arbitrary cycles among application promises or external systems.

Source: `src/lifecycle/diagnostics.ts`, `src/lifecycle/application.ts`,
`src/runtime/task-group.ts`, `src/events/event-bus.ts`.

## 6. Listener failures are notifications, not publisher failures

Synchronous listener throws and asynchronous listener/cleanup failures do not reject
`emit()`, `flush()`, or `close()`. Configure a synchronous error sink when the console
default is insufficient:

```ts
const app = new ApplicationLifecycle({
  events: {
    onError(error, { event }) {
      logger.error({ error, event }, "Event listener failed");
    },
  },
});
```

The same options are accepted by `new EventBus(scope, options)`. `event` is the event
key's description. The sink receives the original failure outside listener execution
and construction scope. Simultaneous delivery and cleanup failures retain their
original causes in an `AggregateError`.

The sink must return `undefined`, not a promise. If it throws, safe console reporting
receives both the listener failure and the reporting failure; neither escapes to the
publisher. Any asynchronous diagnostics need their own explicitly managed lifetime.
This API adds no retries, persistence, or dead-letter queue.

Source: `src/events/event-bus.ts`.

## 7. Closing admission is not immediate resource disposal

`LifecycleStateError` identifies rejected admission with `owner`, `operation`, and
`state` (`"closing"` or `"closed"`). It does not replace native handler or cleanup
errors, which retain their identity and cause. Disposed scope access continues to use
`ScopeClosedError`.

**Breaking change:** `EventBus.emit()` now throws once bus closing starts, including
when no listeners exist. It no longer silently discards emissions after close.
Application producers must finish before the bus is closed.

Application shutdown still stops admission, cancels background work, emits
`AppClosing`, joins drain hooks and background cleanup, flushes deliveries, disposes
the root scope, emits `AppClosed`, then closes the bus. Drain-time resource access and
already admitted deliveries remain valid until their corresponding teardown phase.
`close()` remains idempotent; calling it is not equivalent to the scope already being
disposed. Prefer letting the application own its bus shutdown. If a caller closes
that bus early, lifecycle notification failures are reported without skipping root
resource cleanup.

Independently, an unobserved `fork()` failure still rejects its owning execution
boundary even when the top-level handler returned successfully. Await the task when
the caller will handle its failure; do not suppress it just to make shutdown green.

Source: `src/lifecycle/application.ts`, `src/lifecycle/task-supervisor.ts`,
`src/runtime/execution.ts`, `src/events/event-bus.ts`.
