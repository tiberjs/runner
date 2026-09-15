# @tiberjs/runner

Structured concurrency for Node.js: every piece of asynchronous work is a **Job** that owns the work it starts, settles only after all of it has finished, and is cancelled together with it.

Requires Node.js 24 or newer. ESM only.

```sh
pnpm add @tiberjs/runner
```

## The model in one paragraph

A Job runs a body. Anything the body starts — with `fork()`, `execute()`, `timeout()`, or a Supervisor — becomes a child of that Job. A Job does not finish when its body returns; it finishes when its body **and every descendant** have finished, finalizers included. Cancelling a Job cancels its subtree. A child that fails cancels its siblings and fails its owner. Nothing runs detached by accident: work that must outlive its Job is submitted explicitly to another owner.

The code that runs inside a Job sees its environment through a small ambient API: `signal()` for cancellation, `deadline()` for its time budget, `use(key)` for typed context values. None of that is passed by hand.

```ts
import { execute, fork, signal, use } from "@tiberjs/runner";

const total = await execute(async () => {
  const a = fork(() => fetchPart(1, { signal: signal() }));
  const b = fork(() => fetchPart(2, { signal: signal() }));
  return (await a) + (await b);
});
// execute() resolves only after both children have settled.
// If one child throws, the other is cancelled and execute() rejects with the failure.
```

## Jobs

A `Job` is an execution and its awaitable lifetime. Construction is cold: it neither runs the body nor captures the current context. `start()` activates it once.

```ts
import { Job } from "@tiberjs/runner";

const job = new Job(() => 42);
job.start();
console.log(await job); // 42
```

### Ownership

- `fork(body)` starts a child of the current Job. `new Job(body).start()` does the same inside an execution and starts an independent root outside one.
- `start({ parent })` selects an explicit owner and inherits that owner's context. `start({ parent: undefined })` starts a root deliberately.
- `job.parent` is the actual owner; `job.size` counts active direct children.
- A Job cannot await itself or an ancestor; that is a `LifecycleDependencyError`. Inside a body, use `joinChildren()` to wait for descendants, or `cancelChildren(reason)` to cancel and join them without cancelling the Job itself.

### Lifecycle

`job.state` moves through `"created"` → `"running"` → `"closing"` → `"closed"`.

- When the body returns, the Job stops admitting new direct children and waits for the existing ones. It does not cancel them.
- `finish()` closes admission and joins without cancelling. `close(reason)` closes admission, cancels, and joins. Repeated `close()` calls share one result. Jobs support `await using`.
- `cancel(reason)` requests cooperative cancellation of the subtree. It returns immediately; the work has not necessarily stopped.

### Observing the result

- `await job` and `job.join()` return the body's value or throw the original error. Awaiting a cold Job rejects; awaiting never starts it.
- `await job.result()` returns `{ ok: true, value }` or `{ ok: false, error }` and never throws for execution errors. Use `ok` to tell the cases apart: both a value and a thrown error may be `undefined`.
- `close()` resolves on expected cancellation and rejects on genuine execution or finalizer failures.

```ts
const result = await new Job(() => 42).start().result();
if (result.ok) {
  console.log(result.value);
} else {
  console.error(result.error);
}
```

### Failure

- An ordinary child failure is recorded on its owner and cancels the owner's other children — even if the child was awaited and its rejection caught.
- `execute()` and `timeout()` are lexical failure boundaries: catching their rejection leaves the enclosing Job usable.
- Independent failures (for example a body error and a finalizer error) are kept together in an `AggregateError`; a sole failure keeps its identity.
- `reconcileFailure(error)` replaces a caught cancellation reason with the genuine failures already recorded from descendants. Use it where a body catches its own cancellation but must report why the subtree really failed.

Use native `try/finally`, `using`, or `await using` for resources. Body-local cleanup has its ordinary lexical lifetime; a resource that must outlive a subtree is acquired outside the awaited Job or `execute()` call.

## Cancellation and deadlines

`signal()` returns the current Job's `AbortSignal`. Pass it to cancellable native APIs and check it after awaits and before irreversible work. Runner cannot force uncooperative code to stop.

