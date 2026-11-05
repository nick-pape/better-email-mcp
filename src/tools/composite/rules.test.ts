import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../helpers/config.js'
import { rules } from './rules.js'

const account = {
  id: 'me',
  email: 'me@outlook.com',
  password: '',
  authType: 'oauth2',
  imap: { host: 'x', port: 993, secure: true },
  smtp: { host: 'x', port: 587, secure: false }
} as AccountConfig

afterEach(() => vi.restoreAllMocks())

describe('rules (pape-house fork)', () => {
  for (const blocked of ['forwardTo', 'redirectTo', 'forwardAsAttachmentTo', 'delete', 'permanentDelete']) {
    it(`refuses rule action ${blocked} before any network call`, async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      await expect(
        rules([account], {
          action: 'create',
          rule: { displayName: 'x', conditions: {}, actions: { [blocked]: true } }
        })
      ).rejects.toThrow(/not allowed/)
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  }

  it('refuses unknown top-level rule fields', async () => {
    await expect(
      rules([account], { action: 'update', rule_id: 'abc', rule: { id: 'other', isEnabled: false } })
    ).rejects.toThrow(/Unsupported rule fields/)
  })

  it('requires displayName and actions on create', async () => {
    await expect(rules([account], { action: 'create', rule: { conditions: {} } })).rejects.toThrow(/displayName/)
  })

  it('rejects malformed rule ids', async () => {
    await expect(rules([account], { action: 'delete', rule_id: '../../me' })).rejects.toThrow(/rule_id/)
  })
})
