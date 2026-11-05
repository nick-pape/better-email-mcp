/**
 * Tool Registry - 6 Composite Tools
 * Consolidated registration for maximum coverage with minimal tools
 *
 * Credential-aware: when state is 'awaiting_setup', tools return setup
 * instructions with the relay URL instead of failing with cryptic errors.
 * The relay session is triggered lazily on first tool call.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { buildOpenRelayHandler } from '@n24q02m/mcp-core'
import { getSetupUrl, getState } from '../credential-state.js'
import { type AttachmentsInput, attachments } from './composite/attachments.js'
import { type CalendarInput, calendar } from './composite/calendar.js'
import { type ConfigInput, handleConfig } from './composite/config.js'
import { type DraftsInput, drafts } from './composite/drafts.js'
import { type FoldersInput, folders } from './composite/folders.js'
import { type MessagesInput, messages } from './composite/messages.js'
import { type RulesInput, rules } from './composite/rules.js'
import { type SendInput, send } from './composite/send.js'
// Import mega tools
import { type AccountConfig, loadConfig } from './helpers/config.js'
import { aiReadableMessage, EmailMCPError, enhanceError, findClosestMatch } from './helpers/errors.js'
import { isValidToolName, wrapToolResult } from './helpers/security.js'

// Get docs directory path - works for both bundled CLI and unbundled code
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// For bundled CLI: __dirname = /bin/, docs at /build/src/docs/
// For unbundled: __dirname = /build/src/tools/, docs at /build/src/docs/
const DOCS_DIR = __dirname.endsWith('bin')
  ? join(__dirname, '..', 'build', 'src', 'docs')
  : join(__dirname, '..', 'docs')

/**
 * Documentation resources for full tool details
 */
const RESOURCES = [
  { uri: 'email://docs/messages', name: 'Messages Tool Docs', file: 'messages.md' },
  { uri: 'email://docs/folders', name: 'Folders Tool Docs', file: 'folders.md' },
  { uri: 'email://docs/attachments', name: 'Attachments Tool Docs', file: 'attachments.md' },
  { uri: 'email://docs/send', name: 'Send Tool Docs', file: 'send.md' },
  { uri: 'email://docs/help', name: 'Help Tool Docs', file: 'help.md' },
  { uri: 'email://docs/config', name: 'Config Tool Docs', file: 'config.md' },
  { uri: 'email://docs/rules', name: 'Rules Tool Docs', file: 'rules.md' },
  { uri: 'email://docs/drafts', name: 'Drafts Tool Docs', file: 'drafts.md' },
  { uri: 'email://docs/calendar', name: 'Calendar Tool Docs', file: 'calendar.md' }
]

/**
 * 6 Tools covering full email operations
 * Compressed descriptions for token optimization
 */
