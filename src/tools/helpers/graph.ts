/**
 * Microsoft Graph access for Outlook.com accounts (pape-house fork).
 *
 * IMAP cannot see server-side Outlook rules; those live in Graph
 * (/me/mailFolders/inbox/messageRules). Graph is a different resource from
 * outlook.office.com, so it needs its OWN token: Microsoft v2 will not mint
 * one access token spanning both resources, and a refresh token only
 * redeems for resources the user already consented to.
 *
 * So the Graph token is a second, independent sign-in (device code), stored
 * in the same tokens.json under the key `graph:<email>`. The IMAP token is
 * untouched by any of this.
 *
 * Requires an Azure app registration (OUTLOOK_CLIENT_ID) that lists the
 * delegated Graph permissions in GRAPH_SCOPES and has "Allow public client
 * flows" enabled. The upstream bundled client ID does not.
 */

import type { AccountConfig } from './config.js'
import { EmailMCPError } from './errors.js'
import { getClientId, loadStoredTokens, type OAuth2Tokens, saveTokens } from './oauth2.js'

const AUTH_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/** Requested on a new sign-in. Mail.Send is for drafts_send only. */
export const GRAPH_SCOPES = [
  'https://graph.microsoft.com/MailboxSettings.ReadWrite',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'offline_access'
]

/**
 * Refresh with the scopes a token was actually granted (stored at sign-in),
 * so adding a scope to GRAPH_SCOPES never breaks an existing token. Tokens
 * from before scopes were stored got exactly these.
 */
const LEGACY_SCOPES = [
  'https://graph.microsoft.com/MailboxSettings.ReadWrite',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'offline_access'
]

type GraphTokens = OAuth2Tokens & { scope?: string }

const REFRESH_BUFFER_S = 300

function storeKey(email: string): string {
  return `graph:${email.toLowerCase()}`
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

async function postForm(path: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  })
  return (await res.json()) as TokenResponse
}

// ── Device-code sign-in ────────────────────────────────────────────────

interface PendingGraphAuth {
  verificationUri: string
  userCode: string
  expiresAt: number
  lastError?: string
}

const pending = new Map<string, PendingGraphAuth>()

export interface GraphAuthStart {
  verification_uri: string
  user_code: string
  expires_in: number
  message: string
}

