export type CfKnexErrorCode =
  | 'AMBIGUOUS_CONNECTION'
  | 'NO_CONNECTION'
  | 'UNKNOWN_DRIVER'
  | 'INVALID_ENGINE_DRIVER'
  | 'MISSING_DRIVER'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INCOMPATIBLE_KNEX'
  | 'MALFORMED_DRIVER_RESULT'

export class CfKnexError extends Error {
  readonly code: CfKnexErrorCode

  constructor(code: CfKnexErrorCode, message: string) {
    super(message)
    this.name = 'CfKnexError'
    this.code = code
  }

  static missingDriver(pkg: string): CfKnexError {
    return new CfKnexError('MISSING_DRIVER', `driver package '${pkg}' is not installed — run: pnpm add ${pkg}`)
  }

  static unsupported(driver: string, capability: string, hint: string): CfKnexError {
    return new CfKnexError('UNSUPPORTED_CAPABILITY', `${capability} is not supported by the ${driver} driver. ${hint}`)
  }

  static malformedResult(detail: string): CfKnexError {
    return new CfKnexError('MALFORMED_DRIVER_RESULT', `driver returned a malformed result: ${detail}`)
  }
}
