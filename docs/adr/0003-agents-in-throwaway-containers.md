---
status: accepted (grilled to shared understanding 2026-10-26; M3 done: images and egress network built in M3-T03; `ContainerRunner` built in M3-T04; Run recording and the usage-limit pause built in M3-T05 and M3-T06; reads Claude's `stream-json` since M3-T09)
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
- **Confirmed by the M3-T01 spike** ([claude-in-container](../spikes/claude-in-container.md)): `CLAUDE_CODE_OAUTH_TOKEN` from an `--env-file` authenticates `claude -p` in a container. `--dangerously-skip-permissions` is refused as root, so every Agent image needs a non-root `agent` user, and the mounted worktree must be writable by it.
- **Confirmed by the M3-T02 spike** ([egress](../spikes/egress.md)): an `internal: true` network plus an allowlisting tinyproxy container lets an Agent container reach only Anthropic, npm and PyPI. `github.com` is refused. The connections tried that bypassed the proxy all failed, and no fallback is needed. An allowed host can still be used to send data out, so the Run's token and the worktree remain the things to protect.
- **Built in M3-T03:** `images/base` (Node 24, git, Python 3 + `uv`, pinned Claude Code, uid-1000 `agent` user) and `images/egress-proxy`, both from `foreman images build`. Until per-Agent images arrive, every Run uses the base image.
- **Built in M3-T04:** `ContainerRunner` runs `docker run --rm` as the host's `uid:gid` (so the worktree mounted at `/work` stays writable), with a scratch tmpfs `HOME`, the Skills copied into a read-only `.claude/skills` mount, the token from `claude.env` via `--env-file`, and the proxy variables. A Run past its wall-clock limit is stopped with `docker kill`. It first read Claude's single `--output-format json` result.
- **Built in M3-T09:** `claude` runs with `--output-format stream-json --verbose`, and `ContainerRunner` reads the output line by line. The final `result` line gives `structured_output`, the totals and the cost. The context peak is the largest `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` over the `assistant` lines (exact, not an approximation). A usage limit and its reset come from `rate_limit_event` (ADR 0001). The recorded model is the `modelUsage` entry with the largest `costUSD`. The whole stream is kept as the Run's raw file.
- **Built in M3-T10:** a container never outlives its Run. After a timeout's `docker kill`, a `docker run` that has not returned within the grace period is removed with `docker rm -f`, and if that fails too the `RunFailure` names the container. A `docker run` that rejects (output past the buffer, a signal) also gets `rm -f` and fails as `failed`. `ensureEgress` reads `{{.Internal}}` and refuses a `foreman-agents` network made without `--internal`, naming the `docker network rm` that fixes it. A `docker` shim in `test/fakes/docker/` lets `CliDocker` and `ContainerRunner` be tested through a real spawn and kill.
- **Stream size is not measured.** The stream carries every tool call and result of a Run, so it grows with the Run. `CliDocker` buffers a container's stdout up to 64 MB, and a Run that prints more fails as a Docker error. No real stream has been measured yet (neither the smoke Run nor a multi-turn implement Run), so whether a long implement Run could come near that limit is open. Measure the stream's size from the first real implement Runs, and raise the limit or stream to a file if one gets close.
