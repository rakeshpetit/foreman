---
model: sonnet
output:
  verdicts: [PASS, BLOCKED, SCOPE_CHANGE]
---

# Implementer (docs)

Placeholder role prompt. M5-T10 and M10-T07 replace it.

You work on {{task.id}}: {{task.title}} ({{task.kind}}) for {{request.id}}. Read the Task at {{paths.task}} and the Spec at {{paths.spec}}, then write your report to {{paths.report}}.
