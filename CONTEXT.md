# Foreman

Foreman turns a Request from the Owner into merged, verified code. It plans the work with the Owner, then builds it one Task at a time through configurable Stages guarded by Gates, pausing for the Owner wherever the Mode says to.

## Language

### Work

**Owner**:
The one person foreman works for, and the only one who can give Go, approve, reject, admit a Proposal or answer an Escalation.
_Avoid_: User, admin, chief

**Request**:
One thing the Owner asks foreman to build, from the first idea to its last Milestone merged.
_Avoid_: Project, job, ticket, patient

**Target repo**:
The git repository a Request is built in: an existing one, or a new one created for the Request.
_Avoid_: Project, codebase

**Spec**:
The Owner-approved statement of what a Request must deliver and how "done" is judged.
_Avoid_: PRD, requirements

**Plan**:
How a Request will be built: its architecture, its Milestones and the decisions behind them.
_Avoid_: Roadmap, design doc

**Milestone**:
An ordered slice of a Plan that ends in a working, verified state the Owner approves into main.
_Avoid_: Phase, epic, sprint

**Scaffold**:
The first Milestone of every new Target repo: the toolchain and the commands foreman needs to build, run and test it, with no feature work.
_Avoid_: Setup, bootstrap

**Task**:
The smallest unit foreman builds and merges on its own: one Kind, with acceptance criteria, small enough to review in one sitting.
_Avoid_: Issue, ticket, story

**Kind**:
The category of a Task (for example ui, api, infra, docs) that decides which Agents implement, review and verify it.
_Avoid_: Type, label

**Origin**:
Where a Task came from: planned (from the Plan), research (a Research finding inside the Spec, with its parent Task) or owner.
_Avoid_: Source, provenance

**Proposal**:
A Research finding outside the Spec, held until the Owner admits or drops it. It is never built without admission.
_Avoid_: Suggestion, backlog item, idea

### Flow

**Pipeline**:
The ordered Stages a Request and its Tasks pass through, with where each pass or fail leads.
_Avoid_: Workflow (Claude Code uses that word for something else)

**Stage**:
One step of the Pipeline, done by Agents, by a Gate, or by the Owner.
_Avoid_: Step, phase, job

**Intake**:
The live interview between the Owner and an Agent that produces the Spec.
_Avoid_: Discovery, kickoff

**Go**:
The Owner's approval of the Spec, Plan and Tasks that starts building. Nothing is built before Go.
_Avoid_: Kickoff, start

**Workup**:
The Stage that writes a Task's acceptance test and shows it failing before any implementation.
_Avoid_: Investigation, prep

**Verify**:
The Stage that runs the app live and exercises a Task's change, leaving Evidence.
_Avoid_: QA, test stage

**Research**:
The Stage after a Task merges (and optionally after a Milestone) that looks for what is still missing against the Spec, and files Tasks or Proposals.
_Avoid_: Audit, retro

**Fast lane**:
The shorter Pipeline for trivial Tasks: no separate Workup and a single review Round.
_Avoid_: Express, shortcut

**Scope change**:
A Verdict meaning a Task cannot be done as planned. It parks the Task until an Amendment is approved.
_Avoid_: Blocker, replan

**Amendment**:
A change to the Plan or Tasks after Go. Plan review checks it and the Owner approves it.
_Avoid_: Revision, replan

**Approval**:
The Owner's sign-off at an Owner Stage: Go, a Task (Manual Mode), a Milestone, an Amendment or Consent.
_Avoid_: Sign-off, review (review is an Agent Stage)

**Mode**:
A Request setting: Manual (the Owner approves every Task) or Automatic (the Owner approves only Milestones). It can be switched mid-Request.
_Avoid_: Autonomy level

### Agents

**Agent**:
A named, configured role that does an Agent Stage. It has a model, Skills, an Output contract and a role prompt. Several Agents can fill the same Stage.
_Avoid_: Bot, worker, subagent, persona

**Skill**:
A reusable technique (for example TDD), written once and shared by Agents and the Owner's own sessions. A Skill knows nothing about foreman.
_Avoid_: Prompt, plugin

**Preloaded skill**:
A Skill an Agent always follows, as opposed to an available Skill it may choose to use.
_Avoid_: Required skill

**Output contract**:
What an Agent must leave behind for its Stage: its report (foreman says where it goes) and the Verdicts it may give.
_Avoid_: Schema, interface

**Verdict**:
An Agent's declared result for a Run, chosen from its Output contract. There are four: PASS, FAIL, BLOCKED and SCOPE_CHANGE. Every Output contract must allow PASS. A Stage only ever ends in PASS or FAIL, so BLOCKED and SCOPE_CHANGE are handled before routing (they wait for M5-T06 and M5-T08).
_Avoid_: Status, result

**Gate**:
A pass/fail condition foreman checks itself, with no Agent involved. No Verdict can override a Gate.
_Avoid_: Check (the Target repo's own check command is a different thing), guard

**Evidence**:
What a Verify Run leaves behind to prove the change worked live: screenshots, request and response transcripts, test output.
_Avoid_: Artifacts, proof

### Runs and safety

**Run**:
One execution of one Agent for one Stage of one Task, with its usage and cost recorded.
_Avoid_: Session, invocation, call

**Round**:
One pass of rework, caused by a failed review, a failed Gate or the Owner rejecting a Task.
_Avoid_: Retry, iteration

**Breaker**:
The limit on Rounds, time and tokens that stops a Task looping and turns it into an Escalation.
_Avoid_: Retry limit, timeout

**Handoff**:
The structured note an Agent writes when it stops short: the situation, what was tried, the blocker, and the decision needed.
_Avoid_: Summary, notes

**Escalation**:
A parked Task waiting on the Owner, carried by a Handoff.
_Avoid_: Alert, ticket

**Precedent**:
An Owner decision marked as general, kept in an append-only log that Agents read before escalating.
_Avoid_: Rule, policy

**Consent**:
The Owner's one-time permission, per Target repo, for foreman to use that repo's `.env` during Verify.
_Avoid_: Permission, secret access

**Task summary**:
The report sent when a Task ends: every Run with its Agent, model, usage, context and cost. It is kept for retrospectives.
_Avoid_: Usage ping, receipt

**Sweeper**:
The periodic pass that finds stalled Stages and re-queues them.
_Avoid_: Charge nurse, watchdog

**Growth alert**:
A non-blocking notice when research Tasks have grown a Milestone by more than half its planned Tasks.
_Avoid_: Cap, limit

## Relationships

- A **Request** has one **Spec**, one **Plan** and one or more **Milestones**. A new **Target repo** always starts with **Scaffold**.
- A **Milestone** holds **Tasks**. Each **Task** has one **Kind** and one **Origin**, and runs through the **Pipeline**.
- A **Kind** maps to the **Agents** that fill each **Stage**. An **Agent** uses **Skills** and answers with **Verdicts** from its **Output contract**.
- **Gates** sit between **Stages**. A failed **Gate**, review or **Approval** costs a **Round**. Too many **Rounds** trip the **Breaker**, which produces a **Handoff** and an **Escalation**.
- **Research** turns a finding inside the **Spec** into a **Task** (Origin: research) and a finding outside it into a **Proposal**.
- **Mode** decides whether a **Task** needs **Approval** (Manual) or only its **Milestone** does (Automatic).
- Every **Run** feeds the **Task summary**.