const TOOLS = [
  {
    name: 'messages',
    description:
      'Search, read, and manage email messages.\n\nActions (required params -> optional):\n- search (-> account, query="UNSEEN", folder="INBOX", limit=20)\n- read (account, uid -> folder)\n- mark_read / mark_unread / flag / unflag (account, uid|uids -> folder)\n- move (account, uid|uids, destination -> folder)\n- move_matching (account, query, destination -> folder, limit=200): move every match, newest first, max 1000 per call; returns remaining\n- archive / trash (account, uid|uids -> folder)\n\nQuery examples: "UNREAD", "FROM user@example.com", "SINCE 2026-01-01", "UNREAD FROM boss@company.com". Date format MUST be YYYY-MM-DD.',
    annotations: {
      title: 'Messages',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'search',
            'read',
            'mark_read',
            'mark_unread',
            'flag',
            'unflag',
            'move',
            'move_matching',
            'archive',
            'trash'
          ],
          description: 'Action to perform'
        },
        account: { type: 'string', description: 'Account email filter (optional, defaults to all for search)' },
        query: {
          type: 'string',
          description:
            'IMAP search query (default: UNSEEN). Single: UNREAD, FLAGGED, SINCE YYYY-MM-DD, FROM email@example.com, SUBJECT text. Combined: UNREAD SINCE 2026-01-01, UNREAD FROM user@example.com. Dates MUST use YYYY-MM-DD format (e.g. 2026-03-21). Plain text is treated as subject search.'
        },
        folder: { type: 'string', description: 'Mailbox folder (default: INBOX)' },
        limit: { type: 'number', description: 'Max results for search (default: 20)' },
        uid: { type: 'number', description: 'Email UID (for read/modify single email)' },
        uids: { type: 'array', items: { type: 'number' }, description: 'Multiple UIDs for batch operations' },
        destination: { type: 'string', description: 'Target folder for move / move_matching' }
      },
      required: ['action']
    }
  },
  {
    name: 'folders',
    description:
      'List and create mailbox folders.\n\nActions (required params -> optional):\n- list (-> account): folder names, paths, and flags for one or all accounts\n- create (path -> account): create a folder; nested with "/" (e.g. "Receipts/Amazon"). Idempotent.',
    annotations: {
      title: 'Folders',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create'],
          description: 'Action to perform'
        },
        account: { type: 'string', description: 'Account email filter (optional, defaults to all)' },
        path: { type: 'string', description: 'Folder path for create, e.g. "Receipts/Amazon"' }
      },
      required: ['action']
    }
  },
  {
    name: 'attachments',
    description:
      'List and download email attachments.\n\nActions (required params -> optional):\n- list (account, uid -> folder): show attachments with filename, content_type, size\n- download (account, uid, filename -> folder): get base64-encoded content\n\nUse list first to get exact filenames. Case-sensitive. Max 25MB per provider.',
    annotations: {
      title: 'Attachments',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'download'],
          description: 'Action to perform'
        },
        account: { type: 'string', description: 'Account email (required)' },
        uid: { type: 'number', description: 'Email UID (required)' },
        folder: { type: 'string', description: 'Mailbox folder (default: INBOX)' },
        filename: {
          type: 'string',
          description: 'Exact attachment filename from list action (required for download). Case-sensitive.'
        }
      },
      required: ['action', 'account', 'uid']
    }
  },
  {
    name: 'send',
    description:
      'Compose and send emails.\n\nActions (required params -> optional):\n- new (account, to, subject, body -> cc, bcc)\n- reply (account, uid, body -> to, folder): auto-derives recipient, prepends "Re:"\n- forward (account, uid, to, body -> folder): includes original, prepends "Fwd:"\n\nBody: plain text (default) or HTML (<b>, <a href>, <table>). Do NOT mix.',
    annotations: {
      title: 'Send',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['new', 'reply', 'forward'],
          description: 'Action to perform'
        },
        account: { type: 'string', description: 'Sender account email (required)' },
        to: {
          type: 'string',
          description:
            'Recipient email address (required for new/forward, optional for reply - auto-derived from original sender)'
        },
        subject: { type: 'string', description: 'Email subject (required for new)' },
        body: {
          type: 'string',
          description:
            'Email body (required). Use plain text for simple messages. Use HTML tags (<b>, <i>, <a href="...">, <br>, <table>) for rich formatting. Do NOT mix: send either plain text or HTML, not both.'
        },
        cc: { type: 'string', description: 'CC recipients (comma-separated)' },
        bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
        uid: { type: 'number', description: 'Original email UID (required for reply/forward)' },
        folder: { type: 'string', description: 'Folder of original email (default: INBOX)' }
      },
      required: ['action', 'account', 'body']
    }
  },
  {
    name: 'config',
    description:
      'Manage email credential setup and runtime configuration.\n\nSetup actions (credential lifecycle):\n- status: Show current credential state, setup URL, and configured accounts\n- setup_start (-> force): Trigger relay setup session and return the setup URL. Set force=true to restart even if already in progress\n- setup_reset: Clear all saved credentials and reset to awaiting_setup state\n- setup_complete: Re-check credential state after external config changes (e.g. relay submission)\n\nRuntime actions:\n- set: Update runtime settings (email has no runtime settings; returns ok=false)\n- cache_clear: Clear in-memory account and OAuth token caches\n\nMicrosoft Graph (Outlook rules) — a second sign-in:\n- graph_auth_start (-> account): start device-code sign-in; returns verification_uri + user_code\n- graph_auth_status (-> account): whether Graph is signed in',
    annotations: {
      title: 'Config',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'setup_start',
            'setup_reset',
            'setup_complete',
            'set',
            'cache_clear',
            'graph_auth_start',
            'graph_auth_status'
          ],
          description: 'Action to perform'
        },
        force: {
          type: 'boolean',
          description: 'Force restart relay setup even if already in progress (for setup_start action)'
        },
        account: { type: 'string', description: 'Account email (for graph_auth_*)' }
      },
      required: ['action']
    }
  },
  {
    name: 'rules',
    description:
      'Server-side Outlook inbox rules (Microsoft Graph messageRules). Rules run inside Outlook even when no agent is running.\n\nActions (required params -> optional):\n- list (-> account): all rules in order, folder actions shown as folder paths\n- create (rule -> account): rule = {displayName, conditions, actions, exceptions?, sequence?, isEnabled?}\n- update (rule_id, rule -> account): partial update\n- delete (rule_id -> account)\n\nconditions/exceptions use Graph messageRulePredicates, e.g. {"senderContains": ["@amazon.com"]}, {"subjectContains": ["receipt"]}, {"fromAddresses": [{"emailAddress": {"address": "a@b.com"}}]}.\nactions: moveToFolder / copyToFolder take a folder PATH (e.g. "Receipts/Amazon"; create it first with folders create), plus markAsRead, markImportance, assignCategories, stopProcessingRules. Deleting or forwarding actions are refused.\nRequires a one-time Graph sign-in (config graph_auth_start).',
    annotations: {
      title: 'Rules',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Action to perform' },
        account: { type: 'string', description: 'Account email (optional with a single account)' },
        rule_id: { type: 'string', description: 'Rule id from list (update/delete)' },
        rule: {
          type: 'object',
          description: 'Rule body: displayName, sequence, isEnabled, conditions, exceptions, actions',
          additionalProperties: true
        }
      },
      required: ['action']
    }
  },
  {
    name: 'drafts',
    description:
      'Email drafts (Microsoft Graph). Drafts are the review step before anything is sent: write a draft, a person reviews it, then send it.\n\nActions (required params -> optional):\n- reply (message_id | uid -> folder, body, body_type, reply_all, to, cc): draft a threaded reply to an existing email (Outlook\'s own reply: keeps the thread, "RE:" subject, quoted original and recipients). Your body goes above the quote. The usual way to answer an email.\n- create (subject | body -> to, cc, body_type): draft a brand-new email\n- update (draft_id -> subject, body, body_type, to, cc): revise a draft\n- list (-> limit=25): drafts, newest first\n- send (draft_id): send an EXISTING draft. Refused unless the message is an unsent draft in the Drafts folder with at least one recipient.\n\nbody_type: "text" (default) or "html". message_id comes from messages search/read.',
    annotations: {
      title: 'Drafts',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['reply', 'create', 'update', 'list', 'send'],
          description: 'Action to perform'
        },
        account: { type: 'string', description: 'Account email (optional with a single account)' },
        message_id: { type: 'string', description: 'Message-ID of the email to reply to (from messages search/read)' },
        uid: { type: 'number', description: 'IMAP uid of the email to reply to (alternative to message_id)' },
        folder: { type: 'string', description: 'Folder of uid (default: INBOX)' },
        reply_all: { type: 'boolean', description: 'Reply to all (reply action)' },
        draft_id: { type: 'string', description: 'Draft id (update/send)' },
        to: { type: 'string', description: 'Recipients, comma-separated' },
        cc: { type: 'string', description: 'CC recipients, comma-separated' },
        subject: { type: 'string', description: 'Subject (create/update)' },
        body: { type: 'string', description: 'Body text (or HTML with body_type=html)' },
        body_type: { type: 'string', enum: ['text', 'html'], description: 'Body format (default: text)' },
        limit: { type: 'number', description: 'Max drafts for list (default 25)' }
      },
      required: ['action']
    }
  },
  {
    name: 'calendar',
    description:
      'Outlook calendars (Microsoft Graph), including calendars shared with you. Calendars are chosen by NAME (e.g. "Pape family calendar"); omitted = your default calendar. Times are local wall-clock, America/Chicago unless time_zone is set.\n\nActions (required params -> optional):\n- list: calendars with name, can_edit, owner\n- events (-> calendar, start=today, end=start+14d, limit=50): events in a range; start/end as YYYY-MM-DD or YYYY-MM-DDTHH:MM\n- create_event (subject, start, end -> calendar, all_day, location, body, show_as, reminder_minutes, time_zone)\n- update_event (event_id -> any create field; start and end together)\n- delete_event (event_id)\n\nTimed: start/end "2026-11-13T13:30". All-day: all_day=true, start/end dates, end EXCLUSIVE (one day = start + 1). No attendees: events never send invitations.',
    annotations: {
      title: 'Calendar',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'events', 'create_event', 'update_event', 'delete_event'],
          description: 'Action to perform'
        },
        account: { type: 'string', description: 'Account email (optional with a single account)' },
        calendar: { type: 'string', description: 'Calendar name (from list); omitted = default calendar' },
        start: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM-DDTHH:MM (local)' },
        end: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM-DDTHH:MM (local); all-day end is exclusive' },
        limit: { type: 'number', description: 'Max events (events action, default 50)' },
        event_id: { type: 'string', description: 'Event id (update/delete)' },
        subject: { type: 'string', description: 'Event title' },
        location: { type: 'string' },
        body: { type: 'string', description: 'Notes (plain text)' },
        all_day: { type: 'boolean' },
        time_zone: { type: 'string', description: 'IANA zone, default America/Chicago' },
        show_as: { type: 'string', enum: ['free', 'tentative', 'busy', 'oof', 'workingElsewhere'] },
        reminder_minutes: { type: 'number', description: 'Minutes before start; -1 = no reminder' }
      },
      required: ['action']
    }
  },
  {
    name: 'config__open_relay',
    description:
      'Open the relay configuration form for better-email-mcp in the user browser. Returns the relay URL, whether the browser launched, and the current credential state. Auto-respawns the daemon if it has died.',
    annotations: {
      title: 'Open Relay',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'help',
    description: 'Get full documentation for a tool. Use when compressed descriptions are insufficient.',
    annotations: {
      title: 'Help',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          enum: ['messages', 'folders', 'attachments', 'send', 'config', 'rules', 'drafts', 'calendar', 'help'],
          description: 'Tool to get documentation for'
        }
      },
      required: ['tool_name']
    }
  }
]

