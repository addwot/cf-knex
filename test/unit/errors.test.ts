import { expect, test } from 'vitest'
import { CfKnexError } from '../../src/core/errors'

test('carries a machine-readable code and a human message', () => {
  const err = new CfKnexError('AMBIGUOUS_CONNECTION', "received both 'url' and 'hyperdrive'")
  expect(err).toBeInstanceOf(Error)
  expect(err.code).toBe('AMBIGUOUS_CONNECTION')
  expect(err.message).toContain("received both 'url' and 'hyperdrive'")
  expect(err.name).toBe('CfKnexError')
})

test('missing driver error names the package to install', () => {
  const err = CfKnexError.missingDriver('mysql2')
  expect(err.code).toBe('MISSING_DRIVER')
  expect(err.message).toContain('pnpm add mysql2')
})
