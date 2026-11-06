/**
 * Drafts Mega Tool (pape-house fork)
 *
 * Drafts are the ONLY send path in this deployment: write a draft (new or a
 * threaded reply), let a person review it, then `send` it. `send` refuses
 * anything that is not an existing draft in the Drafts folder, so there is
 * no way to compose-and-send in one call.
 *
 * Backed by Microsoft Graph (same second sign-in as the rules tool):
 * Mail.ReadWrite for drafts, Mail.Send for `send`.
 */

import type { AccountConfig } from '../helpers/config.js'
import { resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { graphRequest } from '../helpers/graph.js'
import { readEmail } from '../helpers/imap-client.js'

export interface DraftsInput {
  action: 'list' | 'create' | 'reply' | 'update' | 'send' | 'send_new'
  account?: string

  // create / update
  to?: string
  cc?: string
  subject?: string
  body?: string
  body_type?: 'text' | 'html'

  // reply: identify the original by Message-ID, or by IMAP uid (+ folder)
  message_id?: string
  uid?: number
  folder?: string
  reply_all?: boolean

  // update / send
  draft_id?: string

  // list
  limit?: number
}

const SELECT =
  'id,subject,toRecipients,ccRecipients,isDraft,parentFolderId,createdDateTime,lastModifiedDateTime,bodyPreview,webLink'

export async function drafts(accounts: AccountConfig[], input: DraftsInput): Promise<any> {
  return withErrorHandling(async () => {
    const account = resolveSingleAccount(accounts, input.account)
    switch (input.action) {
      case 'list':
        return await handleList(account, input)
      case 'create':
        return await handleCreate(account, input)
      case 'reply':
        return await handleReply(account, input)
      case 'update':
        return await handleUpdate(account, input)
      case 'send':
        return await handleSend(account, input)
      case 'send_new':
        return await handleSendNew(account, input)
      default:
        throw createUnknownActionError(input.action, 'list, create, reply, update, send, send_new')
    }
  })()
}

// ── helpers ────────────────────────────────────────────────────────────

function recipients(list?: string): Array<{ emailAddress: { address: string } }> | undefined {
  if (list === undefined) return undefined
  const out = list
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean)
  for (const a of out) {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)) {
      throw new EmailMCPError(`Invalid email address: ${a}`, 'VALIDATION_ERROR', 'Plain addresses, comma-separated')
    }
  }
  return out.map((address) => ({ emailAddress: { address } }))
}

function present(m: any): any {
  const addrs = (l?: any[]) => (l ?? []).map((r) => r.emailAddress?.address).filter(Boolean)
  return {
    draft_id: m.id,
    subject: m.subject,
    to: addrs(m.toRecipients),
    cc: addrs(m.ccRecipients),
    is_draft: m.isDraft,
    created: m.createdDateTime,
    modified: m.lastModifiedDateTime,
    preview: m.bodyPreview,
    web_link: m.webLink
  }
}

function draftPath(input: DraftsInput): string {
  if (!input.draft_id || !/^[A-Za-z0-9=_\-+/]+$/.test(input.draft_id)) {
    throw new EmailMCPError('draft_id is required', 'VALIDATION_ERROR', 'Get it from drafts list / create / reply')
  }
  return `/me/messages/${encodeURIComponent(input.draft_id)}`
}

let draftsFolderId: string | undefined
async function getDraftsFolderId(account: AccountConfig): Promise<string> {
  if (!draftsFolderId) {
    const f = await graphRequest<{ id: string }>(account, 'GET', '/me/mailFolders/drafts?$select=id')
    draftsFolderId = f.id
  }
  return draftsFolderId
}

/** Load a message and insist it is an unsent draft sitting in Drafts. */
async function requireDraft(account: AccountConfig, input: DraftsInput): Promise<any> {
  const m = await graphRequest(account, 'GET', `${draftPath(input)}?$select=${SELECT}`)
  if (m.isDraft !== true || m.parentFolderId !== (await getDraftsFolderId(account))) {
    throw new EmailMCPError(
      'Not a draft: only messages in the Drafts folder that have never been sent can be updated or sent',
      'NOT_A_DRAFT',
      'Create one with drafts create or drafts reply first'
    )
  }
  return m
}

