import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../helpers/config.js'

const graphRequest = vi.fn()
const fetchSenders = vi.fn()
const moveEmails = vi.fn()
vi.mock('../helpers/graph.js', () => ({
  graphRequest: (...a: unknown[]) => graphRequest(...a),
  folderIdToPath: async () =>
    new Map([
      ['FP', 'Inbox/Promotions'],
      ['FB', 'Inbox/Banking']
    ]),
  resolveFolderId: async (_a: unknown, p: string) => `id:${p}`
}))
vi.mock('../helpers/imap-client.js', () => ({
  fetchSenders: (...a: unknown[]) => fetchSenders(...a),
  moveEmails: (...a: unknown[]) => moveEmails(...a)
}))

const { rules } = await import('./rules.js')

const account = { id: 'me', email: 'me@outlook.com' } as AccountConfig
const addr = (address: string) => ({ emailAddress: { name: address, address } })
const RULES = [
  {
    id: 'P',
    displayName: 'Promotions (senders)',
    sequence: 2,
    conditions: { fromAddresses: [addr('news@mktg.subway.com')] },
    actions: { moveToFolder: 'FP', stopProcessingRules: true }
  },
  {
    id: 'PD',
    displayName: 'Promotions (domains)',
    sequence: 38,
    conditions: { senderContains: ['@FACEBOOKMAIL.COM'] },
    actions: { moveToFolder: 'FP', stopProcessingRules: true }
  },
  {
    id: 'B',
    displayName: 'Banking (senders)',
    sequence: 17,
    conditions: { fromAddresses: [addr('email@alert.ally.com')] },
    actions: { moveToFolder: 'FB', markAsRead: true, stopProcessingRules: true }
  }
]

let calls: [string, string, any][]
beforeEach(() => {
  calls = []
  graphRequest.mockReset()
  graphRequest.mockImplementation(async (_a: unknown, method: string, path: string, body?: any) => {
    calls.push([method, path, body])
    return method === 'GET' ? { value: RULES } : {}
  })
  fetchSenders.mockReset()
  moveEmails.mockReset()
  moveEmails.mockImplementation(async (_a: unknown, uids: number[]) => ({ success: true, moved: uids.length }))
})
const senders = (m: Record<number, string>) =>
  fetchSenders.mockResolvedValue(new Map(Object.entries(m).map(([u, a]) => [Number(u), { address: a, name: '' }])))

describe('rules file (pape-house fork)', () => {
  it("adds a new sender to the folder's (senders) rule, keeping the others, then moves", async () => {
    senders({ 5: 'deals@avis.com' })
    const out = await rules([account], { action: 'file', folder: 'INBOX', uids: [5], destination: 'Inbox/Promotions' })
    const patch = calls.find(([m]) => m === 'PATCH')
    expect(patch?.[1]).toMatch(/messageRules\/P$/)
    expect(patch?.[2].conditions.fromAddresses.map((a: any) => a.emailAddress.address)).toEqual([
      'news@mktg.subway.com',
      'deals@avis.com'
    ])
    expect(Object.keys(patch?.[2].conditions)).toEqual(['fromAddresses'])
    expect(moveEmails).toHaveBeenCalledWith(account, [5], 'INBOX', 'Inbox/Promotions')
    expect(out).toMatchObject({ moved: 1, rule: 'Promotions (senders)', senders_added: ['deals@avis.com'] })
  })

  it('only moves when the sender is already covered (address or domain rule), case-insensitively', async () => {
    senders({ 1: 'News@Mktg.Subway.com', 2: 'notify@facebookmail.com' })
    const out = await rules([account], {
      action: 'file',
      folder: 'INBOX',
      uids: [1, 2],
      destination: 'inbox/promotions'
    })
    expect(calls.map(([m]) => m)).toEqual(['GET'])
    expect(out).toMatchObject({ moved: 2, rule: 'unchanged', senders_added: [] })
    expect(out.already_in_rule).toHaveLength(2)
  })

  it("refuses, changing nothing, when a sender belongs to another folder's rule", async () => {
    senders({ 7: 'email@alert.ally.com', 8: 'deals@avis.com' })
    await expect(
      rules([account], { action: 'file', folder: 'INBOX', uids: [7, 8], destination: 'Inbox/Promotions' })
    ).rejects.toThrow(/email@alert\.ally\.com is in "Banking \(senders\)", which files to Inbox\/Banking/)
    expect(calls.map(([m]) => m)).toEqual(['GET'])
    expect(moveEmails).not.toHaveBeenCalled()
  })

  it('creates "<folder> (senders)" when the folder has no sender rule', async () => {
    senders({ 9: 'noreply@pta.org' })
    const out = await rules([account], { action: 'file', folder: 'INBOX', uid: 9, destination: "Inbox/Kid's School" })
    const post = calls.find(([m]) => m === 'POST')
    expect(post?.[2]).toMatchObject({
      displayName: "Kid's School (senders)",
      sequence: 39,
      conditions: { fromAddresses: [{ emailAddress: { address: 'noreply@pta.org' } }] },
      actions: { moveToFolder: "id:Inbox/Kid's School", stopProcessingRules: true }
    })
    expect(out.rule).toBe("Kid's School (senders)")
  })

  it('never adds to a domain rule', async () => {
    senders({ 3: 'a@b.com' })
    await rules([account], { action: 'file', folder: 'INBOX', uids: [3], destination: 'Inbox/Promotions' })
    expect(calls.find(([m]) => m === 'PATCH')?.[1]).toMatch(/\/P$/)
  })

  it('requires folder, and refuses UIDs that are not in it', async () => {
    await expect(rules([account], { action: 'file', uids: [1], destination: 'X' })).rejects.toThrow(
      /folder is required/
    )
    senders({})
    await expect(
      rules([account], { action: 'file', folder: 'INBOX', uids: [4], destination: 'Inbox/Promotions' })
    ).rejects.toThrow(/UID 4 not found in INBOX/)
    expect(moveEmails).not.toHaveBeenCalled()
  })
})

describe('rule condition shape (pape-house fork)', () => {
  it('refuses senderContains together with fromAddresses on create and update', async () => {
    const rule = {
      displayName: 'x',
      conditions: { senderContains: ['@a.com'], fromAddresses: [addr('b@c.com')] },
      actions: { moveToFolder: 'Inbox/Promotions' }
    }
    await expect(rules([account], { action: 'create', rule })).rejects.toThrow(/both senderContains and fromAddresses/)
    await expect(
      rules([account], {
        action: 'update',
        rule_id: 'P',
        expected_folder: 'Inbox/Promotions',
        rule: { conditions: rule.conditions }
      })
    ).rejects.toThrow(/both senderContains and fromAddresses/)
    expect(calls.filter(([m]) => m !== 'GET')).toEqual([])
  })
})