/**
 * Register all tools with MCP server
 */

async function handleHelp(args: unknown): Promise<{ tool: string; documentation: string }> {
  const toolName = (args as { tool_name: string }).tool_name
  if (!isValidToolName(toolName)) {
    throw new EmailMCPError(
      `Invalid tool name: ${toolName}`,
      'VALIDATION_ERROR',
      'Valid: messages, folders, attachments, send, config, rules, drafts, calendar, help'
    )
  }
  const resource = RESOURCES.find((r) => r.uri === `email://docs/${toolName}`)
  if (!resource) {
    throw new EmailMCPError(`Documentation not found for: ${toolName}`, 'DOC_NOT_FOUND', 'Check tool_name')
  }
  try {
    const content = await readFile(join(DOCS_DIR, resource.file), 'utf-8')
    return { tool: toolName, documentation: content }
  } catch {
    throw new EmailMCPError(`Documentation not found for: ${toolName}`, 'DOC_NOT_FOUND', 'Check tool_name')
  }
}

type ToolHandler = (accounts: AccountConfig[], args: unknown) => Promise<unknown>

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  messages: (accounts, args) => messages(accounts, args as unknown as MessagesInput),
  folders: (accounts, args) => folders(accounts, args as unknown as FoldersInput),
  attachments: (accounts, args) => attachments(accounts, args as unknown as AttachmentsInput),
  send: (accounts, args) => send(accounts, args as unknown as SendInput),
  config: (accounts, args) => handleConfig(accounts, args as unknown as ConfigInput),
  rules: (accounts, args) => rules(accounts, args as unknown as RulesInput),
  drafts: (accounts, args) => drafts(accounts, args as unknown as DraftsInput),
  calendar: (accounts, args) => calendar(accounts, args as unknown as CalendarInput),
  help: (_, args) => handleHelp(args)
}