```ts
import { setTimeout } from "node:timers/promises";
import { execute, signal, timeout } from "@tiberjs/runner";

await execute(async () => {
  const value = await timeout(1_000, () => setTimeout(25, "ready", { signal: signal() }));
  console.log(value);
});
```

- `deadline()` returns the current absolute deadline in epoch milliseconds, if any. A seed deadline only narrows the inherited one.
- `timeout(ms, body)` creates a child boundary that owns its timer through the completion of the entire subtree, not merely the body. Its promise settles only after cancelled descendants and finalizers finish.
- A Job seeded with an external `signal` follows it: an abort before the body runs cancels the Job without running it; an abort during the body yields a cancelled result. The subscription itself is made lazily, the first time the Job's cancellation is observed — a `signal()` read or a child start — so a Job nobody observes registers no listener.
- Cancellation classification is strict. A rejection that _is_ the signal reason, or Node's `AbortError` with `code: "ABORT_ERR"` and that reason as `cause`, is expected cancellation. An application error is not cancellation merely because its `cause` references the reason.

## Context

Context is the execution environment, not an ownership node. Bindings use identity-based keys and are immutable: a derived frame shadows the parent without changing it, so concurrent branches never see each other's values.

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
    console.log(currentState().job === owner); // true: withContext creates no Job
    console.log(use(Tenant)); // "inner"
    console.log(await fork(() => use(Tenant))); // "inner": children inherit the call-chain frame
  });
  console.log(use(Tenant)); // "outer"
});
```

- `use(key)` returns the binding or `undefined`. `hasContext(key)` distinguishes absence from an explicit `undefined`. `requireContext(key)` throws `MissingContextError` when absent.
- Bound values are stored by reference; they are not cloned or frozen.
- A **seed** (`ExecutionSeed`) is what a Job is started with: `values` (entries to overlay, or a `ContextFrame` to replace inherited values), an `attachment`, an external `signal`, and an absolute `deadline`. Omitted fields inherit. An explicit `attachment`, including `undefined`, replaces the inherited one.
- `currentState()` exposes `{ job, context }` for the active call chain; `context` carries `values`, the Job's `signal`, the `deadline`, and the `attachment`. `currentAttachment()` reads the attachment directly. `job.context` is available after activation and is not a cursor for later `withContext()` calls.
- `ContextFrame.from(entries)` builds an independent frame; `frame.withEntries(entries)` derives one.

## Supervisor

A `Supervisor` manages a Job the caller supplies, submits work to it, and applies a failure policy. It creates no hidden owner: `supervisor.job` is the owner, and every submission is a direct child of it.

```ts
import { addAbortListener } from "node:events";
import { readFile } from "node:fs/promises";
import { Job, Supervisor, signal } from "@tiberjs/runner";

// The owner's body runs until it is cancelled — by close() below.
const application = new Job(async () => {
  const stopped = Promise.withResolvers<void>();
  using registration = addAbortListener(signal(), () => stopped.resolve());
  await stopped.promise;
});

await using supervisor = new Supervisor(application, { failure: "isolate" });
supervisor.start({ parent: undefined }); // an independent root

// Initialization is ordinary owned work; the caller awaits it before depending on it.
const packageInfo = await supervisor.run(async () => {
  const contents = await readFile(new URL("./package.json", import.meta.url), {
    encoding: "utf8",
    signal: signal(),
  });
  return JSON.parse(contents);
});

console.log(await supervisor.run(() => packageInfo.name));
// Leaving this scope closes the owner and joins all of its work.
```

- Attach the Supervisor before its Job starts. `start(options)` follows `Job.start(options)`; repeated starts return the same Job without running its body again.
- `run(body)`, `run(seed, body)`, and `run(coldJob)` start direct children of the managed Job. They inherit the **owner's** environment, not the submitter's.
- Submissions are accepted whenever the owner is running and not cancelled. There is no readiness handshake: if initialization must precede other work, await it first.
- `failure: "isolate"` (the default) keeps a child failure from cancelling the owner or its other children. `failure: "fail-fast"` propagates it to the owner. Either way the failed Job's result preserves the failure.
- `flush()` joins children without closing the owner. `close()` closes the owner and waits for its subtree. `supervisor.state` is the owner's state. Supervisors support `await using`.
- Nothing is logged automatically. Observe results, await Jobs, or catch rejections; an isolated failure whose result nobody reads is not reported.

## Task groups

A `TaskGroup` is an immutable, nested declaration of cold Jobs. It has no lifetime and no signal of its own; submitting it to a Supervisor starts every leaf as a direct child of the owner and returns results in the declaration's shape.

```ts
import { Job, TaskGroup } from "@tiberjs/runner";

