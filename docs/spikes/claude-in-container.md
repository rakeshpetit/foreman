# Spike: Claude in a container (M3-T01)

Run on 2026-10-26 with Claude Code 2.1.310 in a `node:24-slim` container (linux/arm64, Docker 29.2.1 on a Mac), using a `claude setup-token` subscription token. The model was `claude-sonnet-5-5`. Every answer below comes from a real call unless it says "not verified". Output is shown as received, trimmed only where marked `[...]`.

The throwaway image was `node:24-slim` plus `git`, `ca-certificates`, `npm i -g @anthropic-ai/claude-code`, and `useradd -m agent`.

## Summary

| Question | Answer |
|---|---|
| Does `CLAUDE_CODE_OAUTH_TOKEN` authenticate `claude -p` in a container? | **Yes.** Pass it with `--env-file` (so it never shows in `ps` or the command line). No `~/.claude` login is needed. |
| Does `--dangerously-skip-permissions` need a non-root user? | **Yes.** As root, Claude refuses. Run as `agent`. |
| Does `--json-schema` return a reliable Verdict? | **Yes, in 5 of 5 trials** (two schemas, three of the four Verdicts exercised). The Verdict is in `structured_output`. Five trials show it works, not that it never fails: keep the validation. |
| Which fields carry tokens, cache, context, cost? | See [Result fields](#result-fields). **Context peak is not in the final result.** |
| What do auth and usage-limit errors look like? | Auth errors are verified. A real usage-limit error was **not** reproduced. See [Errors](#errors). |
| Can `--agents <file>` replace `--append-system-prompt`? | **For the role prompt, yes; for preloading Skills, no.** Both were run and compared. See [Agents and Skills](#agents-and-skills). |

## Auth and non-root

As root:

```
$ docker run --rm foreman-spike claude -p "hi" --dangerously-skip-permissions
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

As `agent` with no token:

```
$ docker run --rm -u agent foreman-spike claude -p hi --dangerously-skip-permissions
Not logged in · Please run /login
```

As `agent` with the token from `~/.foreman/claude.env`:

```
$ docker run --rm -u agent --env-file ~/.foreman/claude.env foreman-spike \
    claude -p "Reply with the word OK" --dangerously-skip-permissions --output-format json
{"duration_api_ms":1032,"stop_reason":"end_turn","total_cost_usd":0.0217284,"usage":{"input_tokens":2,"cache_creation_input_tokens":5126,"cache_read_input_tokens":11804,"output_tokens":4, [...]},"modelUsage":{"claude-sonnet-5-5":{[...],"contextWindow":1000000,"maxOutputTokens":128000}},"terminal_reason":"completed","is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"OK","duration_ms":1260,"type":"result"}
```

`claude.env` holds one line, `CLAUDE_CODE_OAUTH_TOKEN=...`, so `--env-file` is the format ADR 0003 needs. That first call cost $0.0217 and took 1.26 s (`duration_ms`).

## Verdict via `--json-schema`

Schema: `{"type":"object","properties":{"verdict":{"type":"string","enum":["PASS","FAIL","BLOCKED","SCOPE_CHANGE"]}},"required":["verdict"],"additionalProperties":false}`.

Trial 1: told to write `hello.md` into the mounted `/work` and give verdict `PASS`. The file was written (`hello`) and:

```
"num_turns":3,"subtype":"success","is_error":false,
"result":"{\"verdict\":\"PASS\"}","structured_output":{"verdict":"PASS"}
```

Trial 2: "Is the sky green? If false answer FAIL else PASS" gave `structured_output: {"verdict":"FAIL"}`.

Trials 3 to 5 used a richer schema, `{verdict, summary, findings[]}` with `required: ["verdict","summary"]`, on three one-line code-review prompts. Each returned a valid object: a buggy `add` gave `FAIL` with three findings, a correct `add` gave `PASS` with four findings (all caveats, none blocking), and an inaccessible repo gave `BLOCKED` with a summary and no findings. `SCOPE_CHANGE` was not exercised.

- Read `structured_output` (an object). `result` holds the same Verdict as a JSON string.
- Claude can do tool work first, then return the Verdict at the end. The mounted worktree was writable as `agent` because the host directory was `chmod 777`. **M3-T04 must make the worktree writable by the container's `agent` uid**, for example by running with `--user $(id -u):$(id -g)` or matching uids in the image.
- Not tested: a malformed Verdict, or a Run that hits `--max-turns` or the timeout before answering. Keep the validation in M3-T05: treat a missing `structured_output` or a Verdict outside the Agent's allowed list as an infrastructure failure.

## Result fields

From `--output-format json` (one object, `type: "result"`):

| Need | Field |
|---|---|
| Input / output tokens | `usage.input_tokens`, `usage.output_tokens` |
| Cache read / write | `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens` |
| Cost (USD, list price) | `total_cost_usd`; per model in `modelUsage.<model>.costUSD` |
| Context window size | `modelUsage.<model>.contextWindow` (1,000,000 for Sonnet 5.5) |
| Duration | `duration_ms` (wall), `duration_api_ms` |
| Success | `is_error`, `subtype`, `terminal_reason`, `api_error_status` |
| Turns | `num_turns` |
| Verdict | `structured_output.verdict` |

Gotchas:

- **Top-level `usage` sums every turn** of the Run. In the 3-turn trial it showed `cache_read 17109, cache_creation 17246`. The single entry in `usage.iterations` is only the **last** call (`cache_read 17109, cache_creation 137`).
- So **the context peak is not in the final result.** The largest context is `max(input + cache_read + cache_creation)` over the per-turn `assistant` messages. Each carries its own `message.usage`, and they are emitted by `--output-format stream-json --verbose`. M3-T05 should use stream-json and record the max, or settle for the last iteration's total as an approximation.
- `stream-json` also emits a `rate_limit_event` with the subscription windows, as received:
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793039400,"rateLimitType":"five_hour","overageStatus":"allowed","overageResetsAt":1793491200,"isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.36,"resetsAt":1793039400,"status":"allowed"},"seven_day":{"utilization":0.17,"resetsAt":1793538000,"status":"allowed"}}}}`.
  `resetsAt` is unix epoch seconds. This event only ever showed `status: allowed`, so what it looks like at a limit is inferred, not seen.
- The per-turn context numbers are not shown here: this spike did not run a multi-turn `stream-json` call. The first `assistant` message of a one-turn call carried `usage` with `cache_read_input_tokens: 13322`, so the field is there. Confirm the max-over-turns formula in M3-T05.

## Errors

Verified, both with `--output-format json`, exit code 1, `is_error: true`, `total_cost_usd: 0`, empty `usage`:

| Case | `result` | `api_error_status` | `terminal_reason` |
|---|---|---|---|
| Invalid token | `Failed to authenticate. API Error: 401 OAuth access token is invalid.` | `401` | `api_error` |
| No token | `Not logged in · Please run /login` | `null` | `api_error` |

Both are distinguishable from a Verdict failure by `is_error: true` with no `structured_output`. A 401 or "Not logged in" means the token is bad or expired, so retrying cannot help. TASKS.md has no path for this: M3-T05 only has "one retry, then an Escalation". That is a plan gap for M3-T05 to decide, for example by escalating at once.

**Usage limit: not verified.** A real one cannot be provoked without exhausting the subscription, and no docs page was found that specifies the shape. What `strings`-style inspection of the Claude Code binary shows (this is inference, not output):

- the user-facing text begins "You've hit your …" / "You've reached your …" (for example "you have reached your weekly usage limit", "5-hour usage limit");
- `rate_limit_event` carries `status` (the event above shows `allowed`), `rateLimitType` (`five_hour`, `seven_day`) and `resetsAt` in epoch seconds;
- Claude Code can itself wait and continue at a limit (a setting called "Continue automatically at usage limit"), and refuses to wait when the reset is more than 24 hours out.

**As built (M3-T09):** the Runner uses `--output-format stream-json --verbose` and reads it line by line. A usage limit is a `rate_limit_event` whose `rate_limit_info.status` is not `allowed` (`allowed_warning`, a nearing-limit notice, is not a limit), and the reset is that event's `resetsAt` in epoch seconds, taken as is. A stream with no such event falls back to matching the `is_error` text, and then there is no reset time. That includes a stream whose only event is the `allowed` one a Run starts with, since a limit may arrive without an event of its own, so the pause is a fixed 30 minutes. The context peak is `max(input + cache_read + cache_creation)` over the `assistant` lines. Confirm the limit's shape (the status string, and whether the event arrives before the error result) against the first real limit.

**M3-T06 should key off `rate_limit_event.rate_limit_info.status` not being `allowed`, plus `resetsAt`**, instead of matching error text, and must be confirmed against a real limit the first time one happens. Until then its fake can only follow the shape above. Keep PLAN.md's fallback in reserve: if a Run exits with `is_error` and no recognisable shape, pause for a fixed time and notify the Owner. The `rate_limit_event` value in an `error` result, and whether the CLI's own auto-wait could hold a Run for hours inside the container, are open. M3-T04's wall-clock timeout covers the second.

## Agents and Skills

Skills copied unchanged into `/home/agent/.claude/skills/` (mounted read-only) are discovered. The `init` event lists `codeword`, and an ordinary prompt "What is the secret codeword? Use your skills." returned `PINEAPPLE-42`, the value inside the SKILL.md.

`--agents <file>` (a JSON object, with `--print` the argument is a path) plus `--agent impl` makes the named Agent the session's own prompt:

- `{"impl":{"description":"...","prompt":"End every reply with the word ZEBRA.","model":"sonnet","skills":["codeword"]}}`
- reply: `The secret codeword is **PINEAPPLE-42**. ZEBRA`. The role prompt applied and the Skill was still found.

`--append-system-prompt "You are the implementer. End every reply with the word ZEBRA."` gave the same reply (`... PINEAPPLE-42.\n\nZEBRA`, 3 turns). So for the role prompt the two are equivalent.

But the Agent's `skills` field did **not** preload the Skill's content. With "Without using any tool, what is the secret codeword? Say UNKNOWN if you do not know." the Agent answered `UNKNOWN` in 3 of 3 runs (`num_turns: 1` each), noting that a `codeword` skill exists but it was told not to use tools. The same question with the Skill text inlined through `--append-system-prompt` answered `PINEAPPLE-42` in one turn.

Conclusions:

- `--agents`/`--agent` can carry the role prompt, `model` and `tools`, but it gains nothing over `--append-system-prompt`: it adds a second file to mount, and it does not replace the inlining of preloaded Skills.
- **Keep the plan's custom launch** (`--append-system-prompt`, Skills copied in, preloaded Skills inlined). ADR 0004 holds, and its "to be checked during v0" option is closed.
- Claude Code also shows its own bundled Skills (`debug`, `code-review`, `loop` and more) in the container. The `skills.available` list in AGENT.md therefore limits what foreman copies in, not what Claude can see. Use `--disable-slash-commands` or `--setting-sources` if that matters. Not tested here.

## Effects on the plan

- **M3-T03:** the base image's non-root `agent` user is required, not optional.
- **M3-T04:** pass the token with `--env-file`. Make the mounted worktree writable by `agent`. Parse `structured_output`. Use `stream-json` if the context peak is wanted.
- **M3-T05:** `is_error` with `api_error_status` 401, or "Not logged in", is a token failure, not an infrastructure retry.
- **M3-T06:** go by `rate_limit_event`, then confirm against a real limit.
- **ADRs:** 0001, 0003 and 0004 carry short notes in this same commit. No answer contradicts them.
- **TASKS.md is not edited by this spike.** The plan gaps above (M3-T04 parsing `stream-json` instead of the single JSON result, and M3-T05's auth-failure path) are for the owner of those tasks to take up.
