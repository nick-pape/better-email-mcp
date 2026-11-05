import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../helpers/config.js'

const graphRequest = vi.fn()
vi.mock('../helpers/graph.js', () => ({ graphRequest: (...a: unknown[]) => graphRequest(...a) }))

const { calendar } = await import('./calendar.js')

const account = {
  id: 'me',
  email: 'me@outlook.com',
  password: '',
  authType: 'oauth2',
  imap: { host: 'x', port: 993, secure: true },
  smtp: { host: 'x', port: 587, secure: false }
} as AccountConfig

const CALS = {
  value: [
    { id: 'C1', name: 'Calendar', canEdit: true, isDefaultCalendar: true },
    { id: 'C2', name: 'Pape family calendar', canEdit: true },
    { id: 'C3', name: 'Holidays', canEdit: false }
  ]
}

beforeEach(() => {
  graphRequest.mockReset()
  graphRequest.mockImplementation(async (_a: unknown, method: string, path: string, body?: any) => {
    if (typeof path !== 'string') return undefined
    if (path.startsWith('/me/calendars?')) return CALS
    if (method === 'POST') return { id: 'E1', ...body }
    return { value: [] }
  })
})

const posts = () => graphRequest.mock.calls.filter(([, m]) => m === 'POST')

describe('calendar (pape-house fork)', () => {
  it('creates a timed event on the named calendar in America/Chicago', async () => {
    await calendar([account], {
      action: 'create_event',
      calendar: 'pape FAMILY calendar',
      subject: 'Call with Mandi',
      start: '2026-11-13T13:30',
      end: '2026-11-13T14:00'
    })
    const [, , path, body] = posts()[0]
    expect(path).toBe('/me/calendars/C2/events')
    expect(body.start).toEqual({ dateTime: '2026-11-13T13:30:00', timeZone: 'America/Chicago' })
    expect(body.isAllDay).toBe(false)
    expect(body.attendees).toBeUndefined()
  })

  it('creates an all-day event with date-only values', async () => {
    await calendar([account], {
      action: 'create_event',
      calendar: 'Pape family calendar',
      subject: 'Field trip',
      start: '2026-11-20',
      end: '2026-11-21',
      all_day: true
    })
    expect(posts()[0][3].start.dateTime).toBe('2026-11-20T00:00:00')
  })

  it('rejects offsets / bad times and read-only calendars', async () => {
    await expect(
      calendar([account], {
        action: 'create_event',
        subject: 'x',
        start: '2026-11-13T13:30Z',
        end: '2026-11-13T14:00Z'
      })
    ).rejects.toThrow(/local/)
    await expect(
      calendar([account], {
        action: 'create_event',
        calendar: 'Holidays',
        subject: 'x',
        start: '2026-11-13T13:30',
        end: '2026-11-13T14:00'
      })
    ).rejects.toThrow(/read-only/)
    expect(posts()).toHaveLength(0)
  })

  it('names the available calendars when one is not found', async () => {
    await expect(calendar([account], { action: 'events', calendar: 'Nope' })).rejects.toThrow(/Calendar not found/)
  })
})
