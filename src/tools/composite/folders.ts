/**
 * Folders Mega Tool
 * List mailbox folders across email accounts
 */

import type { AccountConfig } from '../helpers/config.js'
import { resolveAccounts, resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { createFolder, listFolders } from '../helpers/imap-client.js'

export interface FoldersInput {
  action: 'list' | 'create'

  // Folder path for create, e.g. "Receipts" or "Receipts/Amazon"
  path?: string

  // Target account (optional - defaults to all)
  account?: string
}

/**
 * Unified folders tool - handles folder listing
 */
export async function folders(accounts: AccountConfig[], input: FoldersInput): Promise<any> {
  return withErrorHandling(async () => {
    switch (input.action) {
      case 'list':
        return await handleList(accounts, input)

      case 'create':
        return await handleCreate(accounts, input)

      default:
        throw createUnknownActionError(input.action, 'list, create')
    }
  })()
}

/**
 * Create a folder (pape-house fork). Idempotent.
 */
async function handleCreate(accounts: AccountConfig[], input: FoldersInput): Promise<any> {
  const path = input.path?.trim().replace(/^\/+|\/+$/g, '')
  if (!path) {
    throw new EmailMCPError('path is required for create', 'VALIDATION_ERROR', 'e.g. "Receipts/Amazon"')
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
  if (path.length > 200 || /[\x00-\x1f*%]/.test(path)) {
    throw new EmailMCPError('Invalid folder path', 'VALIDATION_ERROR', 'No control characters, * or %')
  }
  const account = resolveSingleAccount(accounts, input.account)
  const result = await createFolder(account, path)
  return { action: 'create', account: account.email, ...result }
}

/**
 * List folders across accounts
 */
async function handleList(accounts: AccountConfig[], input: FoldersInput): Promise<any> {
  const targetAccounts = resolveAccounts(accounts, input.account)

  const accountPromises = targetAccounts.map(async (account) => {
    try {
      const folderList = await listFolders(account)
      return {
        account_id: account.id,
        account_email: account.email,
        folders: folderList
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        account_id: account.id,
        account_email: account.email,
        error: errorMessage,
        folders: []
      }
    }
  })

  const results = await Promise.all(accountPromises)

  return {
    action: 'list',
    total_accounts: results.length,
    accounts: results
  }
}
