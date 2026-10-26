export interface ParsedTask {
  ref: string;
  title: string;
  kind: string;
  size: string;
  depends: string[];
  dependsLine: number;
  line: number;
  body: string;
}
export interface ParsedMilestone {
  key: string;
  title: string;
  tasks: ParsedTask[];
}
export interface ParsedPlan {
  milestones: ParsedMilestone[];
}

export class ImportError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

const MILESTONE = /^## (M\d+) · (.+?)\s*$/;
const TASK = /^### (M\d+-T\d+) · (.+?)\s*$/;
const KIND = /^- \*\*Kind:\*\* (\S+)/;
const SIZE = /\*\*Size:\*\* (\S+)/;
const DEPENDS = /\*\*Depends:\*\* (.+?)\s*$/;

export function parseTasks(text: string): ParsedPlan {
  const lines = text.split("\n");
  const milestones: ParsedMilestone[] = [];
  const refs = new Map<string, number>();
  let ms: ParsedMilestone | undefined;
  let task: ParsedTask | undefined;
  let buf: string[] = [];

  const closeTask = () => {
    if (task) task.body = `${buf.join("\n").trim()}\n`;
    task = undefined;
    buf = [];
  };

  lines.forEach((raw, i) => {
    const n = i + 1;
    const m = MILESTONE.exec(raw);
    if (m) {
      closeTask();
      ms = {
        key: m[1] as string,
        title: (m[2] as string).replace(/\s*·.*$/, "").trim(),
        tasks: [],
      };
      milestones.push(ms);
      return;
    }
    const t = TASK.exec(raw);
    if (t) {
      closeTask();
      const ref = t[1] as string;
      if (!ms) throw new ImportError(`task ${ref} appears before any milestone`, n);
      if (!ref.startsWith(`${ms.key}-`)) {
        throw new ImportError(`task ${ref} is under milestone ${ms.key}`, n);
      }
      const prev = refs.get(ref);
      if (prev !== undefined) {
        throw new ImportError(`duplicate task ID ${ref} (first defined on line ${prev})`, n);
      }
      refs.set(ref, n);
      task = {
        ref,
        title: t[2] as string,
        kind: "",
        size: "",
        depends: [],
        dependsLine: n,
        line: n,
        body: "",
      };
      ms.tasks.push(task);
      buf.push(raw);
      return;
    }
    if (task) {
      buf.push(raw);
      const k = KIND.exec(raw);
      if (k) {
        task.kind = k[1] as string;
        task.size = SIZE.exec(raw)?.[1] ?? "";
        const d = DEPENDS.exec(raw)?.[1];
        task.dependsLine = n;
        if (d && d.toLowerCase() !== "none") {
          task.depends = d
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
    }
  });
  closeTask();

  for (const m of milestones) {
    for (const t of m.tasks) {
      if (!t.kind) throw new ImportError(`task ${t.ref} has no Kind/Size/Depends line`, t.line);
      for (const d of t.depends) {
        if (!refs.has(d))
          throw new ImportError(`task ${t.ref} depends on unknown task ${d}`, t.dependsLine);
      }
    }
  }
  if (milestones.length === 0) throw new ImportError("no milestones found", 1);
  return { milestones };
}

export function planTitle(planMd: string): string {
  const h = /^# (.+)$/m.exec(planMd)?.[1];
  return h?.trim() ?? "Untitled request";
}
