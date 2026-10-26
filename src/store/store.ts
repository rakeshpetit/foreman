import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Stage, VERDICTS, type Verdict } from "../engine/route.ts";
import { MIGRATIONS } from "./schema.ts";

export type Mode = "manual" | "auto";
export type RequestPhase = "planning" | "building" | "done";
export type TaskStatus = "queued" | "active" | "awaiting_owner" | "parked" | "done" | "dropped";
export type Origin = "planned" | "research" | "owner";
export type Lane = "normal" | "fast";
export type ApprovalKind = "go" | "task" | "milestone" | "amendment" | "consent";
export type Channel = "cli" | "telegram";

const ORIGINS: readonly Origin[] = ["planned", "research", "owner"];
const LANES: readonly Lane[] = ["normal", "fast"];
const APPROVAL_KINDS: readonly ApprovalKind[] = ["go", "task", "milestone", "amendment", "consent"];
const CHANNELS: readonly Channel[] = ["cli", "telegram"];
const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "active",
  "awaiting_owner",
  "parked",
  "done",
  "dropped",
];
const APPROVAL_STATUSES: readonly ApprovalRow["status"][] = ["pending", "approved", "rejected"];

type Row = Record<string, unknown>;

/** Narrows a stored value to one of `allowed`, or throws naming the table, row and column. */
function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
  where: string,
  column: string,
): T {
  if (allowed.includes(value as T)) return value as T;
  throw new Error(`${where}: unknown ${column} ${JSON.stringify(value)}`);
}

function orNull<T extends string>(
  allowed: readonly T[],
  value: unknown,
  where: string,
  column: string,
): T | null {
  return value === null ? null : oneOf(allowed, value, where, column);
}

function taskRow(row: Row): TaskRow {
  const where = `tasks ${String(row.id)}`;
  return {
    ...(row as unknown as TaskRow),
    origin: oneOf(ORIGINS, row.origin, where, "origin"),
    lane: oneOf(LANES, row.lane, where, "lane"),
    status: oneOf(TASK_STATUSES, row.status, where, "status"),
  };
}

function runRow(row: Row): RunRow {
  const where = `runs ${String(row.id)}`;
  return {
    ...(row as unknown as RunRow),
    verdict: orNull(VERDICTS, row.verdict, where, "verdict"),
  };
}

function approvalRow(row: Row): ApprovalRow {
  const where = `approvals ${String(row.id)}`;
  return {
    ...(row as unknown as ApprovalRow),
    kind: oneOf(APPROVAL_KINDS, row.kind, where, "kind"),
    status: oneOf(APPROVAL_STATUSES, row.status, where, "status"),
    channel: orNull(CHANNELS, row.channel, where, "channel"),
  };
}

/** A Task needs no more work: its dependants may proceed and its Request may complete. */
export function isSettled(status: TaskStatus): boolean {
  return status === "done" || status === "dropped";
}

export interface RequestRow {
  id: string;
  title: string;
  target_repo: string;
  mode: Mode;
  phase: RequestPhase;
  token_budget: number | null;
  created_at: string;
}
export interface MilestoneRow {
  id: string;
  request_id: string;
  seq: number;
  title: string;
  branch: string | null;
  status: string;
  created_at: string;
}
export interface TaskRow {
  id: string;
  milestone_id: string;
  seq: number;
  ref: string | null;
  title: string;
  kind: string;
  origin: Origin;
  parent_task_id: string | null;
  size_est: string | null;
  lane: Lane;
  stage: Stage | null;
  stage_state: string | null;
  round_stage: number;
  round_total: number;
  status: TaskStatus;
  agent_overrides: string | null;
  branch: string | null;
  file_path: string | null;
}
export interface RunRow {
  id: number;
  task_id: string;
  request_id: string;
  stage: Stage;
  agent: string | null;
  model: string | null;
  effort: string | null;
  started_at: string;
  ended_at: string | null;
  verdict: Verdict | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  context_peak: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  report_path: string | null;
  error: string | null;
}
export interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  subject_id: string;
  status: "pending" | "approved" | "rejected";
  notes: string | null;
  channel: Channel | null;
  requested_at: string;
  decided_at: string | null;
}
export interface EventRow {
  id: number;
  at: string;
  type: string;
  subject: string | null;
  payload: string | null;
}
/** `paused` with a null `paused_until` means paused until the Owner resumes. */
export interface QueueState {
  paused: boolean;
  paused_until: string | null;
  reason: string | null;
}

export function foremanHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FOREMAN_HOME ?? join(homedir(), ".foreman");
}

const PREFIX = { request: "R", milestone: "M", task: "T", approval: "A" } as const;
type IdKind = keyof typeof PREFIX;

