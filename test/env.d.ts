declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    HYPERDRIVE_MYSQL: Hyperdrive
    HYPERDRIVE_PG: Hyperdrive
    // Forwarded from process.env via vitest.config.ts's miniflare.bindings —
    // test bodies run inside workerd, where process.env does not carry host
    // environment variables. See the comment on that binding for the full
    // rationale (including why the fallback is `''`, not a URL).
    MYSQL_URL: string
  }
}
