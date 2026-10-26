import type { Agent } from "../config/agent.ts";
import type { ResolvedSkills } from "../config/skill.ts";
import type { Stage } from "../engine/route.ts";
import type { Verdict } from "../engine/verdict.ts";
import type { RequestRow, TaskRow } from "../store/store.ts";
import type { RunSpec, VerdictSchema } from "./runner.ts";

/** Where the files an Agent reads and writes are, as the Agent will see them. */
export interface PromptPaths {
  task: string;
  spec: string;
  plan: string;
  /** The append-only log of Owner decisions an Agent reads before escalating. */
  precedents: string;
  /** Where this Run's report goes. */
  report: string;
  workdir: string;
}

/** A report an earlier Run of this Task left behind. */
export interface PriorReport {
  stage: string;
  agent: string;
  verdict: Verdict;
  path: string;
}

/** Something the last Round's review, Gate or Owner said must change, before the Task can pass. */
export interface BlockingFinding {
  /** Who raised it: a Stage (a Gate), an Agent, or the Owner. */
  from: { stage: Stage } | { agent: string } | "owner";
  text: string;
}

export interface RunSpecInput {
  /** The `runs` row this Run fills in. */
  runId: number;
  agent: Agent;
  skills: ResolvedSkills;
  task: Pick<TaskRow, "id" | "title" | "kind" | "ref" | "lane" | "branch">;
  request: Pick<RequestRow, "id" | "title" | "mode" | "target_repo">;
  stage: string;
  paths: PromptPaths;
  /** Earlier stage reports for this Task, oldest first. */
  reports?: PriorReport[];
  /** Blocking findings from the last Round; empty on a first Round. */
  findings?: BlockingFinding[];
}

/**
 * Builds the `RunSpec` for one Run of `agent`.
 *
 * The system prompt is the AGENT.md body, the preloaded Skills, the Output contract and a pointer
 * to the Precedents file. The user prompt is the Task: its files, earlier reports and the findings
 * to fix. The Verdict schema allows exactly the Verdicts the Agent's Output contract lists.
 */
export function assembleRunSpec(input: RunSpecInput): RunSpec {
  const { agent, skills, task, stage, paths } = input;
  return {
    runId: input.runId,
    task: task.id,
    stage,
    agent: agent.name,
    workdir: paths.workdir,
    reportPath: paths.report,
    systemPrompt: systemPrompt(input),
    userPrompt: userPrompt(input),
    verdictSchema: verdictSchema(agent.output.verdicts),
    ...(agent.model && { model: agent.model }),
    ...(agent.effort && { effort: agent.effort }),
    ...(agent.image && { image: agent.image }),
    ...(agent.tools && { tools: agent.tools }),
    ...(agent.timeout && { timeoutMs: durationMs(agent.timeout) }),
    skills: [...skills.preload, ...skills.available].map(({ name, dir }) => ({ name, dir })),
  };
}

export function verdictSchema(verdicts: Verdict[]): VerdictSchema {
  return {
    type: "object",
    properties: { verdict: { type: "string", enum: verdicts } },
    required: ["verdict"],
    additionalProperties: false,
  };
}

function systemPrompt({ agent, skills, task, request, paths }: RunSpecInput): string {
  const sections = [renderTemplate(agent.body, { task, request, paths }).trim()];

  if (skills.preload.length > 0) {
    // Tagged, not headed: a Skill's own `#` headings must not break up this prompt's sections.
    const bodies = skills.preload.map(
      (skill) => `<skill name="${skill.name}">\n${skill.body.trim()}\n</skill>`,
    );
    sections.push(
      `## Skills you must follow\n\nFollow each of these for the whole Run.\n\n${bodies.join("\n\n")}`,
    );
  }
  if (skills.available.length > 0) {
    const names = skills.available.map((s) => `- ${s.name}`).join("\n");
    sections.push(`## Skills you may use\n\nInvoke one when it fits the work.\n\n${names}`);
  }

  const verdicts = agent.output.verdicts.join(", ");
  sections.push(
    `## Output contract\n\nWrite your report to \`${paths.report}\`. Finish with a Verdict, one of: ${verdicts}.`,
  );
  sections.push(
    `## Precedents\n\nThe Owner's standing decisions are in \`${paths.precedents}\`. Read it before returning \`BLOCKED\`.`,
  );
  return `${sections.join("\n\n")}\n`;
}

function userPrompt({ task, stage, paths, reports = [], findings = [] }: RunSpecInput) {
  const lines = [
    `# ${task.id}: ${task.title}`,
    "",
    `Stage: ${stage}`,
    "",
    `- Task file: \`${paths.task}\``,
    `- Spec: \`${paths.spec}\``,
    `- Plan: \`${paths.plan}\``,
  ];
  if (reports.length > 0) {
    lines.push("", "## Earlier reports for this Task", "");
    for (const r of reports) lines.push(`- ${r.stage} (${r.agent}, ${r.verdict}): \`${r.path}\``);
  }
  if (findings.length > 0) {
    lines.push(
      "",
      "## Blocking findings from the last Round",
      "",
      "Fix every one of these before you finish.",
      "",
    );
    for (const f of findings)
      lines.push(`- (${findingSource(f.from)}) ${f.text.trim().replace(/\n(?=.)/g, "\n  ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function findingSource(from: BlockingFinding["from"]): string {
  if (from === "owner") return from;
  return "stage" in from ? from.stage : from.agent;
}

/** What an AGENT.md body may name: the Task, the Request and the paths, as `{{task.id}}` and so on. */
export type TemplateValues = Pick<RunSpecInput, "task" | "request" | "paths">;

/**
 * Fills in each `{{namespace.key}}` of an AGENT.md body. An unset value (no branch yet) is empty.
 * The body is a parsed Agent's, so every variable in it is one that exists.
 */
export function renderTemplate(body: string, values: TemplateValues): string {
  const table: Record<string, Record<string, string | null>> = {
    task: { ...values.task, file: values.paths.task },
    request: { ...values.request },
    paths: { ...values.paths },
  };
  return body.replace(
    /\{\{\s*([a-z_]+)\.([a-z_]+)\s*\}\}/g,
    (_match, ns: string, key: string) => table[ns]?.[key] ?? "",
  );
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** `45m` → 2_700_000. The AGENT.md parser has already checked the shape. */
function durationMs(duration: string): number {
  const unitMs = UNIT_MS[duration.slice(-1)];
  if (unitMs === undefined) throw new Error(`unknown duration unit in "${duration}"`);
  return Number(duration.slice(0, -1)) * unitMs;
}
