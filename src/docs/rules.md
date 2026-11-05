# rules

Server-side Outlook inbox rules through Microsoft Graph (`/me/mailFolders/inbox/messageRules`).
Rules run inside Outlook, so they keep filing mail when no agent is running.

**pape-house fork addition.** Needs a one-time Graph sign-in: `config` action
`graph_auth_start`, then open the returned URL and enter the code. The app
registration in `OUTLOOK_CLIENT_ID` must list the delegated Graph permissions
`MailboxSettings.ReadWrite`, `Mail.ReadWrite` and `offline_access`.

## Actions

| Action | Required | Optional |
|---|---|---|
| `list` | | `account` |
| `create` | `rule` | `account` |
| `update` | `rule_id`, `rule` (partial) | `account` |
| `delete` | `rule_id` | `account` |

## Rule body

```json
{
  "displayName": "Amazon receipts",
  "conditions": { "senderContains": ["@amazon.com"], "subjectContains": ["order"] },
  "actions": { "moveToFolder": "Receipts/Amazon", "markAsRead": true, "stopProcessingRules": true }
}
```

- `conditions` / `exceptions`: Graph `messageRulePredicates` (`senderContains`,
  `fromAddresses`, `subjectContains`, `bodyOrSubjectContains`, `headerContains`,
  `sentToMe`, `hasAttachments`, `importance`, ...).
- `actions.moveToFolder` / `copyToFolder`: a folder **path** as shown by
  `folders list`. Create the folder first with `folders create`.
- Refused actions: `delete`, `permanentDelete`, `forwardTo`,
  `forwardAsAttachmentTo`, `redirectTo`. Those must be set by a person in Outlook.
- `sequence` defaults to after the last rule; `isEnabled` defaults to `true`.