export async function startGraphAuth(email: string): Promise<GraphAuthStart> {
  const key = storeKey(email)
  const existing = pending.get(key)
  if (existing && existing.expiresAt > Date.now()) {
    return {
      verification_uri: existing.verificationUri,
      user_code: existing.userCode,
      expires_in: Math.floor((existing.expiresAt - Date.now()) / 1000),
      message: `Sign-in already in progress. Visit ${existing.verificationUri} and enter ${existing.userCode}.`
    }
  }

  const clientId = getClientId()
  const res = await fetch(`${AUTH_BASE}/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: GRAPH_SCOPES.join(' ') })
  })
  const data = (await res.json()) as {
    device_code?: string
    user_code?: string
    verification_uri?: string
    expires_in?: number
    interval?: number
    error?: string
    error_description?: string
  }
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new EmailMCPError(
      `Graph device-code request failed: ${data.error_description || data.error || 'unknown error'}`,
      'GRAPH_AUTH_FAILED',
      'Check that OUTLOOK_CLIENT_ID is an app registration with public client flows enabled and the Graph permissions added.'
    )
  }

  const expiresIn = data.expires_in ?? 900
  const entry: PendingGraphAuth = {
    verificationUri: data.verification_uri,
    userCode: data.user_code,
    expiresAt: Date.now() + expiresIn * 1000
  }
  pending.set(key, entry)
  void pollGraphAuth(email, clientId, data.device_code, (data.interval ?? 5) * 1000, entry)

  return {
    verification_uri: data.verification_uri,
    user_code: data.user_code,
    expires_in: expiresIn,
    message: `Visit ${data.verification_uri} and enter ${data.user_code}, then call graph_auth_status.`
  }
}

async function pollGraphAuth(
  email: string,
  clientId: string,
  deviceCode: string,
  intervalMs: number,
  entry: PendingGraphAuth
): Promise<void> {
  const key = storeKey(email)
  let wait = intervalMs
  try {
    while (Date.now() < entry.expiresAt) {
      await new Promise((r) => setTimeout(r, wait))
      const tok = await postForm('token', {
        client_id: clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode
      })
      if (tok.access_token && tok.refresh_token) {
        saveTokens(key, {
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          expiresAt: Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600),
          clientId,
          // Granted scopes (space-separated); offline_access is implied.
          scope: tok.scope ? `${tok.scope} offline_access` : GRAPH_SCOPES.join(' ')
        } as GraphTokens)
        pending.delete(key)
        return
      }
      if (tok.error === 'authorization_pending') continue
      if (tok.error === 'slow_down') {
        wait += 5000
        continue
      }
      entry.lastError = tok.error_description || tok.error || 'unknown error'
      entry.expiresAt = Date.now() + 10 * 60 * 1000 // keep the error visible to status for a while
      return
    }
  } catch (err) {
    entry.lastError = err instanceof Error ? err.message : String(err)
  }
}

export interface GraphAuthStatus {
  signed_in: boolean
  pending: boolean
  verification_uri?: string
  user_code?: string
  error?: string
  scopes: string[]
}

export async function graphAuthStatus(email: string): Promise<GraphAuthStatus> {
  const key = storeKey(email)
  const tokens = await loadStoredTokens(key)
  const p = pending.get(key)
  return {
    signed_in: !!tokens?.refreshToken,
    pending: !!p && !p.lastError && p.expiresAt > Date.now(),
    verification_uri: p && !p.lastError ? p.verificationUri : undefined,
    user_code: p && !p.lastError ? p.userCode : undefined,
    error: p?.lastError,
    scopes: ((tokens as GraphTokens | null)?.scope || (tokens ? LEGACY_SCOPES.join(' ') : ''))
      .split(' ')
      .filter(Boolean)
  }
}

// ── Token + request helpers ────────────────────────────────────────────

async function graphToken(email: string): Promise<string> {
  const key = storeKey(email)
  const tokens = (await loadStoredTokens(key)) as GraphTokens | null
  if (!tokens) {
    throw new EmailMCPError(
      `Microsoft Graph is not signed in for ${email}`,
      'GRAPH_NOT_AUTHORIZED',
      'An operator must run config action graph_auth_start once and complete the device-code sign-in.'
    )
  }
  const now = Math.floor(Date.now() / 1000)
  if (tokens.expiresAt > now + REFRESH_BUFFER_S) return tokens.accessToken

  const tok = await postForm('token', {
    client_id: tokens.clientId,
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    scope: tokens.scope || LEGACY_SCOPES.join(' ')
  })
  if (!tok.access_token) {
    throw new EmailMCPError(
      `Graph token refresh failed: ${tok.error_description || tok.error || 'unknown error'}`,
      'GRAPH_NOT_AUTHORIZED',
      'Re-run config action graph_auth_start to sign in again.'
    )
  }
  const updated: GraphTokens = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || tokens.refreshToken,
    expiresAt: now + (tok.expires_in ?? 3600),
    clientId: tokens.clientId,
    scope: tokens.scope
  }
  saveTokens(key, updated)
  return updated.accessToken
}

export async function graphRequest<T = any>(
  account: AccountConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const token = await graphToken(account.email)
  const url = path.startsWith('https://') ? path : `${GRAPH_BASE}${path}`
  if (!url.startsWith(`${GRAPH_BASE}/`)) {
    throw new EmailMCPError('Refusing non-Graph URL', 'VALIDATION_ERROR')
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? JSON.parse(text) : undefined
  if (!res.ok) {
    const msg = data?.error?.message || `${res.status} ${res.statusText}`
    throw new EmailMCPError(`Graph ${method} ${path} failed: ${msg}`, 'GRAPH_ERROR', undefined, data?.error)
  }
  return data as T
}

// ── Folder path <-> Graph folder ID ────────────────────────────────────

interface GraphFolder {
  id: string
  displayName: string
  childFolderCount?: number
}

/** Well-known Graph folder names usable directly in place of an ID. */
const WELL_KNOWN: Record<string, string> = {
  inbox: 'inbox',
  archive: 'archive',
  drafts: 'drafts',
  'sent items': 'sentitems',
  sent: 'sentitems',
  'deleted items': 'deleteditems',
  trash: 'deleteditems',
  junk: 'junkemail',
  'junk email': 'junkemail'
}

/** Map of "Parent/Child" path → folder id, built by walking the tree. */
async function folderMap(account: AccountConfig): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const walk = async (url: string, prefix: string, depth: number): Promise<void> => {
    let next: string | undefined = url
    while (next) {
      const page: { value: GraphFolder[]; '@odata.nextLink'?: string } = await graphRequest(account, 'GET', next)
      for (const f of page.value) {
        const path = prefix ? `${prefix}/${f.displayName}` : f.displayName
        map.set(path, f.id)
        if ((f.childFolderCount ?? 0) > 0 && depth < 6) {
          await walk(
            `/me/mailFolders/${f.id}/childFolders?$top=100&$select=id,displayName,childFolderCount`,
            path,
            depth + 1
          )
        }
      }
      next = page['@odata.nextLink']
    }
  }
  await walk('/me/mailFolders?$top=100&$select=id,displayName,childFolderCount&includeHiddenFolders=false', '', 0)
  return map
}

export async function resolveFolderId(account: AccountConfig, pathOrName: string): Promise<string> {
  const wk = WELL_KNOWN[pathOrName.trim().toLowerCase()]
  if (wk) {
    const f: GraphFolder = await graphRequest(account, 'GET', `/me/mailFolders/${wk}?$select=id`)
    return f.id
  }
  const map = await folderMap(account)
  const want = pathOrName.trim().replace(/^\/+|\/+$/g, '')
  for (const [p, id] of map) {
    if (p.toLowerCase() === want.toLowerCase()) return id
  }
  throw new EmailMCPError(
    `Folder not found: ${pathOrName}`,
    'FOLDER_NOT_FOUND',
    'Use the folder path as shown by folders_list (e.g. "Receipts" or "Receipts/Amazon"). Create it first with folders_create.'
  )
}

export async function folderIdToPath(account: AccountConfig): Promise<Map<string, string>> {
  const byId = new Map<string, string>()
  for (const [p, id] of await folderMap(account)) byId.set(id, p)
  return byId
}
