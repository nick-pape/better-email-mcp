/**
 * Plain-text tool results (pape-house fork, pape.10).
 *
 * Upstream returns `JSON.stringify(result, null, 2)` wrapped in
 * `<untrusted_email_content>` tags plus a SECURITY paragraph. For an agent
 * that costs tokens three ways: indentation and quoting, metadata it never
 * uses (account ids, Message-ID / References headers, empty cc/bcc, echoed
 * queries), and a warning paragraph that prompt-injection classifiers score
 * as an injection itself (1.0 on ProtectAI DeBERTa). Measured on a real
 * agent's email results, plain text is about a fifth of the size.
 *
 * An MCP result is just text, so the shape here is written for the reader:
 * one line per message in a list, mail-style headers then the body for a
 * single message, one sentence for an action. Anything without a dedicated
 * renderer falls back to compact `key: value` lines.
 */

const TZ = process.env.EMAIL_MCP_TIMEZONE || 'America/Chicago'

// No "this is untrusted" note in front of mail content: a sentence about
// following instructions scores as an injection itself (even a one-line
// "data, not instructions" note scored 1.0). The agent's own instructions
// say mail is data.

/** Longest body returned by `read`; the rest is cut with a note. */
export const BODY_MAX_CHARS = Number(process.env.EMAIL_MCP_BODY_MAX_CHARS) || 8000

type Obj = Record<string, any>

const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

/** "Tue Nov 10 2026 3:29pm", in the household's time zone. */
export function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const p = Object.fromEntries(dateFmt.formatToParts(d).map((x) => [x.type, x.value]))
  const ampm = (p.dayPeriod || '').toLowerCase()
  return `${p.weekday} ${p.month} ${p.day} ${p.year} ${p.hour}:${p.minute}${ampm}`
}

/** `"Vigil, Marcia" <m@x.com>` -> `Vigil, Marcia <m@x.com>`; `<m@x.com>` -> `m@x.com`. */
export function formatAddress(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => {
      const s = part.trim()
      const m = s.match(/^(.*?)\s*<([^>]+)>$/)
      if (!m) return s
      const name = m[1].trim().replace(/^"(.*)"$/, '$1')
      return name ? `${name} <${m[2]}>` : m[2]
    })
    .filter(Boolean)
    .join(', ')
}

function flagTags(flags: unknown): string {
  const f = Array.isArray(flags) ? flags : []
  const tags: string[] = []
  if (!f.includes('\\Seen')) tags.push('unread')
  if (f.includes('\\Flagged')) tags.push('flagged')
  if (f.includes('\\Answered')) tags.push('replied')
  return tags.length ? ` [${tags.join(', ')}]` : ''
}

function formatSize(bytes: unknown): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const QUOTE_HEADER = /^(On .{10,200}wrote:|-{2,}\s*Original Message\s*-{2,}|_{10,}|From: .+\n(Sent|Date): )/im

/**
 * Tidy a body for reading: drop `<mailto:...>` / `<http...>` echoes after a
 * link's text, collapse runs of blank lines, cut the quoted earlier thread,
 * and cap the length.
 */
