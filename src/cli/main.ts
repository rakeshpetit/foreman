import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runEngine } from "../commands/run.ts";
import { importPlan } from "../importer/import.ts";
import type { Notifier } from "../notify/notifier.ts";
import { NtfyNotifier } from "../notify/ntfy.ts";
import type { Runner } from "../runner/runner.ts";
import { render, writeStatus } from "../status/status.ts";
import { foremanHome, Store } from "../store/store.ts";

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

export interface Context {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  runner?: Runner;
  notifier?: Notifier;
}

const HELP = `foreman ${version()}

Usage: foreman <command>

Commands:
  import [planDir] [--repo <dir>]  Import a hand-written plan as a Request
  go <R>                           Approve a Request and start building
  run [--until-idle]               Run the engine (one tick, or until idle)
  status                           Print STATUS.md
  pause                            Pause the queue
  resume                           Resume the queue

Environment:
  FOREMAN_HOME                     State directory (default ~/.foreman)
  FOREMAN_NTFY_SERVER, FOREMAN_NTFY_TOPIC  Send ntfy pings when both are set
`;

const FAR_FUTURE = "9999-12-31T00:00:00.000Z";

export async function main(argv: string[], ctx: Context): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    ctx.err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version) {
    ctx.out(version());
    return 0;
  }
  if (values.help || !command) {
    ctx.out(HELP);
    return 0;
  }

  const home = foremanHome(ctx.env);
  const store = Store.open(home);
  try {
    switch (command) {
      case "import": {
        const planDir = resolve(ctx.cwd, rest[0] ?? "docs/plan");
        const repo = resolve(ctx.cwd, values.repo ?? ".");
        const r = importPlan(store, repo, planDir);
        ctx.out(`Imported ${r.requestId}: ${r.milestones} milestones, ${r.tasks} tasks`);
        return 0;
      }
      case "go": {
        const id = rest[0];
        const req = id ? store.getRequest(id) : undefined;
        if (!id || !req) return fail(ctx, `Unknown request: ${id ?? "(none)"}`);
        if (req.phase !== "planning") return fail(ctx, `${id} is already ${req.phase}`);
        store.transaction(() => {
          const a = store.createApproval({ kind: "go", subject_id: id, channel: "cli" });
          store.decideApproval(a.id, "approved", undefined, "cli");
          store.updateRequest(id, { phase: "building" });
          store.addEvent("request.go", id);
        });
        ctx.out(`${id} is building`);
        return 0;
      }
      case "run": {
        const notifier = ctx.notifier ?? ntfyFromEnv(ctx.env);
        const results = await runEngine(store, {
          home,
          untilIdle: values["until-idle"] ?? false,
          runner: ctx.runner,
          notifier,
        });
        const ran = results.filter((r) => r.kind === "ran").length;
        ctx.out(`Ran ${ran} stage${ran === 1 ? "" : "s"}`);
        return 0;
      }
      case "status":
        ctx.out(render(store).trimEnd());
        return 0;
      case "pause":
        store.setQueueState({ paused_until: FAR_FUTURE, reason: "paused by owner" });
        writeStatus(store, home);
        ctx.out("Queue paused");
        return 0;
      case "resume":
        store.setQueueState({ paused_until: null, reason: null });
        writeStatus(store, home);
        ctx.out("Queue resumed");
        return 0;
      default:
        return fail(ctx, `Unknown command: ${command}`);
    }
  } finally {
    store.close();
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      repo: { type: "string" },
      "until-idle": { type: "boolean" },
    },
  });
}

function fail(ctx: Context, msg: string): number {
  ctx.err(msg);
  return 1;
}

function ntfyFromEnv(env: NodeJS.ProcessEnv): Notifier | undefined {
  const server = env.FOREMAN_NTFY_SERVER;
  const topic = env.FOREMAN_NTFY_TOPIC;
  return server && topic ? new NtfyNotifier({ server, topic }) : undefined;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
  process.exitCode = code;
}
