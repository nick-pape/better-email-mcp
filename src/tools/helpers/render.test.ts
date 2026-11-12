import { describe, expect, it } from 'vitest'
import { cleanBody, formatAddress, formatDate, renderGeneric, renderResult } from './render.js'

describe('render (pape.10)', () => {
  it('formats dates in the household time zone', () => {
    expect(formatDate('2026-11-10T21:29:19.000Z')).toBe('Tue Nov 10 2026 3:29pm')
    expect(formatDate('not a date')).toBe('not a date')
  })

  it('cleans addresses', () => {
    expect(formatAddress('"Hensley Vigil, Marcia" <marcia@fmr.com>')).toBe('Hensley Vigil, Marcia <marcia@fmr.com>')
    expect(formatAddress('<eli@altertx.com>')).toBe('eli@altertx.com')
    expect(formatAddress('"Nick Pape" <n@x.com>, a@b.com')).toBe('Nick Pape <n@x.com>, a@b.com')
  })

  it('renders a search as one line per message, without ids and envelope noise', () => {
    const text = renderResult('messages', {
      action: 'search',
      query: 'SINCE 2026-11-10',
      folder: 'INBOX',
      total: 2,
      accounts_searched: ['nickpape@outlook.com'],
      messages: [
        {
          account_id: 'nickpape_outlook_com',
          account_email: 'nickpape@outlook.com',
          uid: 506486,
          message_id: '<CAKjh@mail.gmail.com>',
          subject: 'Re: Engineering evaluation',
          from: '<eli@altertx.com>',
          to: 'nickpape@outlook.com',
          date: '2026-11-10T18:03:28.000Z',
          flags: ['\\Seen'],
          snippet: ''
        },
        {
          account_id: 'nickpape_outlook_com',
          account_email: 'nickpape@outlook.com',
          uid: 506493,
          subject: 'Fidelity support',
          from: '"Vigil, Marcia" <m@fmr.com>',
          to: 'nickpape@outlook.com',
          date: '2026-11-10T21:29:19.000Z',
          flags: ['\\Flagged'],
          snippet: ''
        }
      ]
    })
    expect(text).toBe(
      '2 messages in INBOX matching SINCE 2026-11-10:\n' +
        '506486 Tue Nov 10 2026 12:03pm eli@altertx.com | Re: Engineering evaluation\n' +
        '506493 Tue Nov 10 2026 3:29pm Vigil, Marcia <m@fmr.com> | Fidelity support [unread, flagged]'
    )
    expect(text).not.toContain('{')
    expect(text).not.toContain('account_id')
  })

  it('renders a read as mail headers then the body', () => {
    const text = renderResult('messages', {
      action: 'read',
      account_id: 'x',
      uid: 7,
      message_id: '<id@x>',
      references: '<a@x> <b@x>',
      subject: 'Hello',
      from: '"A B" <a@b.com>',
      to: 'nickpape@outlook.com',
      cc: '',
      bcc: '',
      date: '2026-11-10T21:29:19.000Z',
      flags: ['\\Seen'],
      body_text:
        'Hi Nick,\n\n\n\nMail me at a@b.com<mailto:a@b.com>.\n\nOn Mon, Nov 9, 2026 at 1:00 PM Nick <n@x.com> wrote:\n> old',
      attachments: [{ filename: 'quote.pdf', content_type: 'application/pdf', size: 204800 }]
    })
    expect(text).toBe(
      'UID 7\nFrom: A B <a@b.com>\nTo: nickpape@outlook.com\n' +
        'Date: Tue Nov 10 2026 3:29pm\nSubject: Hello\nAttachments: quote.pdf 200 KB\n\n' +
        'Hi Nick,\n\nMail me at a@b.com.\n\n[earlier messages in the thread cut, 58 characters]'
    )
  })

  it('caps long bodies', () => {
    const out = cleanBody('x'.repeat(50), 20)
    expect(out).toBe(`${'x'.repeat(20)}\n\n[body cut at 20 of 50 characters]`)
  })

  it('cuts trailing > quoting', () => {
    expect(cleanBody('Sounds good.\n> earlier\n> more')).toBe(
      'Sounds good.\n\n[quoted earlier message cut, 16 characters]'
    )
  })

  it('renders actions as one sentence', () => {
    expect(
      renderResult('messages', {
        action: 'move_matching',
        account: 'n@x.com',
        query: 'FROM a@b.com',
        from_folder: 'INBOX',
        to_folder: 'Receipts',
        success: true,
        matched: 14,
        moved: 14,
        remaining: 0
      })
    ).toBe('FROM a@b.com matched 14 messages in INBOX; moved 14 to Receipts.')
    expect(renderResult('messages', { action: 'mark_read', folder: 'INBOX', modified: 1 })).toBe(
      'Marked 1 message read in INBOX.'
    )
  })

  it('returns help documentation as-is', () => {
    expect(renderResult('help', { tool: 'messages', documentation: '# Messages\nDocs' })).toBe('# Messages\nDocs')
  })

  it('falls back to key: value lines', () => {
    expect(
      renderGeneric({
        action: 'list',
        account: 'n@x.com',
        empty: '',
        rules: [{ id: 'r1', displayName: 'Receipts', isEnabled: true, actions: { moveToFolder: 'Receipts' } }]
      })
    ).toBe(
      'action: list\naccount: n@x.com\nrules:\n  - id: r1, displayName: Receipts, isEnabled: true, actions: {"moveToFolder":"Receipts"}'
    )
  })
})