export class Store {
  private readonly db: DatabaseSync;
  now: () => Date = () => new Date();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  static open(home: string = foremanHome()): Store {
    mkdirSync(home, { recursive: true });
    return new Store(join(home, "foreman.db"));
  }

  static memory(): Store {
    return new Store(":memory:");
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private nextId(kind: IdKind): string {
    this.db
      .prepare(
        "INSERT INTO counters (kind, n) VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET n = n + 1",
      )
      .run(kind);
    const { n } = this.db.prepare("SELECT n FROM counters WHERE kind = ?").get(kind) as {
      n: number;
    };
    return `${PREFIX[kind]}-${n}`;
  }

  // requests
  createRequest(input: {
    title: string;
    target_repo: string;
    mode?: Mode;
    token_budget?: number;
  }): RequestRow {
    const id = this.nextId("request");
    this.db
      .prepare(
        "INSERT INTO requests (id, title, target_repo, mode, token_budget, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        input.title,
        input.target_repo,
        input.mode ?? "manual",
        input.token_budget ?? null,
        this.iso(),
      );
    return this.getRequest(id) as RequestRow;
  }
  getRequest(id: string): RequestRow | undefined {
    return this.db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | undefined;
  }
  listRequests(): RequestRow[] {
    return this.db
      .prepare("SELECT * FROM requests ORDER BY rowid")
      .all() as unknown as RequestRow[];
  }
  updateRequest(
    id: string,
    patch: Partial<Pick<RequestRow, "mode" | "phase" | "token_budget">>,
  ): void {
    this.patch("requests", id, patch);
  }

  // milestones
  createMilestone(input: {
    request_id: string;
    seq: number;
    title: string;
    branch?: string;
  }): MilestoneRow {
    const id = this.nextId("milestone");
    this.db
      .prepare(
        "INSERT INTO milestones (id, request_id, seq, title, branch, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, input.request_id, input.seq, input.title, input.branch ?? null, this.iso());
    return this.getMilestone(id) as MilestoneRow;
  }
  getMilestone(id: string): MilestoneRow | undefined {
    return this.db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as
      | MilestoneRow
      | undefined;
  }
  listMilestones(requestId?: string): MilestoneRow[] {
    return this.list("milestones", "request_id", requestId, "seq") as unknown as MilestoneRow[];
  }
  updateMilestone(id: string, patch: Partial<Pick<MilestoneRow, "status" | "branch">>): void {
    this.patch("milestones", id, patch);
  }

  // tasks
  createTask(input: {
    milestone_id: string;
    seq: number;
    title: string;
    ref?: string;
    kind?: string;
    origin?: Origin;
    parent_task_id?: string;
    size_est?: string;
    lane?: Lane;
    file_path?: string | ((id: string) => string);
    stage?: Stage;
  }): TaskRow {
    const id = this.nextId("task");
    this.db
      .prepare(
        `INSERT INTO tasks (id, milestone_id, seq, ref, title, kind, origin, parent_task_id, size_est, lane, file_path, stage)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.milestone_id,
        input.seq,
        input.ref ?? null,
        input.title,
        input.kind ?? "default",
        input.origin ?? "planned",
        input.parent_task_id ?? null,
        input.size_est ?? null,
        input.lane ?? "normal",
        typeof input.file_path === "function" ? input.file_path(id) : (input.file_path ?? null),
        input.stage ?? null,
      );
    return this.getTask(id) as TaskRow;
  }
  getTask(id: string): TaskRow | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row && taskRow(row);
  }
  listTasks(milestoneId?: string): TaskRow[] {
    return this.list("tasks", "milestone_id", milestoneId, "seq").map(taskRow);
  }
  updateTask(
    id: string,
    patch: Partial<
      Pick<
        TaskRow,
        | "stage"
        | "stage_state"
        | "round_stage"
        | "round_total"
        | "status"
        | "branch"
        | "agent_overrides"
        | "title"
        | "file_path"
      >
    >,
  ): void {
    this.patch("tasks", id, patch);
  }
  addDependency(taskId: string, dependsOn: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?,?)")
      .run(taskId, dependsOn);
  }
  dependenciesOf(taskId: string): string[] {
    return (
      this.db
        .prepare("SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on")
        .all(taskId) as { depends_on: string }[]
    ).map((r) => r.depends_on);
  }

  // runs
  createRun(input: { task_id: string; request_id: string; stage: Stage; agent?: string }): number {
    const r = this.db
      .prepare(
        "INSERT INTO runs (task_id, request_id, stage, agent, started_at) VALUES (?,?,?,?,?)",
      )
      .run(input.task_id, input.request_id, input.stage, input.agent ?? null, this.iso());
    return Number(r.lastInsertRowid);
  }
  finishRun(
    id: number,
    patch: Partial<Omit<RunRow, "id" | "task_id" | "request_id" | "stage" | "started_at">>,
  ): void {
    this.patch("runs", id, { ended_at: this.iso(), ...patch });
  }
  getRun(id: number): RunRow | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row && runRow(row);
  }
  listRuns(taskId?: string): RunRow[] {
    return this.list("runs", "task_id", taskId, "id", "id").map(runRow);
  }

  // approvals
  createApproval(input: {
    kind: ApprovalKind;
    subject_id: string;
    channel?: Channel;
  }): ApprovalRow {
    const id = this.nextId("approval");
    this.db
      .prepare(
        "INSERT INTO approvals (id, kind, subject_id, channel, requested_at) VALUES (?,?,?,?,?)",
      )
      .run(id, input.kind, input.subject_id, input.channel ?? null, this.iso());
    return this.getApproval(id) as ApprovalRow;
  }
  getApproval(id: string): ApprovalRow | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row && approvalRow(row);
  }
  listApprovals(status?: ApprovalRow["status"]): ApprovalRow[] {
    return this.list("approvals", "status", status).map(approvalRow);
  }
  decideApproval(
    id: string,
    status: "approved" | "rejected",
    notes?: string,
    channel?: Channel,
  ): void {
    this.db
      .prepare(
        "UPDATE approvals SET status = ?, notes = ?, channel = COALESCE(?, channel), decided_at = ? WHERE id = ?",
      )
      .run(status, notes ?? null, channel ?? null, this.iso(), id);
  }

  // leases
  takeLease(taskId: string, holder: string, ttlMs: number): boolean {
    const now = this.iso();
    const r = this.db
      .prepare(
        `INSERT INTO leases (task_id, holder, expires_at) VALUES (?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE leases.expires_at <= ?`,
      )
      .run(taskId, holder, new Date(this.now().getTime() + ttlMs).toISOString(), now);
    return Number(r.changes) > 0;
  }
  releaseLease(taskId: string): void {
    this.db.prepare("DELETE FROM leases WHERE task_id = ?").run(taskId);
  }
  expiredLeases(): string[] {
    return (
      this.db.prepare("SELECT task_id FROM leases WHERE expires_at <= ?").all(this.iso()) as {
        task_id: string;
      }[]
    ).map((r) => r.task_id);
  }

  // queue state
  queueState(): QueueState {
    const row = this.db
      .prepare("SELECT paused, paused_until, reason FROM queue_state WHERE id = 1")
      .get() as { paused: number; paused_until: string | null; reason: string | null };
    return { ...row, paused: row.paused === 1 };
  }
  setQueueState(state: QueueState): void {
    this.db
      .prepare("UPDATE queue_state SET paused = ?, paused_until = ?, reason = ? WHERE id = 1")
      .run(state.paused ? 1 : 0, state.paused_until, state.reason);
  }
  /** True while paused until resumed, or while a timed pause has not yet reached its time. */
  isPaused(): boolean {
    const q = this.queueState();
    return q.paused && (q.paused_until === null || new Date(q.paused_until) > this.now());
  }

  // events
  addEvent(type: string, subject?: string, payload?: unknown): void {
    this.db
      .prepare("INSERT INTO events (at, type, subject, payload) VALUES (?,?,?,?)")
      .run(
        this.iso(),
        type,
        subject ?? null,
        payload === undefined ? null : JSON.stringify(payload),
      );
  }
  /** Oldest first. With `limit`, only the newest `limit` events are read. */
  listEvents(limit?: number): EventRow[] {
    if (!limit) {
      return this.db.prepare("SELECT * FROM events ORDER BY id").all() as unknown as EventRow[];
    }
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as EventRow[];
    return rows.reverse();
  }

  /** All rows of `table`, or only those whose `column` equals `value` when one is given. */
  private list(
    table: string,
    column: string,
    value: string | undefined,
    filteredOrder = "rowid",
    allOrder = "rowid",
  ): Row[] {
    if (value === undefined)
      return this.db.prepare(`SELECT * FROM ${table} ORDER BY ${allOrder}`).all();
    return this.db
      .prepare(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY ${filteredOrder}`)
      .all(value);
  }

  private patch(table: string, id: string | number, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    this.db
      .prepare(`UPDATE ${table} SET ${set} WHERE id = ?`)
      .run(...(keys.map((k) => patch[k] ?? null) as (string | number | null)[]), id);
  }
}