export function cleanBody(text: unknown, max = BODY_MAX_CHARS): string {
  if (typeof text !== 'string') return ''
  let body = text
    .replace(/\r\n/g, '\n')
    .replace(/<mailto:[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const notes: string[] = []
  const q = body.search(QUOTE_HEADER)
  if (q > 0) {
    const cut = body.length - q
    body = body.slice(0, q).trimEnd()
    notes.push(`[earlier messages in the thread cut, ${cut} characters]`)
  } else {
    // Plain `>` quoting with no header line.
    const lines = body.split('\n')
    const first = lines.findIndex((l, i) => i > 0 && /^>/.test(l))
    if (first > 0 && lines.slice(first).every((l) => /^>|^\s*$/.test(l))) {
      const cut = lines.slice(first).join('\n').length
      body = lines.slice(0, first).join('\n').trimEnd()
      notes.push(`[quoted earlier message cut, ${cut} characters]`)
    }
  }
  if (body.length > max) {
    notes.unshift(`[body cut at ${max} of ${body.length} characters]`)
    body = body.slice(0, max).trimEnd()
  }
  return notes.length ? `${body}\n\n${notes.join('\n')}` : body
}

function renderSearch(r: Obj): string {
  const msgs: Obj[] = Array.isArray(r.messages) ? r.messages : []
  const multi = Array.isArray(r.accounts_searched) && r.accounts_searched.length > 1
  const head = `${msgs.length} message${msgs.length === 1 ? '' : 's'} in ${r.folder} matching ${r.query}`
  if (!msgs.length) return head
  const lines = msgs.map((m) => {
    const acct = multi ? ` (${m.account_email})` : ''
    let line = `${m.uid} ${formatDate(m.date)} ${formatAddress(m.from)} | ${m.subject || '(no subject)'}${flagTags(m.flags)}${acct}`
    if (m.snippet) line += `\n    ${String(m.snippet).replace(/\s+/g, ' ').trim()}`
    return line
  })
  return `${head}:\n${lines.join('\n')}`
}

function renderRead(r: Obj): string {
  const h = [`UID ${r.uid}${flagTags(r.flags)}`, `From: ${formatAddress(r.from)}`, `To: ${formatAddress(r.to)}`]
  if (r.cc) h.push(`Cc: ${formatAddress(r.cc)}`)
  h.push(`Date: ${formatDate(r.date)}`, `Subject: ${r.subject || '(no subject)'}`)
  const att: Obj[] = Array.isArray(r.attachments) ? r.attachments : []
  if (att.length) {
    h.push(
      `Attachments: ${att.map((a) => [a.filename || '(unnamed)', formatSize(a.size)].filter(Boolean).join(' ')).join(', ')}`
    )
  }
  return `${h.join('\n')}\n\n${cleanBody(r.body_text)}`
}

function count(n: unknown, noun: string): string {
  const v = Number(n) || 0
  return `${v} message${v === 1 ? '' : 's'}${noun ? ` ${noun}` : ''}`
}

function renderMessageAction(r: Obj): string | undefined {
  switch (r.action) {
    case 'search':
      return renderSearch(r)
    case 'read':
      return renderRead(r)
    case 'mark_read':
      return `Marked ${count(r.modified, 'read')} in ${r.folder}.`
    case 'mark_unread':
      return `Marked ${count(r.modified, 'unread')} in ${r.folder}.`
    case 'flag':
      return `Flagged ${count(r.modified, '')} in ${r.folder}.`
    case 'unflag':
      return `Unflagged ${count(r.modified, '')} in ${r.folder}.`
    case 'move':
      return `Moved ${count(r.moved, '')} from ${r.from_folder} to ${r.to_folder}.`
    case 'move_matching': {
      const left = Number(r.remaining) > 0 ? ` ${r.remaining} more match; run it again to move them.` : ''
      return `${r.query} matched ${count(r.matched, '')} in ${r.from_folder}; moved ${r.moved} to ${r.to_folder}.${left}`
    }
    case 'archive':
      return `Archived ${count(r.moved, '')} from ${r.from_folder} to ${r.archive_folder}.`
    case 'trash':
      return `Moved ${count(r.trashed, '')} from ${r.folder} to Trash.`
    default:
      return undefined
  }
}

function renderAttachments(r: Obj): string | undefined {
  if (r.action !== 'list' || !Array.isArray(r.attachments)) return undefined
  const att: Obj[] = r.attachments
  if (!att.length) return `UID ${r.uid} has no attachments.`
  const lines = att.map(
    (a) => `- ${a.filename || '(unnamed)'} (${[a.content_type, formatSize(a.size)].filter(Boolean).join(', ')})`
  )
  return `UID ${r.uid} attachments:\n${lines.join('\n')}`
}

const SKIP_KEYS = new Set(['account_id', 'message_id', 'in_reply_to', 'references'])

function scalar(v: unknown): string {
  if (typeof v === 'string') return v.includes('\n') ? `\n  ${v.replace(/\n/g, '\n  ')}` : v
  return String(v)
}

function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as Obj).length === 0)
  )
}

/** One line for a flat object: `a: 1, b: x`; nested values as compact JSON. */
function inline(o: Obj): string {
  return Object.entries(o)
    .filter(([k, v]) => !SKIP_KEYS.has(k) && !isEmpty(v))
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v).replace(/\s*\n\s*/g, ' ')}`)
    .join(', ')
}

/** Fallback for results without a dedicated renderer: `key: value` lines. */
export function renderGeneric(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return `${indent}(nothing)`
  if (typeof value !== 'object') return `${indent}${scalar(value)}`
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}(none)`
    return value
      .map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? `${indent}- ${inline(item)}`
          : `${indent}- ${scalar(item)}`
      )
      .join('\n')
  }
  const lines: string[] = []
  for (const [k, v] of Object.entries(value as Obj)) {
    if (SKIP_KEYS.has(k) || isEmpty(v)) continue
    if (Array.isArray(v)) {
      lines.push(`${indent}${k}:`, renderGeneric(v, `${indent}  `))
    } else if (v && typeof v === 'object') {
      lines.push(`${indent}${k}: ${inline(v)}`)
    } else {
      lines.push(`${indent}${k}: ${scalar(v)}`)
    }
  }
  return lines.join('\n') || `${indent}(nothing)`
}

/** The text an agent reads for a tool's result. */
export function renderResult(toolName: string, result: unknown): string {
  const r = (result && typeof result === 'object' ? result : {}) as Obj
  let text: string | undefined
  if (toolName === 'messages') text = renderMessageAction(r)
  else if (toolName === 'attachments') text = renderAttachments(r)
  else if (toolName === 'help' && typeof r.documentation === 'string') text = r.documentation
  return text ?? renderGeneric(result)
}