// Pre-compute derived values to avoid redundant allocations on every request
const FORMATTED_RESOURCES = RESOURCES.map((r) => ({
  uri: r.uri,
  name: r.name,
  mimeType: 'text/markdown'
}))
const AVAILABLE_RESOURCE_URIS_STRING = RESOURCES.map((r) => r.uri).join(', ')
const VALID_TOOL_NAMES = TOOLS.map((t) => t.name)
const AVAILABLE_TOOLS_STRING = VALID_TOOL_NAMES.join(', ')

export function registerTools(server: Server, initialAccounts: AccountConfig[]) {
  // Mutable reference: updated via hot-reload when relay credentials arrive after startup
  let accounts = initialAccounts
  const openRelayHandler = buildOpenRelayHandler({
    serverName: 'better-email-mcp',
    publicUrl: process.env.PUBLIC_URL ?? null
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
  }))

  // Resources handlers for full documentation
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: FORMATTED_RESOURCES
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    const resource = RESOURCES.find((r) => r.uri === uri)

    if (!resource) {
      throw new EmailMCPError(
        `Resource not found: ${uri}`,
        'RESOURCE_NOT_FOUND',
        `Available: ${AVAILABLE_RESOURCE_URIS_STRING}`
      )
    }

    const content = await readFile(join(DOCS_DIR, resource.file), 'utf-8')
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: content }]
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    if (!args) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No arguments provided'
          }
        ],
        isError: true
      }
    }

    try {
      // config__open_relay is handled directly via buildOpenRelayHandler — it does
      // not depend on configured accounts, takes no args, and returns its own JSON
      // shape (url, browserOpened, status, etc.).
      if (name === 'config__open_relay') {
        const result = await openRelayHandler()
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
      }

      const handler = TOOL_HANDLERS[name]
      if (!handler) {
        const closest = findClosestMatch(name, VALID_TOOL_NAMES)
        const suggestion = closest ? ` Did you mean '${closest}'?` : ''
        throw new EmailMCPError(
          `Unknown tool: ${name}.${suggestion}`,
          'UNKNOWN_TOOL',
          `Available tools: ${AVAILABLE_TOOLS_STRING}`
        )
      }

      // Credential guard: when not configured, return setup instructions.
      // Help, config, and config__open_relay tools are always available (docs don't
      // need credentials; config and config__open_relay manage the credential
      // lifecycle itself). In stdio mode, missing creds are caught up-front in
      // init-server.ts (process.exit(1)). In HTTP mode, the /authorize relay
      // form runs in the same process — the user opens it via config__open_relay.
      if (name !== 'help' && name !== 'config' && name !== 'config__open_relay' && accounts.length === 0) {
        const credState = getState()
        if (credState === 'configured') {
          // Hot-reload: relay delivered credentials after startup — reload accounts
          accounts = await loadConfig()
        } else {
          const url = getSetupUrl()
          const setupInstructions = url
            ? `Email credentials are not configured yet.\n\nTo set up, open this URL in your browser:\n${url}\n\nAfter submitting credentials on the relay page, retry this tool call.`
            : `Email credentials are not configured.\n\nIn stdio mode: set EMAIL_PROVIDER + EMAIL_USER + EMAIL_APP_PASSWORD env vars.\nIn HTTP mode: call config__open_relay to open the /authorize browser form.`
          return {
            content: [{ type: 'text', text: setupInstructions }],
            isError: true
          }
        }
      }

      const result = await handler(accounts, args)

      const jsonText = JSON.stringify(result, null, 2)
      return {
        content: [
          {
            type: 'text',
            text: wrapToolResult(name, jsonText)
          }
        ]
      }
    } catch (error) {
      const enhancedError = error instanceof EmailMCPError ? error : enhanceError(error)

      return {
        content: [
          {
            type: 'text',
            text: aiReadableMessage(enhancedError)
          }
        ],
        isError: true
      }
    }
  })
}