function bodyOf(input: DraftsInput): { contentType: 'Text' | 'HTML'; content: string } | undefined {
  if (input.body === undefined) return undefined
  return { contentType: input.body_type === 'html' ? 'HTML' : 'Text', content: input.body }
}

// ── actions ────────────────────────────────────────────────────────────

async function handleList(account: AccountConfig, input: DraftsInput): Promise<any> {
  const top = Math.min(Math.max(1, Math.floor(input.limit ?? 25)), 100)
  const page = await graphRequest<{ value: any[] }>(
    account,
    'GET',
    `/me/mailFolders/drafts/messages?$top=${top}&$orderby=lastModifiedDateTime desc&$select=${SELECT}`
  )
  return { action: 'list', account: account.email, total: page.value.length, drafts: page.value.map(present) }
}

async function handleCreate(account: AccountConfig, input: DraftsInput): Promise<any> {
  if (!input.subject && !input.body) {
    throw new EmailMCPError('subject or body is required', 'VALIDATION_ERROR')
  }
  const payload: any = { subject: input.subject ?? '' }
  const b = bodyOf(input)
  if (b) payload.body = b
  const to = recipients(input.to)
  const cc = recipients(input.cc)
  if (to) payload.toRecipients = to
  if (cc) payload.ccRecipients = cc
  const m = await graphRequest(account, 'POST', '/me/messages', payload)
  return { action: 'create', account: account.email, draft: present(m) }
}

/**
 * pape-house: write a brand-new email and send it in one call. Exists so a
 * gateway can grant "send to fixed recipients" without granting `send`
 * (which would send any draft in the mailbox): the gateway pins `to` / `cc`
 * on this action and never exposes `send` to that caller.
 */
async function handleSendNew(account: AccountConfig, input: DraftsInput): Promise<any> {
  if (!input.to?.trim()) {
    throw new EmailMCPError('to is required for send_new', 'VALIDATION_ERROR')
  }
  const created = await handleCreate(account, input)
  const sent = await handleSend(account, { ...input, action: 'send', draft_id: created.draft.draft_id })
  return { ...sent, action: 'send_new' }
}

async function resolveOriginal(account: AccountConfig, input: DraftsInput): Promise<string> {
  let mid = input.message_id
  if (!mid && input.uid !== undefined) {
    mid = (await readEmail(account, input.uid, input.folder || 'INBOX')).message_id
  }
  if (!mid) {
    throw new EmailMCPError(
      'message_id or uid is required for reply',
      'VALIDATION_ERROR',
      'Use message_id from messages search/read, or uid (+ folder)'
    )
  }
  const bracketed = mid.startsWith('<') ? mid : `<${mid}>`
  const filter = encodeURIComponent(`internetMessageId eq '${bracketed.replace(/'/g, "''")}'`)
  const page = await graphRequest<{ value: Array<{ id: string }> }>(
    account,
    'GET',
    `/me/messages?$filter=${filter}&$select=id&$top=1`
  )
  const id = page.value[0]?.id
  if (!id) throw new EmailMCPError(`Original message not found in Graph: ${bracketed}`, 'NOT_FOUND')
  return id
}

/**
 * Where Outlook's quoted original starts in a reply/forward body: the <hr>
 * just before `divRplyFwdMsg` (Outlook web/desktop), else that div itself.
 * -1 when the body has no quote (a new email).
 */
