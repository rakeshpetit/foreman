---
status: accepted (grilled to shared understanding 2026-10-26; not yet built)
---

# The Owner approves at Go and per Milestone; Manual Mode adds per-Task Approval

Nothing is built until the Owner has approved a Spec, Plan and Tasks. After that, how often the Owner signs off is a per-Request **Mode**. The Owner wants to inspect every Task while building trust, then step back to approving only Milestones. The git flow follows the Approvals: `main` moves only when the Owner says so.

## Decisions

- **Before Go:**
  1. Intake: a live interview with the Owner produces the Spec.
  2. Plan: Milestones and ADRs. A new Target repo always gets the Scaffold Milestone first.
  3. Decompose: Tasks of about 300 lines or fewer, each with acceptance criteria, a Kind and dependencies.
  4. Plan review: a critic Agent checks the work and can send it back.
  5. **Go:** the Owner approves.
- **Go is also where** the Owner overrides Agents for any Task, sets the Mode, and approves `gh repo create --private` for a new Target repo. foreman never creates a remote without Go.
- **Manual Mode:** foreman pauses after each Task passes its Gates, reviews and Verify, and sends a summary to Telegram. The Owner then:
  - replies `approve`, and foreman merges;
  - replies `reject <notes>`, and the Task goes back to Implement with the notes as a blocking finding (one Round); or
  - pushes their own commits to the Task branch and then `approve`s. foreman **re-runs the Gates** on those commits before merging.
- **Automatic Mode:** Tasks merge into the Milestone branch once they pass. The Owner approves only Milestone → `main`.
- **The Mode is set per Request** with a global default, and can be switched mid-run (`foreman mode R-3 auto`).
- **Git flow:**
  - Branches are `foreman/R-<n>/m<k>` (Milestone) and `foreman/R-<n>/m<k>/T-<id>` (Task).
  - Tasks merge into the Milestone branch with `--no-ff`, and the Milestone branch is pushed after each merge as an off-machine backup.
  - `main` is merged and pushed only on Milestone Approval.
  - No pull requests.
  - Commits use the Owner's git identity with a `Co-Authored-By: foreman` trailer.

## Considered options

- **Approving every Task merge to `main` forever:** rejected as the default, because it recreates the article's bureaucracy. It is kept as Manual Mode instead.
- **The Owner creates the GitHub remote by hand:** rejected, because creating it is part of the Plan the Owner already approves at Go.

## Consequences

- **Not built yet (M2):** the default Pipeline's `task_approval` owner Stage runs in every Mode for now, and its stub Owner auto-approves. M5-T02 must give the schema a way to make an owner Stage depend on Mode, so `task_approval` runs in Manual Mode only. M5-T03 re-runs the Gate Stages after the Owner pushes their own commits to the Task branch, which needs a route from `task_approval` back to the Gates.

- In Manual Mode the queue stops after every Task until the Owner replies, so throughput is bound to the Owner's attention.
- Unapproved work exists on GitHub as pushed Milestone branches.
