/**
 * Calendar Mega Tool (pape-house fork)
 *
 * Outlook calendars over Microsoft Graph (same second sign-in as rules and
 * drafts; needs Calendars.ReadWrite, plus .Shared for calendars shared with
 * the user). Calendars are addressed by NAME ("Pape family calendar").
 *
 * Deliberately no attendees: adding attendees makes Outlook email meeting
 * invitations, which is sending mail without the drafts + approval path.
 * Events are entries on a calendar, nothing more.
 */

import type { AccountConfig } from '../helpers/config.js'
import { resolveSingleAccount } from '../helpers/config.js'
import { createUnknownActionError, EmailMCPError, withErrorHandling } from '../helpers/errors.js'
import { graphRequest } from '../helpers/graph.js'

export interface CalendarInput {
  action: 'list' | 'events' | 'create_event' | 'update_event' | 'delete_event'
  account?: string
  calendar?: string
  // events
  start?: string
  end?: string
  limit?: number
  // create / update
  event_id?: string
  subject?: string
  location?: string
  body?: string
  all_day?: boolean
  time_zone?: string
  show_as?: 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere'
  reminder_minutes?: number
}

const DEFAULT_TZ = 'America/Chicago'
const EVENT_SELECT = 'id,subject,start,end,isAllDay,location,bodyPreview,showAs,webLink,organizer'

export async function calendar(accounts: AccountConfig[], input: CalendarInput): Promise<any> {
  return withErrorHandling(async () => {
    const account = resolveSingleAccount(accounts, input.account)
    switch (input.action) {
      case 'list':
        return await handleList(account)
      case 'events':
        return await handleEvents(account, input)
      case 'create_event':
        return await handleCreate(account, input)
      case 'update_event':
        return await handleUpdate(account, input)
      case 'delete_event':
        return await handleDelete(account, input)
      default:
        throw createUnknownActionError(input.action, 'list, events, create_event, update_event, delete_event')
    }
  })()
}

interface Cal {
  id: string
  name: string
  canEdit?: boolean
  isDefaultCalendar?: boolean
  owner?: { name?: string; address?: string }
}

async function allCalendars(account: AccountConfig): Promise<Cal[]> {
  const page = await graphRequest<{ value: Cal[] }>(
    account,
    'GET',
    '/me/calendars?$top=100&$select=id,name,canEdit,isDefaultCalendar,owner'
  )
  return page.value
}

/** Calendar by name (case-insensitive); omitted = the default calendar. */
export async function resolveCalendar(account: AccountConfig, name?: string): Promise<Cal> {
  const cals = await allCalendars(account)
  const want = name?.trim().toLowerCase()
  const hit = want ? cals.find((c) => c.name.trim().toLowerCase() === want) : cals.find((c) => c.isDefaultCalendar)
  if (!hit) {
    throw new EmailMCPError(
      `Calendar not found: ${name ?? '(default)'}`,
      'CALENDAR_NOT_FOUND',
      `Available: ${cals.map((c) => c.name).join(', ')}`
    )
  }
  return hit
}

function tz(input: CalendarInput): string {
  return input.time_zone || DEFAULT_TZ
}

