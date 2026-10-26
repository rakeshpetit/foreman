import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { showConfig } from "../commands/config.ts";
import { resolveConfigs, runEngine } from "../commands/run.ts";
import { ConfigFileError } from "../config/issues.ts";
import { scriptNames } from "../config/pipeline.ts";
import { CliDocker, type Docker, DockerError } from "../docker/docker.ts";
import { buildImages } from "../docker/images.ts";
import { importPlan } from "../importer/import.ts";
import { ImportError } from "../importer/parse.ts";
import { ntfyFromConfig } from "../notify/config.ts";
import type { Notifier } from "../notify/notifier.ts";
import { FakeRunner, parseFakeScript } from "../runner/fake.ts";
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
  /** The `docker` CLI (default: the real one). A test seam. */
  docker?: Docker;
  /** foreman's own checkout, for `loadConfig` (default: this one). A test seam. */
  foremanDir?: string;
}

const HELP = `foreman ${version()}

Usage: foreman <command>

Commands:
  import <target-repo> <plan-dir>  Import a hand-written plan as a Request
  go <R>                           Approve a Request and start building
  run [--until-idle] [--fake <script.json>]
                                   Run the engine (one tick, or until idle) with a FakeRunner
  config show <R> [--task <T>]     Print a Request's resolved config and where each value came from
  images build                     Build the Agent base image and the egress proxy image
  status                           Print STATUS.md
  pause                            Pause the queue
  resume                           Resume the queue

Environment:
  FOREMAN_HOME                     State directory (default ~/.foreman)
  FOREMAN_NTFY_SERVER, FOREMAN_NTFY_TOPIC, FOREMAN_NTFY_USAGE_TOPIC
                                   Override [ntfy] server, topic and usage_topic in
                                   $FOREMAN_HOME/config.toml. Pings need a server and topic
`;

const COMMANDS = new Set(["import", "go", "run", "config", "images", "status", "pause", "resume"]);
const STATE_CHANGING = new Set(["import", "go", "pause", "resume"]);

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

  // Check the command before opening the Store, so an unknown one creates nothing in FOREMAN_HOME.
  if (!COMMANDS.has(command)) return fail(ctx, `Unknown command: ${command}`);

  const home = foremanHome(ctx.env);
  let store: Store | undefined;
  try {
    store = Store.open(home);
    const code = await dispatch(command, rest, values, ctx, store, home);
    // The one place STATUS.md is refreshed after a state change (ADR 0002). `run` rewrites it per tick.
    if (code === 0 && STATE_CHANGING.has(command)) writeStatus(store, home);
    return code;
  } catch (e) {
    // Expected failures are one line (ImportError already carries "line N:"); anything else keeps its stack.
    if (e instanceof ImportError || e instanceof ConfigFileError || e instanceof DockerError) {
      return fail(ctx, e.message);
    }
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return fail(ctx, e.message);
    }
    ctx.err(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return 1;
  } finally {
    store?.close();
  }
}

async function dispatch(
  command: string,
  rest: string[],
  values: ReturnType<typeof parse>["values"],
  ctx: Context,
  store: Store,
  home: string,
): Promise<number> {
  switch (command) {
    case "import": {
      const [repo, planDir] = rest;
      if (!repo || !planDir || rest.length > 2) {
        return fail(ctx, "Usage: foreman import <target-repo> <plan-dir>");
      }
      const r = importPlan(store, resolve(ctx.cwd, repo), resolve(ctx.cwd, planDir));
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
      // Resolve every building Request's config first: a broken one refuses the whole run.
      const configs = resolveConfigs(store, ctx.foremanDir);
      let runner = ctx.runner;
      if (!runner && values.fake !== undefined) {
        try {
          const json: unknown = JSON.parse(readFileSync(resolve(ctx.cwd, values.fake), "utf8"));
          runner = new FakeRunner(
            parseFakeScript(
              json,
              // With no building Request there is nothing to check the names against, and nothing will run.
              configs.size > 0
                ? scriptNames([...configs.values()].map((c) => c.pipeline))
                : undefined,
            ),
          );
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          return fail(ctx, `Cannot read --fake script ${values.fake}: ${why}`);
        }
      }
      if (!runner) {
        return fail(
          ctx,
          "No Runner yet: pass --fake <script.json> (the real Runner arrives in M3)",
        );
      }
      const notifier = ctx.notifier ?? ntfyFromConfig(home, ctx.env);
      const results = await runEngine(store, {
        home,
        untilIdle: values["until-idle"] ?? false,
        runner,
        configs,
        foremanDir: ctx.foremanDir,
        notifier,
      });
      const ran = results.filter((r) => r.kind === "ran").length;
      ctx.out(`Ran ${ran} stage${ran === 1 ? "" : "s"}`);
      const crashed = results.find((r) => r.kind === "error");
      if (crashed) {
        const where = crashed.stage ? ` in ${crashed.stage}` : "";
        return fail(ctx, `${crashed.task} crashed${where}: ${crashed.message}`);
      }
      return 0;
    }
    case "config": {
      const [sub, id] = rest;
      if (sub !== "show" || !id || rest.length > 2) {
        return fail(ctx, "Usage: foreman config show <R> [--task <T>]");
      }
      ctx.out(showConfig(store, id, { task: values.task }));
      return 0;
    }
    case "images": {
      if (rest[0] !== "build" || rest.length > 1) return fail(ctx, "Usage: foreman images build");
      await buildImages(ctx.docker ?? new CliDocker(), {
        foremanDir: ctx.foremanDir,
        onBuilt: (image) => ctx.out(`Built ${image.name}`),
      });
      return 0;
    }
    case "status":
      ctx.out(render(store).trimEnd());
      return 0;
    case "pause":
      store.setQueueState({ paused: true, paused_until: null, reason: "paused by owner" });
      ctx.out("Queue paused");
      return 0;
    case "resume":
      store.setQueueState({ paused: false, paused_until: null, reason: null });
      ctx.out("Queue resumed");
      return 0;
    default:
      return fail(ctx, `Unknown command: ${command}`);
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      "until-idle": { type: "boolean" },
      fake: { type: "string" },
      task: { type: "string" },
    },
  });
}

function fail(ctx: Context, msg: string): number {
  ctx.err(msg);
  return 1;
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
