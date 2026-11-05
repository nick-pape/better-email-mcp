# drafts

Email drafts through Microsoft Graph. **pape-house fork addition.**

Drafts are the review step: write a draft, a person looks at it (in Outlook, or
via an approval prompt), then `send` it. `send` only sends an existing, never-sent
draft in the Drafts folder; there is no compose-and-send in one call.

Uses the same Graph sign-in as `rules` (`config` action `graph_auth_start`).
`send` additionally needs the delegated `Mail.Send` permission on the app
registration, granted at sign-in.

## Actions

| Action | Required | Optional |
|---|---|---|
| `reply` | `message_id` or `uid` | `folder`, `body`, `body_type`, `reply_all`, `to`, `cc` |
| `create` | `subject` or `body` | `to`, `cc`, `body_type` |
| `update` | `draft_id` | `subject`, `body`, `body_type`, `to`, `cc` |
| `list` | | `limit` (default 25) |
| `send` | `draft_id` | |

- `reply` uses Outlook's own reply (`createReply` / `createReplyAll`): same
  thread, `RE:` subject, quoted original, original recipients. Your `body` is
  placed above the quote.
- `message_id` is the `message_id` field from `messages` search/read.
- `send` refuses (`NOT_A_DRAFT`) anything that is not `isDraft` in Drafts, and a
  draft with no recipients.
