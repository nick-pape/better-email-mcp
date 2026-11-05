# calendar

Outlook calendars through Microsoft Graph, including calendars shared with the
user. **pape-house fork addition.** Uses the Graph sign-in (`config`
`graph_auth_start`) with `Calendars.ReadWrite` (+ `.Shared`).

| Action | Required | Optional |
|---|---|---|
| `list` | | |
| `events` | | `calendar`, `start` (today), `end` (start + 14 days), `limit` |
| `create_event` | `subject`, `start`, `end` | `calendar`, `all_day`, `location`, `body`, `show_as`, `reminder_minutes`, `time_zone` |
| `update_event` | `event_id` | any create field (`start` + `end` together) |
| `delete_event` | `event_id` | |

- Calendars are chosen by name (case-insensitive); omitted = default calendar.
- Times are local wall-clock (`2026-11-13T13:30`), `America/Chicago` unless
  `time_zone` is given. All-day: `all_day=true`, dates, `end` exclusive.
- No attendees, on purpose: attendees make Outlook email invitations, which
  would be sending mail outside the drafts + approval path.
