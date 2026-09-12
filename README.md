# @tiberjs/runner

Structured concurrency for Node.js, built around **Job**, **Supervisor**, **TaskGroup**, and immutable **Context**.

Requires Node.js 24 or newer. ESM only.

```sh
pnpm add @tiberjs/runner
```

## Jobs

A `Job` is both an execution and its awaitable lifetime. Construction is cold: it neither runs the body nor captures the current context. Call `start()` once to activate it.

```ts
import { Job, execute, fork } from "@tiberjs/runner";

const job = new Job(() => 42);
job.start();
console.log(await job); // 42

const result = await execute(async () => {
  const first = fork(() => "first");
  const second = fork(() => "second");
  return [await first, await second];
});
```

- A Job settles only after its body and all descendants finish, including asynchronous finalizers.
- `fork()` starts a child of the current Job. `new Job(body).start()` does the same inside an execution, or starts a root outside one.
- `start({ parent })` selects an explicit owner and inherits that owner's context. `start({ parent: undefined })` starts an independent root.
- `cancel(reason)` requests cooperative cancellation. It does not mean the work has finished.
- `value()` observes a value published by the body without waiting for descendants. It rejects if the Job settles without invoking its publisher.
- `join()` and `await job` observe the complete result. Awaiting a cold Job rejects; awaiting never starts it.
- `finish()` stops admission of direct children and joins without cancellation. `close(reason)` stops admission, cancels, and joins. Repeated `close()` calls share their result.
- `close()` ignores expected cancellation but rejects genuine execution or finalizer failures. Jobs support `await using`.
- Natural body completion stops direct-child admission but does not cancel existing descendants.
- An ordinary child failure propagates to its owner and cancels siblings, even if the child is awaited and its rejection is caught. `execute()` and `timeout()` create lexical failure boundaries: catching their rejection leaves the enclosing Job usable.
- A Job cannot await itself or an ancestor. Its body may use `joinChildren()` to wait for descendants or `cancelChildren(reason)` to cancel and join them without cancelling itself.

`job.state` is `"created"`, `"running"`, `"closing"`, or `"closed"`. `job.parent` is its actual owner; `job.size` counts active direct children.

`await job.result()` returns a `JobResult<T>`: `{ ok: true, value }` on success or `{ ok: false, error }` on failure, including cancellation. It waits for the body and all descendants without throwing their execution errors. In contrast, `await job` and `job.join()` return the success value or throw the original error.

```ts
import { Job } from "@tiberjs/runner";

const job = new Job(() => 42).start();
const result = await job.result();

if (result.ok) {
  console.log(result.value);
} else {
  console.error(result.error);
}
```

Use `ok` to distinguish success from failure: both a successful value and a thrown error may be `undefined`. Self/ancestor observation is still an invalid lifecycle dependency; `result()` rejects that operation by throwing synchronously.

The body receives a single-use publisher. `Job<Result, Published = Result>` keeps the
published value's type separate from the body's eventual result. Publication remains
available after cancellation so a body can publish a mapped answer, and the publisher
accepts a promise when publication itself completes asynchronously:

```ts
const ended = Promise.withResolvers<void>();
const request = new Job<void, Response>(async (publish) => {
  publish(new Response("streaming"));
  await ended.promise;
});

request.start();
const response = await request.value(); // The Job is still running.
ended.resolve();
await request; // The complete lifetime.
```

`reconcileFailure(error)` replaces the Job's cancellation reason with genuine failures
already recorded from its descendants. An independent caught error and recorded failure
are preserved together in an `AggregateError`.

Use native `try/finally`, `using`, or `await using` for resources. Body-local cleanup has its ordinary lexical lifetime. If a resource must outlive an entire subtree, acquire it outside the awaited Job or `execute()` call.

## Supervision

A `Supervisor` manages an ordinary Job supplied by the caller. It directs submissions to that Job and applies failure policy. The application decides when initialization has finished and when to submit subsequent work.

```ts
import { addAbortListener } from "node:events";
import { readFile } from "node:fs/promises";
import { Job, Supervisor, signal } from "@tiberjs/runner";

const application = new Job(async () => {
  const stopped = Promise.withResolvers<void>();
  using registration = addAbortListener(signal(), () => stopped.resolve());
  await stopped.promise;
});

await using supervisor = new Supervisor(application, { failure: "isolate" });
supervisor.start({ parent: undefined }); // Explicitly choose an independent root.

// Initialization is ordinary owned work. The caller decides to await it first.
const packageInfo = await supervisor.run(async () => {
  const contents = await readFile(new URL("./package.json", import.meta.url), {
    encoding: "utf8",
    signal: signal(),
  });
  return JSON.parse(contents);
});

const packageName = await supervisor.run(() => packageInfo.name);
console.log(packageName);
// Leaving this scope closes the owner and joins all of its work.
```

The application Job does not reference its Supervisor. There is no separate preparation state or handshake: submissions are accepted whenever the owner is running and not cancelled. If initialization must precede other work, await that initialization before submitting it.

`Supervisor` must be attached before its Job starts. `start(options)` follows `Job.start(options)`: inside an execution it inherits the current owner and call-chain context; outside one it starts a root. Pass `{ parent: undefined }` to explicitly detach, or `{ parent: owner }` to select an owner. Repeated starts return the same supplied Job without running its body again.