const plan = new TaskGroup([
  new TaskGroup([new Job(() => "A"), new Job(() => "B"), new Job(() => "C")]),
  new TaskGroup([new Job(() => "D"), new Job(() => "E")]),
]);

const result = await supervisor.run(plan);
// [["A", "B", "C"], ["D", "E"]]
```

- Each Job may appear once and must be cold; the whole declaration is validated before any leaf starts. Jobs are single-use, so a declaration cannot be rerun.
- The default group policy is `failure: "fail-fast"`: a genuine member failure cancels the group's other leaves and propagates through enclosing groups. `{ failure: "isolate" }` stops that propagation at the group boundary; inner fail-fast groups still cancel their own leaves. A failure escaping every group follows the Supervisor's policy.
- Completion joins every member and descendant, including cancelled finalizers. A failed group rejects with its genuine failure, or an `AggregateError` for independent ones.
- Leaves capture no ambient environment: each uses its own seed over the owner's context.

## FlexJob

A `FlexJob<Result, Update>` is an ordinary Job whose body can publish intermediate values through a bounded channel. `publish(value)` is synchronous: it delivers to a waiting receiver or stores the value, then the body continues without waiting for consumption or an acknowledgement. `await job` and `job.result()` retain the ordinary Job contract and wait for the body, descendants, and finalizers.

```ts
import { FlexJob } from "@tiberjs/runner";

type Update = { phase: "started" | "processed" };

const job = new FlexJob<string, Update>(async (publish) => {
  publish({ phase: "started" });
  await doWork();
  publish({ phase: "processed" });
  return "finished";
});

