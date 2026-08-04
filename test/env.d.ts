declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    HYPERDRIVE_MYSQL: Hyperdrive
    HYPERDRIVE_PG: Hyperdrive
    // Forwarded from process.env via vitest.config.ts's miniflare.bindings —
    // test bodies run inside workerd, where process.env does not carry host
    // environment variables. See docs/superpowers/notes/2026-08-04-workerd-spike.md.
    MYSQL_URL: string
  }
}
