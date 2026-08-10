// test/integration/**/*.test.ts runs in real Node (the `node` vitest
// project in vitest.config.ts, not workerd), so `process.env` there is the
// genuine Node global. This project's tsconfig does not include `@types/node`
// in `types` — `src` and the `workers` project run in workerd, where pulling
// in the full Node global surface would be misleading — so `process` is
// otherwise unresolvable to the type checker. Declare only the shape this
// project's node-project tests actually read.
//
// `on`/`off` are here for one test — test/unit/client.test.ts's unhandled-
// rejection guard around the transactor's commit wrapper. That is a *unit*
// test, so it runs in workerd, where `unhandledRejection` is nonetheless
// reported through this same Node-compat `process` (verified: the guard fails
// with the listener's payload when the fix's rejection handler is removed).
// Typed loosely on purpose — a precise Node `EventEmitter` signature would
// invite the rest of the Node global surface back in, which the paragraph
// above is about keeping out.
declare const process: {
  env: Record<string, string | undefined>
  execPath: string
  on(event: string, listener: (arg: unknown) => void): void
  off(event: string, listener: (arg: unknown) => void): void
}
