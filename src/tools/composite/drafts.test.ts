import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../helpers/config.js'

const graphRequest = vi.fn()
vi.mock('../helpers/graph.js', () => ({ graphRequest: (...a: unknown[]) => graphRequest(...a) }))
vi.mock('../helpers/imap-client.js', () => ({ readEmail: vi.fn() }))

const { drafts, quoteStart, withQuote } = await import('./drafts.js')

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

const REPLY_HTML =
  '<html><head><meta charset="utf-8"></head><body><div><br></div>' +
  '<hr style="display:inline-block;width:98%" tabindex="-1">' +
  '<div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Mandi</div><div>original text</div></body></html>'

describe('drafts quote handling (pape-house fork)', () => {
  it('finds the quote at the <hr> before divRplyFwdMsg', () => {
    expect(REPLY_HTML.slice(quoteStart(REPLY_HTML))).toMatch(/^<hr/)
    expect(quoteStart('<p>new email</p>')).toBe(-1)
  })

  it('puts text above the quote and keeps the original', () => {
    const out = withQuote(REPLY_HTML, 'Friday works.\nThanks', 'text')
    expect(out).toContain('<div id="pm-reply">Friday works.<br>Thanks</div><hr')
    expect(out).toContain('original text')
    expect(out.startsWith('<html><head><meta charset="utf-8"></head><body>')).toBe(true)
    expect(out).not.toContain('<div><br></div><hr')
  })

  it('replacing the text again still keeps one quote', () => {
    const once = withQuote(REPLY_HTML, 'first', 'text')
    const twice = withQuote(once, 'second <b>x</b>', 'text')
    expect(twice).toContain('second &lt;b&gt;x&lt;/b&gt;')
    expect(twice).not.toContain('first')
    expect(twice.match(/divRplyFwdMsg/g)).toHaveLength(1)
  })

  it('update on a reply draft keeps the quote', async () => {
    graphRequest.mockImplementation(async (_a: unknown, method: string, path: string, body?: any) => {
      if (typeof path !== 'string') return undefined
      if (path.startsWith('/me/mailFolders/drafts?')) return { id: DRAFTS_ID }
      if (method === 'GET' && path.endsWith('$select=body'))
        return { body: { contentType: 'html', content: REPLY_HTML } }
      if (method === 'GET') return { id: 'm1', isDraft: true, parentFolderId: DRAFTS_ID }
      if (method === 'PATCH') return { id: 'm1', patched: body }
      throw new Error(`unexpected ${method} ${path}`)
    })
    await drafts([account], { action: 'update', draft_id: 'm1', body: 'new text' })
    const patch = graphRequest.mock.calls.find(([, m]) => m === 'PATCH')?.[3]
    expect(patch.body.contentType).toBe('HTML')
    expect(patch.body.content).toContain('new text')
    expect(patch.body.content).toContain('original text')
  })
})

describe('drafts send_new (pape-house fork)', () => {
  it('creates the message then sends that same draft', async () => {
    graphRequest.mockImplementation(async (_a: unknown, method: string, path: string, body?: any) => {
      if (typeof path !== 'string') return undefined
      if (path.startsWith('/me/mailFolders/drafts?')) return { id: DRAFTS_ID }
      if (method === 'POST' && path === '/me/messages')
        return {
          id: 'new1',
          subject: body.subject,
          toRecipients: body.toRecipients,
          isDraft: true,
          parentFolderId: DRAFTS_ID
        }
      if (method === 'GET' && path.startsWith('/me/messages/new1'))
        return {
          id: 'new1',
          subject: 'Brief',
          toRecipients: [{ emailAddress: { address: 'a@b.com' } }],
          isDraft: true,
          parentFolderId: DRAFTS_ID
        }
      if (method === 'POST' && path === '/me/messages/new1/send') return undefined
      throw new Error(`unexpected ${method} ${path}`)
    })
    const r = await drafts([account], {
      action: 'send_new',
      to: 'a@b.com',
      subject: 'Brief',
      body: '<b>x</b>',
      body_type: 'html'
    })
    expect(r.action).toBe('send_new')
    expect(r.sent).toBe(true)
    expect(sendCalls()).toHaveLength(1)
    expect(sendCalls()[0][2]).toBe('/me/messages/new1/send')
  })

  it('refuses without recipients and creates nothing', async () => {
    await expect(drafts([account], { action: 'send_new', subject: 'x', body: 'y' })).rejects.toThrow(/to is required/)
    expect(graphRequest).not.toHaveBeenCalled()
  })
})
