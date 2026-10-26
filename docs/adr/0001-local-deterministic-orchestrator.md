---
status: accepted (grilled to shared understanding 2026-10-26; not yet built)
---

# A local, deterministic orchestrator drives Claude one Stage at a time

Foreman is modelled on CockroachDB's [MOLT Sinai pipeline](https://www.cockroachlabs.com/blog/experiment-running-hospital-code/), which chains label-triggered GitHub Actions so that each role runs as a fresh agent. Foreman keeps that shape but runs locally. A small TypeScript program (Node 22+) owns the state machine. It starts every Agent Stage as a fresh, headless `claude -p` on the Owner's Claude subscription, and it evaluates every Gate in its own code. The article's main lesson is that the pipeline is plumbing and the gates must hold even when an agent misbehaves. That only works if the thing enforcing the gates is not itself a model.

## Decisions

- **Local only.** Orchestration and state live on the Mac. Network use is limited to Anthropic, package registries and GitHub (`git push`) for source control. No GitHub Issues, Actions, labels or pull requests.
- **One fresh `claude -p` per Run,** with the Agent's role prompt and Skills. Context never carries over between Stages. Everything one Stage tells the next goes through files.
- **Gates are code.** For example: the acceptance test went red then green, the repo's check command passes, the diff is under the size ceiling, no tests were weakened, Evidence exists. An Agent's Verdict routes work but never overrides a Gate.
- **One Task at a time** (`max_parallel = 1`). The seam for parallel worktrees is left open.
- **Started by hand:** `foreman run` in tmux under `caffeinate`, like `pi-remote` in the knowledge repo. A launchd daemon comes later, once it runs reliably.
- **A Sweeper** re-queues stalled Stages on a timer.
- **Usage limits pause the queue.** When the subscription limit is hit, foreman pauses until the reset time, sends one ntfy and resumes on its own.
- **TypeScript,** because the Owner is a React Native developer who debugs TS fastest, and a future web dashboard can share its types.

## Considered options

- **One long-lived Claude Code session using subagents,** or Claude Code's Workflow tool / `/loop`: rejected, because the model would be in charge of its own gates.
- **GitHub Actions and labels, as in the article:** rejected, because the Owner wants local control and GitHub for source control only.
- **Local LM Studio models for cheap Stages:** rejected for v1. It makes gate reliability worse for a small saving.
- **An API key instead of the subscription:** deferred. Revisit if rate limits hurt, since it would allow hard dollar caps.
- **Python with `uv`** (like rn-job-watch and social-knowledge): equally viable, but TypeScript won on the Owner's fluency.

## Consequences

- Throughput is limited by subscription rate limits, not by the orchestrator.
- The Mac has to stay awake and running while a Request is building.
