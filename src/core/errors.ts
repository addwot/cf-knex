export type CfKnexErrorCode =
  | 'AMBIGUOUS_CONNECTION'
  | 'NO_CONNECTION'
  | 'UNKNOWN_DRIVER'
  | 'INVALID_ENGINE_DRIVER'
  | 'MISSING_DRIVER'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INCOMPATIBLE_KNEX'
  | 'MALFORMED_DRIVER_RESULT'
  | 'COMMIT_SILENTLY_ROLLED_BACK'
  | 'UNSUPPORTED_TRANSACTION_MODE'
  | 'TRANSACTION_ESCAPED'
  | 'REQUEST_TIMEOUT'

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

  static commitSilentlyRolledBack(detail: string): CfKnexError {
    return new CfKnexError(
      'COMMIT_SILENTLY_ROLLED_BACK',
      `COMMIT did not take effect: the connection's transaction was already aborted, so the database executed this COMMIT as a ROLLBACK instead. ${detail}`,
    )
  }

  static transactionEscaped(detail: string): CfKnexError {
    return new CfKnexError(
      'TRANSACTION_ESCAPED',
      `a statement escaped its transaction and was applied outside it — ROLLBACK will NOT undo it. ${detail}`,
    )
  }

  static requestTimedOut(driver: string, ms: number): CfKnexError {
    return new CfKnexError(
      'REQUEST_TIMEOUT',
      `the ${driver} request exceeded the ${ms}ms timeoutMs budget and was aborted. The server may still apply it, so treat a write as of unknown outcome rather than as failed.`,
    )
  }

  static unsupportedTransactionMode(detail: string): CfKnexError {
    return new CfKnexError('UNSUPPORTED_TRANSACTION_MODE', `unsupported transaction mode: ${detail}`)
  }
}
