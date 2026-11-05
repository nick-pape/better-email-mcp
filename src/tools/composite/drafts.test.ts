import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../helpers/config.js'

const graphRequest = vi.fn()
vi.mock('../helpers/graph.js', () => ({ graphRequest: (...a: unknown[]) => graphRequest(...a) }))
vi.mock('../helpers/imap-client.js', () => ({ readEmail: vi.fn() }))

const { drafts } = await import('./drafts.js')

const account = {
  id: 'me',
  email: 'me@outlook.com',
  password: '',
  authType: 'oauth2',
  imap: { host: 'x', port: 993, secure: true },
  smtp: { host: 'x', port: 587, secure: false }
} as AccountConfig

const DRAFTS_ID = 'DRAFTSFOLDER'

function route(message: Record<string, unknown>) {
  graphRequest.mockImplementation(async (_acct: unknown, method: string, path: string) => {
    if (typeof path !== 'string') return undefined
    if (path.startsWith('/me/mailFolders/drafts?')) return { id: DRAFTS_ID }
    if (method === 'GET' && path.startsWith('/me/messages/')) return { id: 'm1', ...message }
    if (method === 'POST' && path.endsWith('/send')) return undefined
    throw new Error(`unexpected ${method} ${path}`)
  })
}

const sendCalls = () => graphRequest.mock.calls.filter(([, m, p]) => m === 'POST' && String(p).endsWith('/send'))

beforeEach(() => graphRequest.mockReset())

describe('drafts send (pape-house fork)', () => {
  it('sends an unsent draft in the Drafts folder', async () => {
    route({ isDraft: true, parentFolderId: DRAFTS_ID, toRecipients: [{ emailAddress: { address: 'a@b.com' } }] })
    const r = await drafts([account], { action: 'send', draft_id: 'm1' })
    expect(r.sent).toBe(true)
    expect(sendCalls()).toHaveLength(1)
  })

  it('refuses a message that is not a draft', async () => {
    route({ isDraft: false, parentFolderId: DRAFTS_ID, toRecipients: [{ emailAddress: { address: 'a@b.com' } }] })
    await expect(drafts([account], { action: 'send', draft_id: 'm1' })).rejects.toThrow(/Not a draft/)
    expect(sendCalls()).toHaveLength(0)
  })

  it('refuses a draft outside the Drafts folder', async () => {
    route({ isDraft: true, parentFolderId: 'INBOX', toRecipients: [{ emailAddress: { address: 'a@b.com' } }] })
    await expect(drafts([account], { action: 'send', draft_id: 'm1' })).rejects.toThrow(/Not a draft/)
    expect(sendCalls()).toHaveLength(0)
  })

  it('refuses a draft with no recipients', async () => {
    route({ isDraft: true, parentFolderId: DRAFTS_ID, toRecipients: [], ccRecipients: [] })
    await expect(drafts([account], { action: 'send', draft_id: 'm1' })).rejects.toThrow(/no recipients/)
    expect(sendCalls()).toHaveLength(0)
  })

  it('rejects a malformed draft id before any call', async () => {
    await expect(drafts([account], { action: 'send', draft_id: '../me' })).rejects.toThrow(/draft_id/)
    expect(graphRequest).not.toHaveBeenCalled()
  })

  it('rejects invalid recipient addresses on create', async () => {
    await expect(drafts([account], { action: 'create', subject: 'x', to: 'not-an-address' })).rejects.toThrow(
      /Invalid email/
    )
    expect(graphRequest).not.toHaveBeenCalled()
  })
})