`run(handler)`, `run(seed, handler)`, and `run(coldJob)` start direct children of the managed Job. These submissions inherit the owner's environment, not the submitter's context.

The default `failure: "isolate"` keeps a child failure from cancelling its owner or independent siblings. `failure: "fail-fast"` propagates it to the owner. Either way, the Job's result preserves the failure.

Logging, retries, and notifications belong to the caller. Observe `job.result()`, await the Job, or catch a group submission's rejection. Runner does not automatically log failures; an isolated Job whose result is ignored is not automatically reported.

`supervisor.state` is the managed Job's state. `flush()` joins children without closing the owner. `close()` delegates to that Job and waits for its body and descendants. `Supervisor` also supports `await using`.

## Declarative task groups

A `TaskGroup` is an immutable, nested declaration. It has no execution lifetime or cancellation signal. Submit it to a Supervisor with a running owner:

```ts
import { Job, TaskGroup } from "@tiberjs/runner";

// Within the scope above, while supervisor.job is running:
const plan = new TaskGroup([
  new TaskGroup([new Job(() => "A"), new Job(() => "B"), new Job(() => "C")]),
  new TaskGroup([new Job(() => "D"), new Job(() => "E")]),
]);

const result = await supervisor.run(plan);
// [["A", "B", "C"], ["D", "E"]]
```

All five leaves are actual children of `supervisor.job`. Nested groups do not add synthetic Jobs or owners. The result retains the declaration's nested shape and order.

- Each Job may occur only once and must still be cold. The entire declaration is checked before any member starts.
- The default group policy is `failure: "fail-fast"`: a genuine member failure cancels the group's other leaves and propagates through enclosing groups.
- A group with `{ failure: "isolate" }` stops that propagation without cancelling its siblings. Inner fail-fast groups still cancel their own leaves.
- A failure escaping all group boundaries follows the Supervisor's policy.
- Group completion joins every member and descendant, including cancelled finalizers. A genuine failure raised after an earlier cancellation still activates group policy.
- A failed group rejects with its genuine failure or an `AggregateError` for independent failures. A sole failure retains its identity; the caller decides how to handle it.

Declarations capture no ambient environment. Each leaf uses its explicit seed over the managed owner's context when activated. Since Jobs are single-use, a declaration containing already-started Jobs cannot be rerun.

## Immutable context

Context describes the execution environment; it is not an ownership node. Typed bindings use identity-based keys:

```ts
import {
  contextKey,
  currentState,
  execute,
  fork,
  provide,
  use,
  withContext,
} from "@tiberjs/runner";

const Tenant = contextKey<string>("tenant");

await execute({ values: [provide(Tenant, "outer")] }, async () => {
  const owner = currentState().job;
  await withContext([provide(Tenant, "inner")], async () => {
    console.log(currentState().job === owner); // true: no new Job
    console.log(use(Tenant)); // "inner"
    console.log(await fork(() => use(Tenant))); // "inner"
  });
  console.log(use(Tenant)); // "outer"
});
```

`withContext()` derives a frame for one call chain. Concurrent derivations do not overwrite one another or mutate the Job's initial context. Plain child activation inherits the current call-chain frame; explicit-owner submissions inherit the owner's frame.

`use(key)` returns a binding or `undefined`. `hasContext(key)` distinguishes absence from an explicit `undefined`. `requireContext(key)` throws `MissingContextError` when absent. Bound values are stored by reference, not deeply cloned or frozen.

`ContextFrame.from(entries)` constructs an independent frame; `frame.withEntries(entries)` derives one. A Job seed may supply entries to overlay inherited values, or a `ContextFrame` to replace them. Seeds may also supply `attachment`, `signal`, and an absolute `deadline`. Omitted fields inherit; an explicit attachment, including `undefined`, replaces the inherited attachment.

`currentState()` exposes `{ job, context }` for the active call chain. `context` contains `values`, the Job's signal, an optional deadline, and an attachment. `currentAttachment()` reads that attachment. `job.context` is available after activation; it is not a mutable cursor for later `withContext()` calls.

## Cancellation and deadlines

`signal()` returns the current Job's cancellation signal. Pass it to cancellable native APIs, and check it after awaits and before irreversible work. Runner cannot force uncooperative code to stop.

```ts
import { setTimeout } from "node:timers/promises";
import { execute, signal, timeout } from "@tiberjs/runner";

await execute(async () => {
  const value = await timeout(1_000, () => setTimeout(25, "ready", { signal: signal() }));
  console.log(value);
});
```

`deadline()` returns the current absolute deadline in epoch milliseconds. A seed deadline narrows the inherited deadline. `timeout(milliseconds, handler)` requires an active Job, creates a child boundary, and owns its timer through the completion of the entire subtree—not merely the body. Its promise settles only after cancelled descendants and finalizers finish.

Cancellation reasons and genuine errors retain their original identity and cause. A rejection identical to the current signal reason, or Node's signal-related `AbortError` with code `ABORT_ERR` and that reason as its cause, is expected cancellation. A different application error is not cancellation merely because its cause references that reason. Independent execution failures are aggregated rather than replacing one another.
