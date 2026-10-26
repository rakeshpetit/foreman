---
status: accepted (grilled to shared understanding 2026-10-26; not yet built)
---

# Every Task is verified live; v1 covers web apps and APIs, mobile is deferred

Passing tests is not enough. A Verify Stage starts the Target repo's app and exercises the change the way a user or client would, and leaves Evidence that a Gate checks. In v1 this means what runs inside a container. Mobile is deferred, because it needs a hole in the sandbox.

## Decisions

- **Web apps** are driven with Playwright (or an equivalent) inside the Verify container. Screenshots and traces become Evidence.
- **APIs and CLIs** are run in the container and called with curl (or an equivalent). Request/response transcripts become Evidence.
- **E2E suites:** Verify runs the Target repo's existing suite, and **adds E2E tests for the change to the Target repo** as a separate commit.
- The Target repo's `.foreman/` declares the `run`, `healthcheck` and `e2e` commands. For a new repo, Scaffold sets them up and gets an empty E2E test passing.
- A Gate requires Evidence files and a PASS Verdict before merge.

## Considered options

- **Mobile (React Native) in v1:** deferred. The iOS Simulator cannot run in a Linux container, and Android emulators do not work properly in Docker on Apple Silicon. v2 plans a narrow host-side device runner that a container can only ask to *run a Maestro flow file*, never a host shell. That runner needs its own ADR.

## Consequences

- Each Verify image needs browsers and the Target repo's runtime.
- React Native Target repos get only unit and check-command coverage until v2.
