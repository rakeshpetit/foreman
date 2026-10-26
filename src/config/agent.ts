import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The variables an AGENT.md body may use, as `{{namespace.key}}`. Prompt assembly (M2-T05) fills
 * them in; the parser only checks that each one named is one it can fill.
 */
export const TEMPLATE_VARIABLES = {
  task: ["id", "title", "kind", "ref", "file", "branch", "lane"],
  request: ["id", "title", "mode", "target_repo"],
  paths: ["task", "spec", "plan", "precedents", "report", "workdir"],
} as const satisfies Record<string, readonly string[]>;

const names = z.array(z.string().min(1));

const VERDICT = /^[A-Z][A-Z0-9_]*$/;
const KNOWN_VARIABLES = Object.entries(TEMPLATE_VARIABLES).flatMap(([ns, keys]) =>
  keys.map((k) => `${ns}.${k}`),
);

const agentSchema = z.strictObject({
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  tools: names.optional(),
  skills: z.strictObject({ preload: names.default([]), available: names.default([]) }).prefault({}),
  output: z.strictObject({
    /** The file the Agent writes its report to, relative to its report directory. */
    file: z
      .string()
      .min(1)
      .refine((f) => !isAbsolute(f) && !f.split(/[\\/]/).includes(".."), {
        message: "use a path inside the report directory, with no leading / and no ..",
      }),
    verdicts: z
      .array(z.string().regex(VERDICT, "write a Verdict in capitals, e.g. SCOPE_CHANGE"))
      .min(1, "list at least one Verdict, e.g. [PASS]")
      .refine((v) => new Set(v).size === v.length, { message: "list each Verdict once" }),
  }),
  /** A duration: a number and a unit of `s`, `m` or `h`, e.g. `45m`. */
  timeout: z
    .string()
    .regex(/^[1-9]\d*[smh]$/, 'write a duration such as "90s", "45m" or "2h"')
    .optional(),
  max_tokens: z.int().positive().optional(),
});

/** One Agent, as hand-edited in `agents/<name>/AGENT.md`. */
export interface Agent extends z.output<typeof agentSchema> {
  /** The Agent's folder name. */
  name: string;
  /** The role prompt: a template over {@link TEMPLATE_VARIABLES}. */
  body: string;
}

export interface AgentOptions {
  /** Named in error messages, and the folder name gives the Agent its name. */
  source: string;
}

/** Every problem with an AGENT.md, one readable line each (`issues`), prefixed by its file. */
export class AgentError extends Error {
  readonly issues: string[];

  constructor(issues: string[], source: string) {
    super(issues.map((i) => `${source}: ${i}`).join("\n"));
    this.name = "AgentError";
    this.issues = issues;
  }
}

export function loadAgent(path: string): Agent {
  return parseAgent(readFileSync(path, "utf8"), { source: path });
}

/** Parses and validates an AGENT.md. Throws an `AgentError` listing every problem. */
export function parseAgent(text: string, { source }: AgentOptions): Agent {
  const split = splitFrontmatter(text.replace(/^\uFEFF/, ""));
  if (!split) {
    throw new AgentError(
      ["no frontmatter: start the file with a `---` block holding model, output and so on"],
      source,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(split.frontmatter) ?? {};
  } catch (e) {
    const reason = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
    throw new AgentError([`frontmatter is not valid YAML: ${reason}`], source);
  }
  const issues: string[] = [];
  const shape = agentSchema.safeParse(raw);
  if (!shape.success) {
    for (const i of shape.error.issues) issues.push(`${formatPath(i.path)}: ${i.message}`);
  }
  if (split.body.trim() === "") issues.push("body: the role prompt is empty");
  issues.push(...checkVariables(split.body, split.bodyLine));
  if (!shape.success || issues.length > 0) throw new AgentError(issues, source);
  return { ...shape.data, name: basename(dirname(source)), body: split.body };
}

/** The `---` block at the top of the file, and what follows it, with the line the body starts on. */
export function splitFrontmatter(text: string) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
  if (m?.index !== 0) return undefined;
  const bodyLine = text.slice(0, m[0].length).split("\n").length;
  return { frontmatter: m[1] ?? "", body: text.slice(m[0].length), bodyLine };
}

function formatPath(path: PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    out += typeof part === "number" ? `[${part}]` : out ? `.${String(part)}` : String(part);
  }
  return out || "frontmatter";
}

/** Every `{{ }}` in the body must name a known variable. A `{{` with no `}}` is an error too. */
function checkVariables(body: string, firstLine: number): string[] {
  const issues: string[] = [];
  const lineAt = (index: number) =>
    `line ${firstLine + body.slice(0, index).split("\n").length - 1}`;
  let closed = 0;
  for (const m of body.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    closed++;
    const name = (m[1] ?? "").trim();
    if (!/^[a-z_]+\.[a-z_]+$/.test(name)) {
      issues.push(`${lineAt(m.index)}: "{{${m[1]}}}" is not a variable, use {{namespace.key}}`);
    } else if (!KNOWN_VARIABLES.includes(name)) {
      issues.push(
        `${lineAt(m.index)}: unknown variable "${name}" (known: ${KNOWN_VARIABLES.join(", ")})`,
      );
    }
  }
  if (body.split("{{").length - 1 !== closed) {
    issues.push(`${lineAt(body.lastIndexOf("{{"))}: "{{" has no closing "}}"`);
  }
  return issues;
}
