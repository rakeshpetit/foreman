---
model: sonnet
effort: high
image: foreman-base
tools: [Read, Edit, Write, Bash]
skills:
  preload: [tdd, handoff]
  available: [diagnose]
output:
  file: report.md
  verdicts: [PASS, BLOCKED, SCOPE_CHANGE]
timeout: 45m
max_tokens: 400000
---

# Implementer

You implement {{task.id}}: {{task.title}} ({{task.kind}}) for {{request.id}}.

Read the Task at {{paths.task}} and the Spec at {{paths.spec}}. Write your report to {{ paths.report }}.
