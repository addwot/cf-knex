import { CfKnexError } from './errors'
import type { ClientConfig, DriverName, Engine } from './types'

const VALID: Record<Engine, DriverName[]> = {
  mysql: ['mysql2', 'tidb-http'],
  postgres: ['pg'],
  sqlite: ['d1', 'libsql'],
}

const SHAPES = ['url', 'connection', 'hyperdrive', 'binding'] as const

export function inferDriver(config: ClientConfig): DriverName {
  const present = SHAPES.filter((k) => config[k] !== undefined)

  if (present.length === 0) {
    throw new CfKnexError('NO_CONNECTION', "no connection — pass one of 'url', 'connection', 'hyperdrive' or 'binding'")
  }
  if (present.length > 1) {
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
    if (!isD1Binding(config.binding)) {
      throw new CfKnexError('UNKNOWN_DRIVER', "binding is not a D1Database — expected an object with a 'prepare' method")
    }
    return 'd1'
  }
  if (config.hyperdrive !== undefined) return config.engine === 'postgres' ? 'pg' : 'mysql2'
  if (config.connection !== undefined) return config.engine === 'postgres' ? 'pg' : 'mysql2'

  const url = config.url
  if (url === undefined) throw new CfKnexError('NO_CONNECTION', 'no connection URL supplied')

  const scheme = schemeOf(url)

  if (config.authToken !== undefined) {
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
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function schemeOf(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url)
  return match ? (match[1] ?? '').toLowerCase() : ''
}

function redact(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:)?(\/\/)?(?:[^/@]*@)+/i, (_m, scheme, slashes) => `${scheme ?? ''}${slashes ?? ''}***@`)
    .replace(/([?&][^=&]*=)[^&]*/g, '$1***')
}