function tzHeader(input: CalendarInput): Record<string, string> {
  return { Prefer: `outlook.timezone="${tz(input).replace(/"/g, '')}"` }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

/** Graph dateTimeTimeZone from a local "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM[:SS]". */
function when(value: string, allDay: boolean, zone: string): { dateTime: string; timeZone: string } {
  const v = value.trim()
  if (allDay) {
    if (!DATE.test(v)) throw new EmailMCPError(`All-day dates must be YYYY-MM-DD: ${value}`, 'VALIDATION_ERROR')
    return { dateTime: `${v}T00:00:00`, timeZone: zone }
  }
  if (!DATETIME.test(v)) {
    throw new EmailMCPError(
      `Times must be local YYYY-MM-DDTHH:MM (no offset; time_zone sets the zone): ${value}`,
      'VALIDATION_ERROR'
    )
  }
  return { dateTime: v.length === 16 ? `${v}:00` : v, timeZone: zone }
}

function present(e: any, calName?: string): any {
  return {
    event_id: e.id,
    calendar: calName,
    subject: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    time_zone: e.start?.timeZone,
    all_day: e.isAllDay,
    location: e.location?.displayName || undefined,
    preview: e.bodyPreview || undefined,
    show_as: e.showAs,
    web_link: e.webLink
  }
}

function eventPath(input: CalendarInput): string {
  if (!input.event_id || !/^[A-Za-z0-9=_\-+/]+$/.test(input.event_id)) {
    throw new EmailMCPError('event_id is required', 'VALIDATION_ERROR', 'Get it from calendar events')
  }
  return `/me/events/${encodeURIComponent(input.event_id)}`
}

// ── actions ────────────────────────────────────────────────────────────

async function handleList(account: AccountConfig): Promise<any> {
  const cals = await allCalendars(account)
  return {
    action: 'list',
    account: account.email,
    calendars: cals.map((c) => ({
      name: c.name,
      can_edit: c.canEdit,
      default: !!c.isDefaultCalendar,
      owner: c.owner?.address
    }))
  }
}

async function handleEvents(account: AccountConfig, input: CalendarInput): Promise<any> {
  const cal = await resolveCalendar(account, input.calendar)
  const start = input.start?.trim() || new Date().toISOString().slice(0, 10)
  const startDt = DATE.test(start) ? `${start}T00:00:00` : start
  let endDt = input.end?.trim()
  if (!endDt) {
    const d = new Date(`${startDt.slice(0, 10)}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 14)
    endDt = `${d.toISOString().slice(0, 10)}T00:00:00`
  } else if (DATE.test(endDt)) {
    endDt = `${endDt}T23:59:59`
  }
  const top = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 200)
  const q = new URLSearchParams({
    startDateTime: startDt,
    endDateTime: endDt,
    $top: String(top),
    $orderby: 'start/dateTime',
    $select: EVENT_SELECT
  })
  const page = await graphRequest<{ value: any[] }>(
    account,
    'GET',
    `/me/calendars/${encodeURIComponent(cal.id)}/calendarView?${q.toString()}`,
    undefined,
    tzHeader(input)
  )
  return {
    action: 'events',
    calendar: cal.name,
    from: startDt,
    to: endDt,
    time_zone: tz(input),
    total: page.value.length,
    events: page.value.map((e) => present(e, cal.name))
  }
}

function eventBody(input: CalendarInput, partial: boolean): any {
  const out: any = {}
  if (input.subject !== undefined) out.subject = input.subject
  if (input.location !== undefined) out.location = { displayName: input.location }
  if (input.body !== undefined) out.body = { contentType: 'Text', content: input.body }
  if (input.show_as !== undefined) out.showAs = input.show_as
  if (input.reminder_minutes !== undefined) {
    out.isReminderOn = input.reminder_minutes >= 0
    if (input.reminder_minutes >= 0) out.reminderMinutesBeforeStart = Math.floor(input.reminder_minutes)
  }
  if (input.start !== undefined || input.end !== undefined || !partial) {
    if (!input.start || !input.end) {
      throw new EmailMCPError('start and end are required together', 'VALIDATION_ERROR')
    }
    const allDay = !!input.all_day
    out.isAllDay = allDay
    out.start = when(input.start, allDay, tz(input))
    out.end = when(input.end, allDay, tz(input))
  }
  return out
}

async function handleCreate(account: AccountConfig, input: CalendarInput): Promise<any> {
  if (!input.subject) throw new EmailMCPError('subject is required', 'VALIDATION_ERROR')
  const cal = await resolveCalendar(account, input.calendar)
  if (cal.canEdit === false) throw new EmailMCPError(`Calendar is read-only: ${cal.name}`, 'CALENDAR_READ_ONLY')
  const e = await graphRequest(
    account,
    'POST',
    `/me/calendars/${encodeURIComponent(cal.id)}/events`,
    eventBody(input, false),
    tzHeader(input)
  )
  return { action: 'create_event', event: present(e, cal.name) }
}

async function handleUpdate(account: AccountConfig, input: CalendarInput): Promise<any> {
  const patch = eventBody(input, true)
  if (!Object.keys(patch).length) throw new EmailMCPError('Nothing to update', 'VALIDATION_ERROR')
  const e = await graphRequest(account, 'PATCH', eventPath(input), patch, tzHeader(input))
  return { action: 'update_event', event: present(e) }
}

async function handleDelete(account: AccountConfig, input: CalendarInput): Promise<any> {
  const path = eventPath(input)
  const e = await graphRequest(account, 'GET', `${path}?$select=subject,start`, undefined, tzHeader(input))
  await graphRequest(account, 'DELETE', path)
  return {
    action: 'delete_event',
    deleted: true,
    event_id: input.event_id,
    subject: e.subject,
    start: e.start?.dateTime
  }
}
