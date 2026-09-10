# Working on @tiberjs/runner

`@tiberjs/runner` is the transport-independent execution runtime for TiberJS. It owns immutable execution context, structured tasks, dependency injection, application lifecycle, events, validation primitives, and generic tracing.

## Repository boundary

- `src/context/`: immutable context frames and typed keys.
- `src/runtime/`: execution state, task groups, cancellation, deadlines, forks, defers, and spans.
- `src/di/`: scopes, tokens, ambient injection, resource startup/disposal, and resolution graphs.
- `src/events/`: application events and the event bus.
- `src/lifecycle/`: application startup, drain, and shutdown ownership.
- `src/validation/`: transport-independent Standard Schema contracts.
- `src/decorators/`: execution decorators only.
- `tests/`: public behavior and lifecycle boundary tests.

Runner must not import server, HTTP, WebSocket, gRPC, broker, scheduler, or optional feature packages. Do not introduce transport messages, routes, requests, responses, sockets, status codes, or broker acknowledgements here. `reflect-metadata` is not a runner dependency.

## Public contracts

- Execution starts through `begin`/`execute`; bindings attach native payloads through the execution state.
- `TaskGroup` owns child tasks. Await, return, or explicitly attach asynchronous work to an owner.
- `Scope` owns dependency identity and resources. Startup is dependency ordered; disposal is LIFO and preserves operation plus cleanup failures.
- `ApplicationLifecycle` owns its scope, event bus, startup, drain callbacks, and close sequence.
- Context is immutable. Derive it with `provide(...)`; never introduce a mutable request-style bag.
- Cancellation and deadlines are live state. Recheck them after awaits and before commitment points.
- Validation delegates to Standard Schema. Do not build a runner-specific validator.
- Preserve native error identity and `cause`; use `AggregateError` when independent operation and cleanup failures both matter.

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
| `pnpm build`                     | Clean and compile `dist`          |
| `pnpm test`                      | Run the runner suite              |
| `pnpm pack`                      | Verify the publish artifact       |

ESM uses `NodeNext`; relative imports include `.js`. Do not add a second formatter or linter configuration. Import sorting stays disabled because side-effect ordering can be significant.

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

## Tests and verification

- Test public behavior, ownership, transitions, cancellation, cleanup ordering, and simultaneous failures.
- Observe rejections before triggering cancellation or failure.
- Keep fake clocks, shared scopes, and global tracer changes isolated.
- A test must fail for a plausible regression; do not assert private wiring or incidental wording.
- After a behavioral change run `pnpm format`, `pnpm check`, `pnpm build`, and the relevant tests. Run the full suite for cross-cutting runtime changes.
- Publishing must use built `dist`; consumers must not depend on repository source conditions.
