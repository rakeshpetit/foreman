---
status: accepted (grilled to shared understanding 2026-10-26; not yet built)
---

# Foreman owns a second Telegram bot for two-way talk; ntfy carries one-way reports

The knowledge repo's Telegram Bridge is wired to Pi. Its send endpoint exists only on the sandbox's compose network, and replies to its messages are routed into Pi sessions. Foreman, on the host, needs to receive Go, approvals and rejections and route them to itself. So it gets its own bot, built on the Bridge's patterns, and the Bridge stays untouched.

## Decisions

- **A second bot with its own token, held only by foreman** on the host. It long-polls outbound only, serves one Owner by numeric user ID in a private chat, drops messages from anyone else, and drops stale updates.
- **Telegram carries everything that needs a reply:** Go, Task approve/reject (Manual Mode), Milestone Approval, Escalations and their answers (with `#precedent`), Amendments, Proposals (admit/drop) and Consent.
- **ntfy** (`https://ntfy.rakesharun.site`) carries one-way pings:
  - **Task summaries** go to their own topic, `foreman-usage`, at low priority: one notification per Task listing every Run's Agent, model, tokens, context, cost and duration, plus running totals for the Request. There is **no notification per Run.**
  - Usage-limit pauses and Growth alerts go to the main topic.
- Every Run's figures are also stored in SQLite (ADR 0002) for retrospectives.

## Considered options

- **Extending the Bridge with foreman commands and publishing a port:** rejected. It couples two repos, and it weakens the Bridge's isolation guarantees (knowledge ADR 0003).
- **Notifications only, with approvals through the CLI:** rejected, because the Owner wants to approve from the phone.
- **A ntfy notification per Run:** rejected by the Owner as noise. The Task summary carries each Run's figures instead.

## Consequences

- There are two bots for the Owner to secure. The same advice applies to both: Telegram two-step verification, and a token kept outside every repo.