job.start();
const update = await job.receive(); // { done: false, value: Update }, or channel completion
const result = await job.result(); // { ok: true, value: "finished" }, or { ok: false, error }
```

### Buffering and overflow

The default capacity is **one**, with `overflow: "drop-oldest"`: an unread value is replaced by the latest publication. A publication stays available even if no receiver was waiting when it was sent. Unlike a Promise, each value is consumed once and the channel can deliver subsequent values. This is useful for latest-state observations; it does not preserve every event.

Use `FlexJob.withBuffer(capacity, body, options?)` to retain multiple unread values in FIFO order. Overflow behavior is explicit configuration:

```ts
const job = FlexJob.withBuffer<string, Update>(
  10,
  async (publish) => {
    publish({ phase: "started" });
    await doWork();
    publish({ phase: "processed" });
    return "finished";
  },
  { overflow: "drop-oldest" },
);
```

| `overflow`                | When the buffer is full                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `"drop-oldest"` (default) | Remove the oldest unread value and retain the new one                |
| `"drop-newest"`           | Discard the new value and retain existing unread values              |
| `"error"`                 | Throw `RangeError` from `publish()`; an uncaught error fails the Job |

Capacity must be an integer from 1 through 4294967295. Buffer storage grows as values are published, rather than preallocating the entire capacity. None of the policies waits for a receiver. If every event matters, choose adequate capacity and `"error"` so overflow is reported rather than silently dropping events.

`new FlexJob(body, options?)` also accepts `{ capacity, overflow, seed }`. `withBuffer()` takes the same options except `capacity`, which is its first argument. `seed` is an ordinary `ExecutionSeed`; start, ownership, context, failure propagation, and Supervisor submission follow `Job` rules.

### Receiving, completion, and cancellation

- `receive({ signal? })` returns `{ done: false, value }` for an update or `{ done: true, value: undefined }` after successful channel completion. An update may itself be `undefined`; use `done` to distinguish it from completion.
- Each update goes to **one** receiver. Concurrent receives consume successive values in request order; this is a queue, not broadcast or replay for each subscriber. A receive can be registered before the cold Job starts, but never starts the Job itself.
- Aborting a receive's signal rejects only that receive with its reason and removes its cancellation listener. It does not cancel the Job, discard a queued value, or stop other receivers. An already-aborted signal rejects without consuming a value.
- Returning from the body closes publication and preserves buffered values for draining. Once drained, receives report channel completion. Captured `publish` callbacks cannot publish after the body ends, including from descendants that outlive the body.
- A body failure or Job cancellation discards buffered progress and rejects pending receives. Cancellation stays connected from construction until the whole Job settles, including before start and while descendants outlive the body. Receivers are released even while uncooperative work has not stopped; the Job still waits for its actual lifetime.
- Channel completion is not proof of whole-Job success. Descendants can still fail after the body returns. Always observe `job.result()` or `await job` for the final outcome and composed failures. Later receives reflect a failed final outcome; an earlier receive cannot be revised.
- A Job cannot receive from itself or an ancestor; that throws `LifecycleDependencyError` synchronously.

To bound an observation without terminating the producer, pass a separate observation signal to `receive()`:

```ts
const update = await job.receive({ signal: AbortSignal.timeout(5_000) });
// If this receive times out, the Job keeps running and publishing under its existing owner.
```

## HandoffJob (deprecated)

`HandoffJob` and `Handoff` are deprecated. Prefer FlexJob for intermediate publications. Existing handoffs retain their one-shot, two-way behavior; FlexJob does not provide `resume()` responses or suspend publication until an acknowledgement. Applications migrating an acknowledgement-dependent handoff must explicitly keep that exchange in their body rather than simply replacing `offer()` with `publish()`.

Sometimes a Job must hand a value to someone else _before_ it is done — an HTTP exchange publishes its response, then keeps owning cleanup until delivery is acknowledged. `HandoffJob` models that as a one-shot, two-way rendezvous inside an ordinary Job lifetime.

```ts
import { HandoffJob } from "@tiberjs/runner";

const exchange = new HandoffJob<void, Response, "delivered" | "aborted">(async (handoff) => {
  const response = await prepare();
  const outcome = await handoff.offer(response); // suspended until resume()
  await release(outcome);
});

exchange.start();
const response = await exchange.receive(); // the Job is still running
exchange.resume(await deliver(response));
await exchange; // body and descendants have settled
```

- `offer()` and `resume()` each accept one call; a second throws `TypeError`.
- A body that returns without offering fails. A Job that closes before offering rejects `receive()` with its failure.
- Cancelling the Job rejects a pending `offer()` with the reason. An offer made after cancellation still reaches `receive()` but rejects for the body; a `resume()` after release is discarded.
- An external `signal` that already aborted rejects the offer. One that aborts _during_ the suspension releases it only if the body observed `signal()` first; otherwise the consumer's `resume()` ends the suspension and the Job's result still reports the cancellation.
- `receive()` rejects self/ancestor observation synchronously, like `result()`.

## API summary

| Export                                                                                    | Role                                                                              |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Job`, `FlexJob`                                                                          | An execution and its lifetime; FlexJob also publishes bounded intermediate values |
| `HandoffJob`, `Handoff`                                                                   | Deprecated one-shot, two-way handoff                                              |
| `execute`, `fork`, `timeout`                                                              | Start a child: awaited boundary, background child, deadline-bounded boundary      |
| `Supervisor`, `TaskGroup`                                                                 | Submit work to a supplied owner; declare nested groups of cold Jobs               |
| `signal`, `deadline`, `use`, `hasContext`, `requireContext`, `withContext`                | Ambient environment of the running Job                                            |
| `contextKey`, `provide`, `ContextFrame`                                                   | Typed context bindings                                                            |
| `currentState`, `currentAttachment`, `peekState`, `runWith`                               | Runtime state access for integrations                                             |
| `combinedError`, `LifecycleStateError`, `LifecycleDependencyError`, `MissingContextError` | Errors                                                                            |
