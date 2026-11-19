import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountConfig } from '../helpers/config.js'

const graphRequest = vi.fn()
vi.mock('../helpers/graph.js', () => ({
  graphRequest: (...a: unknown[]) => graphRequest(...a),
  folderIdToPath: async () => new Map([['F1', 'Inbox/Recruiting']]),
  resolveFolderId: async (_a: unknown, p: string) => p
}))

const { rules } = await import('./rules.js')

const account = { id: 'me', email: 'me@outlook.com' } as AccountConfig
const rule = { id: 'R1', displayName: 'Recruiting (senders)', sequence: 26, actions: { moveToFolder: 'F1' } }

beforeEach(() => {
  graphRequest.mockReset()
  graphRequest.mockImplementation(async (_a: unknown, method: string) => (method === 'DELETE' ? undefined : rule))
})

const methods = () => graphRequest.mock.calls.map(([, m]) => m)

describe('rules expected_folder guard (pape-house fork)', () => {
  it('requires expected_folder on delete, before any Graph call', async () => {
    await expect(rules([account], { action: 'delete', rule_id: 'R1' })).rejects.toThrow(/expected_folder/)
    expect(graphRequest).not.toHaveBeenCalled()
  })

  it('requires expected_folder on update', async () => {
    await expect(rules([account], { action: 'update', rule_id: 'R1', rule: { isEnabled: false } })).rejects.toThrow(
      /expected_folder/
    )
  })

  it('refuses a delete when the rule targets another folder', async () => {
    await expect(
      rules([account], { action: 'delete', rule_id: 'R1', expected_folder: 'Inbox/Shipping' })
    ).rejects.toThrow(/Recruiting \(senders\).*Inbox\/Recruiting, not Inbox\/Shipping/)
    expect(methods()).toEqual(['GET'])
  })

  it('deletes when the folder matches (case and slashes ignored)', async () => {
    const out = await rules([account], { action: 'delete', rule_id: 'R1', expected_folder: '/inbox/recruiting/' })
    expect(out.deleted).toBe(true)
    expect(methods()).toEqual(['GET', 'DELETE'])
  })

  it('updates when the folder matches', async () => {
    await rules([account], {
      action: 'update',
      rule_id: 'R1',
      expected_folder: 'Inbox/Recruiting',
      rule: { isEnabled: false }
    })
    expect(methods()).toEqual(['GET', 'PATCH'])
  })

  it('accepts "none" for a rule with no folder action', async () => {
    graphRequest.mockImplementation(async (_a: unknown, method: string) =>
      method === 'DELETE' ? undefined : { ...rule, actions: { markAsRead: true } }
    )
    await expect(rules([account], { action: 'delete', rule_id: 'R1', expected_folder: 'Inbox/Recruiting' })).rejects.toThrow(
      /no folder/
    )
    const out = await rules([account], { action: 'delete', rule_id: 'R1', expected_folder: 'none' })
    expect(out.deleted).toBe(true)
  })
})
