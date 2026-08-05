// test/integration/**/*.test.ts runs in real Node (the `node` vitest
// project in vitest.config.ts, not workerd), so `process.env` there is the
// genuine Node global. This project's tsconfig does not include `@types/node`
// in `types` — `src` and the `workers` project run in workerd, where pulling
// in the full Node global surface would be misleading — so `process` is
// otherwise unresolvable to the type checker. Declare only the shape this
// project's node-project tests actually read.
declare const process: { env: Record<string, string | undefined> }
