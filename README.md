# foreman

A local, deterministic orchestrator that runs coding Agents through a configurable Pipeline of
Stages, with Gates and Owner Approvals. Design: [CONTEXT.md](CONTEXT.md),
[ADRs](docs/adr/), [plan](docs/plan/PLAN.md), [tasks](docs/plan/TASKS.md).

## Dev setup

```sh
asdf install            # Node from .tool-versions
npm install
git config core.hooksPath .githooks   # pre-push runs the check
npm run check           # Biome + tsc --noEmit + node --test
node src/cli/main.ts --version
```

No build step: Node runs the TypeScript directly (type stripping).
