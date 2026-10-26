# T-2: Add the parser

Stage: implement

- Task file: `/work/.foreman/R-1/tasks/T-2.md`
- Spec: `/work/.foreman/R-1/spec.md`
- Plan: `/work/.foreman/R-1/plan.md`

## Earlier reports for this Task

- workup (workup-tdd, PASS): `/work/.foreman/R-1/runs/5-workup.md`
- review (reviewer-code, FAIL): `/work/.foreman/R-1/runs/6-review.md`

## Blocking findings from the last Round

Fix every one of these before you finish.

- (reviewer-code) parse() swallows the error from JSON.parse.
- (owner) Name the function parseTask, not parse.
  Update every caller.