export function quoteStart(html: string): number {
  const div = html.search(/<div[^>]*id=["']?divRplyFwdMsg/i)
  if (div === -1) return -1
  const hr = html.lastIndexOf('<hr', div)
  return hr !== -1 && div - hr < 400 ? hr : div
}

/** The caller's text as HTML (plain text is escaped, newlines become <br>). */
function myHtml(body: string, bodyType?: 'text' | 'html'): string {
  return bodyType === 'html' ? body : escapeHtml(body).replace(/\r?\n/g, '<br>')
}

/**
 * Put the caller's text above the quote, keeping Outlook's quoted original
 * (and the reply's HTML head/body wrapper) intact. Replies are always HTML:
 * that's what Outlook generates, and converting to text drops the quote.
 */
export function withQuote(existingHtml: string, body: string, bodyType?: 'text' | 'html'): string {
  const mine = `<div id="pm-reply">${myHtml(body, bodyType)}</div>`
  const q = quoteStart(existingHtml)
  if (q === -1) return mine
  const head = existingHtml.slice(0, q)
  const bodyOpen = head.search(/<body[^>]*>/i)
  const prefix = bodyOpen === -1 ? '' : head.slice(0, head.indexOf('>', bodyOpen) + 1)
  return `${prefix}${mine}${existingHtml.slice(q)}`
}

async function handleReply(account: AccountConfig, input: DraftsInput): Promise<any> {
  const originalId = await resolveOriginal(account, input)
  const verb = input.reply_all ? 'createReplyAll' : 'createReply'
  // Empty create (Outlook builds the threaded reply + quoted original), then
  // PATCH our text in above the quote.
  const d = await graphRequest(account, 'POST', `/me/messages/${encodeURIComponent(originalId)}/${verb}`, {})
  const patch: any = {}
  if (input.body !== undefined) {
    patch.body = { contentType: 'HTML', content: withQuote(d.body?.content ?? '', input.body, input.body_type) }
  }
  const to = recipients(input.to)
  const cc = recipients(input.cc)
  if (to) patch.toRecipients = to
  if (cc) patch.ccRecipients = cc
  const m = Object.keys(patch).length
    ? await graphRequest(account, 'PATCH', `/me/messages/${encodeURIComponent(d.id)}`, patch)
    : d
  return { action: 'reply', account: account.email, reply_all: !!input.reply_all, draft: present(m) }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function handleUpdate(account: AccountConfig, input: DraftsInput): Promise<any> {
  await requireDraft(account, input)
  const patch: any = {}
  if (input.subject !== undefined) patch.subject = input.subject
  if (input.body !== undefined) {
    // Keep a reply's quoted original: replace only the text above it.
    const cur = await graphRequest<{ body?: { contentType?: string; content?: string } }>(
      account,
      'GET',
      `${draftPath(input)}?$select=body`
    )
    const html = cur.body?.contentType?.toLowerCase() === 'html' ? (cur.body.content ?? '') : ''
    if (quoteStart(html) !== -1) {
      patch.body = { contentType: 'HTML', content: withQuote(html, input.body, input.body_type) }
    } else {
      patch.body = bodyOf(input)
    }
  }
  const to = recipients(input.to)
  const cc = recipients(input.cc)
  if (to) patch.toRecipients = to
  if (cc) patch.ccRecipients = cc
  if (!Object.keys(patch).length) throw new EmailMCPError('Nothing to update', 'VALIDATION_ERROR')
  const m = await graphRequest(account, 'PATCH', draftPath(input), patch)
  return { action: 'update', account: account.email, draft: present(m) }
}

async function handleSend(account: AccountConfig, input: DraftsInput): Promise<any> {
  const m = await requireDraft(account, input)
  if (!m.toRecipients?.length && !m.ccRecipients?.length) {
    throw new EmailMCPError('Draft has no recipients', 'VALIDATION_ERROR', 'Add one with drafts update')
  }
  try {
    await graphRequest(account, 'POST', `${draftPath(input)}/send`)
  } catch (e) {
    if (e instanceof EmailMCPError && /denied|forbidden|scope|403/i.test(e.message)) {
      throw new EmailMCPError(
        `Sending failed: ${e.message}`,
        'GRAPH_SEND_NOT_AUTHORIZED',
        'The Graph sign-in lacks Mail.Send: add it to the app registration and re-run config graph_auth_start'
      )
    }
    throw e
  }
  const sent = present(m)
  return { action: 'send', account: account.email, sent: true, subject: sent.subject, to: sent.to, cc: sent.cc }
}
