# Working on @tiberjs/runner

`@tiberjs/runner` is the transport-independent execution runtime for TiberJS. Its core is Job ownership, optional supervision, declarative task groups, and immutable execution context.

## Repository boundary

- `src/job/`: the Job ownership/completion kernel, composed failure storage, cancellation registrations/classification, and deadlines.
- `src/supervisor/`: Supervisor admission/failure policy, immutable TaskGroup declarations, and composed group planning/execution.
- `src/execution/`: `execute`, `fork`, and `timeout` entry points plus the ALS bridge between a Job and its call-chain context.
- `src/execution/context/`: immutable frames, typed keys, execution environment types, and binding access. These are execution-environment values, not Job ownership nodes.
- `src/errors.ts`: state/dependency errors and failure aggregation.
- `tests/`: public behavior and lifecycle boundary tests.

Runner must not import server, HTTP, WebSocket, gRPC, broker, scheduler, or optional feature packages. Do not introduce transport messages, routes, requests, responses, sockets, status codes, or broker acknowledgements here. `reflect-metadata` is not a runner dependency.

## Public contracts

- `Job` is a cold, single-use execution and awaitable lifetime node. It settles only after its body and actual descendants finish.
- `HandoffJob` is a Job whose body offers one value and suspends until resumed. The handoff is rendezvous state released by the Job's cancellation and closure; it owns no lifetime, signal, or queue.
- `Supervisor` manages a supplied ordinary Job. It does not create hidden startup, background, or shutdown owners.
- `Supervisor.start(options)` follows `Job.start(options)` ownership and context rules. Use `{ parent: undefined }` to explicitly select an independent root; Supervisor state is its Job state.
- Applications own initialization order and error reporting. Do not add readiness handshakes, automatic logging, or reporting callbacks to the execution core.
- `TaskGroup` is an immutable nested declaration, not a lifetime owner. Submitted leaves belong directly to the Supervisor's Job.
- `execute()` and `fork()` create real Jobs. There is no separate Task handle or compatibility lifecycle layer.
- Context frames are independent of ownership. `withContext()` changes the call-chain environment without creating a Job.
- Compose support state without duplicating ownership: `FailureSet` stores errors, `CancellationBindings` releases registrations, and `GroupRunner` applies declaration policy. None owns a Job lifetime, creates an AbortController, or stores independent completion state.
- Do not restore DI, EventBus, tracing, or legacy APIs to this core.
- Context is immutable. Derive it with `provide(...)`; never introduce a mutable request-style bag.
- Cancellation and deadlines are live state. Recheck them after awaits and before commitment points.
- An external cancellation source is linked lazily: reading `job.signal`, `signal()`, or `context.signal`, and starting a child, are the observation points that subscribe. Internal bookkeeping reads the controller's signal and never subscribes. Already-aborted sources are honored by synchronous rechecks before the body, after it, and before a handoff offer.
- Preserve native error identity and `cause`; use `AggregateError` when independent operation and cleanup failures both matter.
- Cancellation classification accepts the original signal reason or a Node-style `AbortError` with `code: "ABORT_ERR"` and matching `cause`. An ordinary application error remains a failure even when its cause is the cancellation reason.

## Toolchain

Use Node 24 and the pnpm version pinned in `package.json`. Run commands from the repository root:

| Command                          | Purpose                           |
| -------------------------------- | --------------------------------- |
| `pnpm install --frozen-lockfile` | Reproduce dependencies            |
| `pnpm lint`                      | Run Oxlint; warnings fail         |
| `pnpm format`                    | Format maintained files           |
| `pnpm format:check`              | Check formatting                  |
| `pnpm typecheck`                 | Typecheck source and tests        |
| `pnpm check`                     | Lint, format check, and typecheck |
| `pnpm build`                     | Bundle ESM and emit declarations  |
| `pnpm test`                      | Run the runner suite              |
| `pnpm pack`                      | Verify the publish artifact       |

The public package is an ESM bundle built by Rspack; TypeScript emits declarations after bundling. Relative source imports include `.js` for NodeNext resolution. Do not add a second formatter or linter configuration. Import sorting stays disabled because side-effect ordering can be significant.

## Publishing

The `Publish` workflow runs only from `main`, rebuilds and retests the package,
then authenticates through npm trusted publishing with GitHub OIDC. It has
`id-token: write` and must not receive `NPM_TOKEN` or `NODE_AUTH_TOKEN`. After the
bootstrap release creates the package, register repository `tiberjs/runner`,
workflow `publish.yml`, and GitHub environment `npm` as the package's trusted
publisher. Bump `package.json` before dispatching; publishing an existing version
must fail.

## Implementation rules

- Establish public input, output, ownership, failure, and post-failure state before changing a boundary.
- Validate reusable configuration at construction or registration time, before mutating runtime state.
- Separate validation/preparation from mutation and delivery. Define the unit of commitment.
- Prefer `Record` for static string-keyed tables and `Map`/`Set` for dynamic membership.
- Prefer `Promise.withResolvers()` for deferred promises.
- Avoid allocation, copying, and repeated computation on execution paths.
- Use logical paragraph breaks. Extract helpers for real responsibilities, not line-count targets.
- Remove obsolete exports and call paths instead of retaining compatibility shims.

## Review before handing off

Every change ends with these three passes; they are not optional cleanup.

- Responsibility: each module, class, and function owns one thing and its name says which. A helper that only forwards, a field that duplicates state held elsewhere, or a method exposed only so another internal caller can reach it is a smell to remove, not to document.
- Comments: a comment states an invariant, an ownership rule, or a non-obvious reason. Delete comments that narrate the code, repeat a name, or describe behavior the change removed. A stale comment is a bug.
- Documentation: `README.md` describes the current contract. When behavior, ownership, options, or a lifecycle rule changes, update the prose and examples in the same change, and remove text that describes the old model.

## Tests and verification

- Test public behavior, ownership, transitions, cancellation, cleanup ordering, and simultaneous failures.
- Observe rejections before triggering cancellation or failure.
- Keep fake clocks and asynchronous test resources isolated.
- A test must fail for a plausible regression; do not assert private wiring or incidental wording.
- After a behavioral change run `pnpm format`, `pnpm check`, `pnpm build`, and the relevant tests. Run the full suite for cross-cutting runtime changes.
- Publishing must use built `dist`; consumers must not depend on repository source conditions.
