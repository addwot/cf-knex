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
    // List every shape that was set, not just the first two — with three
    // set, naming only two leaves the caller to fix one, resubmit, and hit
    // this same error again for the third.
    throw new CfKnexError(
      'AMBIGUOUS_CONNECTION',
      `ambiguous connection — received ${present.map((shape) => `'${shape}'`).join(', ')}; pass one, or set driver explicitly`,
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
  if (config.binding !== undefined) {
    // The rule is "binding is a D1Database", not "binding is present" — a
    // KV or R2 binding dropped into the wrong config field (an easy mistake
    // in a Workers project with several binding types) must fail here, with
    // a message that says what's wrong, rather than defer to a raw
    // `TypeError` deep inside the adapter the first time it's used.
    if (!isD1Binding(config.binding)) {
      throw new CfKnexError('UNKNOWN_DRIVER', "binding is not a D1Database — expected an object with a 'prepare' method")
    }
    return 'd1'
  }
  if (config.hyperdrive !== undefined) return config.engine === 'postgres' ? 'pg' : 'mysql2'
  if (config.connection !== undefined) return config.engine === 'postgres' ? 'pg' : 'mysql2'

  const url = config.url
  // Unreachable at runtime: inferDriver already confirmed exactly one
  // connection shape is present, and the three branches above consumed
  // binding/hyperdrive/connection, so url is the one left. This exists only
  // to narrow `config.url` from `string | undefined` to `string` for
  // TypeScript below.
  if (url === undefined) throw new CfKnexError('NO_CONNECTION', 'no connection URL supplied')

  const scheme = schemeOf(url)

  if (config.authToken !== undefined) {
    // libsql is the only driver that takes an authToken. A mysql/postgres
    // url alongside one isn't a libsql url with an extra field — it's the
    // wrong url, most plausibly pasted from a different environment's
    // config. This package throws on anything unresolvable rather than
    // silently guessing, and guessing 'libsql' here would pass validation
    // and fail much later, unactionably, inside the adapter instead.
    if (scheme === 'mysql' || scheme === 'postgres' || scheme === 'postgresql') {
      throw new CfKnexError(
        'UNKNOWN_DRIVER',
        `authToken was supplied together with a '${scheme}://' url ('${redact(url)}') — libsql needs a 'libsql://' or 'https://' url`,
      )
    }
    return 'libsql'
  }
  if (scheme === 'libsql') return 'libsql'
  if (hostOf(url).endsWith('.tidbcloud.com')) return 'tidb-http'
  if (scheme === 'mysql') return 'mysql2'
  if (scheme === 'postgres' || scheme === 'postgresql') return 'pg'

  throw new CfKnexError('UNKNOWN_DRIVER', `cannot infer a driver from url '${redact(url)}' — set driver explicitly`)
}

export function isD1Binding(binding: unknown): binding is { prepare: (...args: never[]) => unknown } {
  return typeof binding === 'object' && binding !== null && typeof (binding as { prepare?: unknown }).prepare === 'function'
}

function hostOf(url: string): string {
  try {
    // The URL Standard always lowercases the host on parse, so this needs
    // no separate case-normalization the way the scheme does below.
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// URI schemes are case-insensitive (RFC 3986 §3.1); `new URL(...).protocol`
// already lowercases it, but the checks below run before/around a `new
// URL()` call and compare against several scheme names, so normalizing once
// here (rather than lowercasing — or not — at each comparison site) is what
// makes 'MYSQL://' and 'Postgres://' behave the same as their lowercase
// forms everywhere this is used.
function schemeOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)
  // The capture group always exists when `match` is non-null — the regex has
  // exactly one, unconditional group — but `noUncheckedIndexedAccess` can't
  // know that, so it types `match[1]` as possibly undefined regardless.
  return match ? (match[1] ?? '').toLowerCase() : ''
}

// Consumes every "chunk@" repetition in the authority, not just the first.
// A password containing a literal `@` (e.g. from an unescaped
// `${user}:${password}@${host}` interpolation, which is a common way to end
// up with one) has more than one `@` before the host; matching only the
// first left everything from the second `@` onward — including the rest of
// the password — exposed in the output. The `+` is what fixes that: the
// group matches greedily up to, but never past, the first `/` after the
// scheme, so a later `@` in the path or query is untouched either way.
//
// The scheme and `//` are both optional (`?`, not required) because
// `config.url` is an unvalidated string, and a caller can hand this
// function something that isn't a well-formed absolute URL at all — e.g. a
// template literal that lost its `scheme://` prefix. Requiring `scheme://`
// to match at all made a schemeless url fall all the way through
// unredacted, which is worse than any of the cases above: the whole
// userinfo, not just part of it, reached the message verbatim. `u:` at the
// very start of a schemeless url is genuinely indistinguishable from a
// real scheme — that's fine, since it's the username, not the password,
// that ends up in the clear.
//
// The second replace exists because userinfo is not the only place a
// credential rides in a url, and the messages this feeds are the ones a
// caller with a *wrong* url reaches — precisely the case where the url is
// something other than the driver expected. Turso/libsql is the concrete
// example: `https://db-org.turso.io/?authToken=eyJ...` carries the whole
// bearer token in the query and has no userinfo at all, so the first
// replace leaves it completely untouched and the token lands verbatim in
// "cannot infer a driver from url '…'".
//
// Every query *value* goes, not a list of credential-looking parameter
// names. A name blocklist is wrong by construction here: this function's
// contract is "safe to put in an error message", and a blocklist can only
// ever promise "safe unless the parameter is called something I didn't
// think of". Parameter names survive, which is where the diagnostic value
// actually is — a caller needs to see *that* they passed `authToken`, never
// what it was. `[^&]*` deliberately does not stop at a second `?`, so a
// malformed query over-redacts rather than under-redacts.
function redact(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:)?(\/\/)?(?:[^/@]*@)+/i, (_m, scheme, slashes) => `${scheme ?? ''}${slashes ?? ''}***@`)
    .replace(/([?&][^=&]*=)[^&]*/g, '$1***')
}
