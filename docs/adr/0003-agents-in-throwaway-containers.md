---
status: accepted (grilled to shared understanding 2026-10-26; not yet built)
---

# Agents run in throwaway containers with no git credentials; only foreman touches remotes

An unattended `claude -p` needs `--dangerously-skip-permissions`, or it stops at prompts nobody is there to answer. So containment has to come from the OS, not from prompts, which is the same reasoning as ADR 0001 in the knowledge repo. Every Run gets a fresh Docker container, and foreman on the host is the only thing that commits, merges or pushes.

## Decisions

- **One container per Run.** It mounts only that Task's git worktree, has the Claude login via a subscription token (`claude setup-token`), and can reach only Anthropic and package registries over the network.
- **No GitHub credentials, `~/.ssh` or home directory** inside a container. foreman does every commit, merge and push on the host.
- **The project's `.env` goes to Verify only.** `.env` is gitignored, so it is absent from Task worktrees and implementers and reviewers never see it. foreman passes it into Verify containers only, after the Owner's one-time Consent for that Target repo (asked on Telegram, stored in SQLite).

## Considered options

- **Running on the host in worktrees, with a Claude Code permission allowlist and git-guardrail hooks:** rejected. It relies on filtering, which an agent can work around with `python -c` or a script it writes.
- **Secrets named in `.foreman/` with values in a host file outside every repo:** rejected as over-engineered. Using the project's own `.env`, Verify-only and with Consent, gets the same separation.

## Consequences

- Each Agent image has to carry the Target repo's toolchain. Images are set per Agent in AGENT.md (ADR 0004).
- Mobile simulators cannot run in these containers (ADR 0008).
