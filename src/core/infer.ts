import { CfKnexError } from './errors'
import type { ClientConfig, DriverName, Engine } from './types'

const VALID: Record<Engine, DriverName[]> = {
  mysql: ['mysql2', 'tidb-http'],
  postgres: ['pg'],
  sqlite: ['d1', 'libsql'],
}

const SHAPES = ['url', 'connection', 'hyperdrive', 'binding'] as const

/**
 * Picks the driver a `ClientConfig` implies, or throws `CfKnexError` if the
 * config is ambiguous (more than one connection shape) or impossible (none,
 * or an explicit driver that doesn't belong to the given engine). Pure: no
 * I/O, no network probing — inference reads only the shape of `config`.
 */
export function inferDriver(config: ClientConfig): DriverName {
  const present = SHAPES.filter((k) => config[k] !== undefined)

  if (present.length === 0) {
    throw new CfKnexError('NO_CONNECTION', "no connection — pass one of 'url', 'connection', 'hyperdrive' or 'binding'")
  }
  if (present.length > 1) {
    const [a, b] = present
    throw new CfKnexError(
      'AMBIGUOUS_CONNECTION',
      `ambiguous connection — received both '${a}' and '${b}'; pass one, or set driver explicitly`,
    )
  }

  const driver = config.driver ?? infer(config)

  if (!VALID[config.engine].includes(driver)) {
    throw new CfKnexError(
      'INVALID_ENGINE_DRIVER',
      `driver '${driver}' is not valid for engine '${config.engine}' (valid: ${VALID[config.engine].join(', ')})`,
    )
  }
  return driver
}

function infer(config: ClientConfig): DriverName {
  if (config.binding !== undefined) return 'd1'
  if (config.hyperdrive !== undefined) return config.engine === 'postgres' ? 'pg' : 'mysql2'
  if (config.connection !== undefined) return config.engine === 'postgres' ? 'pg' : 'mysql2'

  const url = config.url
  // Unreachable at runtime: inferDriver already confirmed exactly one
  // connection shape is present, and the three branches above consumed
  // binding/hyperdrive/connection, so url is the one left. This exists only
  // to narrow `config.url` from `string | undefined` to `string` for
  // TypeScript below.
  if (url === undefined) throw new CfKnexError('NO_CONNECTION', 'no connection URL supplied')
  if (config.authToken !== undefined || url.startsWith('libsql://')) return 'libsql'
  if (hostOf(url).endsWith('.tidbcloud.com')) return 'tidb-http'
  if (url.startsWith('mysql://')) return 'mysql2'
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'pg'

  throw new CfKnexError('UNKNOWN_DRIVER', `cannot infer a driver from url '${redact(url)}' — set driver explicitly`)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// Matches userinfo only inside the authority (scheme://user:pass@host), never
// past the first `/` or `?`. An earlier, unanchored version of this regex
// (`/\/\/[^@]*@/`) let `[^@]*` cross slashes and matched the *last* `@` in
// the whole string, so `https://x.turso.io/db?t=a@b` corrupted to
// `https://***@b` — not a redaction. This string reaches error messages and
// logs, so a leaked or mangled password here is a real defect either way.
export function redact(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@')
}
