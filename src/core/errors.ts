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

  // A statement that was meant to run inside an open transaction was executed
  // by the server outside it, where COMMIT/ROLLBACK can no longer govern it.
  // The failure this exists for is silent: the write succeeds, the caller's
  // rollback reports success, and the row is still there afterwards. Raised
  // rather than tolerated because there is no safe way to continue — the
  // transaction's atomicity is already gone by the time it is detectable.
  static transactionEscaped(detail: string): CfKnexError {
    return new CfKnexError(
      'TRANSACTION_ESCAPED',
      `a statement escaped its transaction and was applied outside it — ROLLBACK will NOT undo it. ${detail}`,
    )
  }

  // Covers both halves of what knex can ask for and a driver may not honor:
  // an isolation level, and `SET TRANSACTION READ ONLY`. One code rather than
  // one per case, so a caller can branch on `err.code` once.
  static unsupportedTransactionMode(detail: string): CfKnexError {
    return new CfKnexError('UNSUPPORTED_TRANSACTION_MODE', `unsupported transaction mode: ${detail}`)
  }
}
