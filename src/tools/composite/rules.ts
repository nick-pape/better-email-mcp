/**
 * Rules Mega Tool (pape-house fork)
 * Server-side Outlook inbox rules via Microsoft Graph messageRules.
 *
 * Rules run inside Outlook itself, so they keep working when no agent is
 * running. Folder references use folder PATHS ("Receipts/Amazon"); this
 * module translates them to and from Graph folder IDs.
 *
 * Deliberately NOT supported, on create or update: rule actions that delete
 * mail or send it anywhere (delete, permanentDelete, forwardTo,
 * forwardAsAttachmentTo, redirectTo). A forwarding rule is an exfiltration
 * path that would bypass the gateway's "no send" policy, so those can only
 * be set by a human in Outlook's own UI.
 */

import type { AccountConfig } from '../helpers/config.js'
import { resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { folderIdToPath, graphRequest, resolveFolderId } from '../helpers/graph.js'

export interface RulesInput {
  action: 'list' | 'create' | 'update' | 'delete'
  account?: string
  rule_id?: string
  rule?: Record<string, any>
}

const RULES_PATH = '/me/mailFolders/inbox/messageRules'

const BLOCKED_ACTIONS = ['delete', 'permanentDelete', 'forwardTo', 'forwardAsAttachmentTo', 'redirectTo']
const FOLDER_ACTIONS = ['moveToFolder', 'copyToFolder']
const ALLOWED_TOP_LEVEL = ['displayName', 'sequence', 'isEnabled', 'conditions', 'exceptions', 'actions']

export async function rules(accounts: AccountConfig[], input: RulesInput): Promise<any> {
  return withErrorHandling(async () => {
    const account = resolveSingleAccount(accounts, input.account)
    switch (input.action) {
      case 'list':
        return await handleList(account)
      case 'create':
        return await handleCreate(account, input)
      case 'update':
        return await handleUpdate(account, input)
      case 'delete':
        return await handleDelete(account, input)
      default:
        throw createUnknownActionError(input.action, 'list, create, update, delete')
    }
  })()
}

function presentRule(rule: any, paths: Map<string, string>): any {
  const out: any = {
    id: rule.id,
    displayName: rule.displayName,
    sequence: rule.sequence,
    isEnabled: rule.isEnabled,
    hasError: rule.hasError,
    isReadOnly: rule.isReadOnly,
    conditions: rule.conditions ?? {},
    exceptions: rule.exceptions ?? {},
    actions: { ...(rule.actions ?? {}) }
  }
  for (const k of FOLDER_ACTIONS) {
    const id = out.actions[k]
    if (id) out.actions[k] = paths.get(id) ?? id
  }
  return out
}

async function handleList(account: AccountConfig): Promise<any> {
  const [page, paths] = await Promise.all([
    graphRequest<{ value: any[] }>(account, 'GET', `${RULES_PATH}?$top=200`),
    folderIdToPath(account)
  ])
  const list = page.value.map((r) => presentRule(r, paths)).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  return { action: 'list', account: account.email, total: list.length, rules: list }
}

/** Validate + translate a caller-supplied rule body into a Graph payload. */
async function toGraphRule(account: AccountConfig, rule: Record<string, any>, partial: boolean): Promise<any> {
  if (!rule || typeof rule !== 'object') {
    throw new EmailMCPError('rule object is required', 'VALIDATION_ERROR')
  }
  const unknown = Object.keys(rule).filter((k) => !ALLOWED_TOP_LEVEL.includes(k))
  if (unknown.length) {
    throw new EmailMCPError(
      `Unsupported rule fields: ${unknown.join(', ')}`,
      'VALIDATION_ERROR',
      `Allowed: ${ALLOWED_TOP_LEVEL.join(', ')}`
    )
  }
  if (!partial) {
    if (!rule.displayName) throw new EmailMCPError('rule.displayName is required', 'VALIDATION_ERROR')
    if (!rule.actions || Object.keys(rule.actions).length === 0) {
      throw new EmailMCPError('rule.actions is required', 'VALIDATION_ERROR', 'e.g. {"moveToFolder": "Receipts"}')
    }
  }
  const body: any = { ...rule }
  if (body.actions) {
    const actions = { ...body.actions }
    const blocked = BLOCKED_ACTIONS.filter((k) => k in actions)
    if (blocked.length) {
      throw new EmailMCPError(
        `Rule actions not allowed through this tool: ${blocked.join(', ')}`,
        'FORBIDDEN_RULE_ACTION',
        'Rules may move, copy, mark read, set importance, categorize, or stop processing. Deleting or forwarding mail must be set up by a person in Outlook.'
      )
    }
    for (const k of FOLDER_ACTIONS) {
      if (typeof actions[k] === 'string' && actions[k]) {
        actions[k] = await resolveFolderId(account, actions[k])
      }
    }
    body.actions = actions
  }
  if (!partial && body.sequence === undefined) {
    // Append after existing rules
    const page = await graphRequest<{ value: any[] }>(account, 'GET', `${RULES_PATH}?$select=sequence&$top=200`)
    body.sequence = page.value.reduce((m, r) => Math.max(m, r.sequence ?? 0), 0) + 1
  }
  if (!partial && body.isEnabled === undefined) body.isEnabled = true
  return body
}

async function handleCreate(account: AccountConfig, input: RulesInput): Promise<any> {
  const body = await toGraphRule(account, input.rule ?? {}, false)
  const created = await graphRequest(account, 'POST', RULES_PATH, body)
  return { action: 'create', account: account.email, rule: presentRule(created, await folderIdToPath(account)) }
}

function requireRuleId(input: RulesInput): string {
  if (!input.rule_id || !/^[A-Za-z0-9=_\-+/]+$/.test(input.rule_id)) {
    throw new EmailMCPError('rule_id is required', 'VALIDATION_ERROR', 'Get rule ids from rules list')
  }
  return encodeURIComponent(input.rule_id)
}

async function handleUpdate(account: AccountConfig, input: RulesInput): Promise<any> {
  const id = requireRuleId(input)
  const body = await toGraphRule(account, input.rule ?? {}, true)
  const updated = await graphRequest(account, 'PATCH', `${RULES_PATH}/${id}`, body)
  return { action: 'update', account: account.email, rule: presentRule(updated, await folderIdToPath(account)) }
}

async function handleDelete(account: AccountConfig, input: RulesInput): Promise<any> {
  const id = requireRuleId(input)
  await graphRequest(account, 'DELETE', `${RULES_PATH}/${id}`)
  return { action: 'delete', account: account.email, rule_id: input.rule_id, deleted: true }
}
