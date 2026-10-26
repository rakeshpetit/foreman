import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunResult, RunSpec } from "../runner/runner.ts";
import { RunFailure } from "../runner/runner.ts";
import type { RunRow, Store } from "../store/store.ts";

export interface RecordingOptions {
  store: Store;
  /** Where the raw output of every Run is kept, named for the Run. */
  runsDir: string;
  /** Where a failure to keep the raw output is reported. Default: stderr. */
  log?: (msg: string) => void;
}

/** What opens a `runs` row. */
export type RunInput = Parameters<Store["createRun"]>[0];

/**
 * Opens the `runs` row for a Run that is starting. Whatever happens to the Run, close the row with
 * `finish` or `fail`.
 */
export function openRun(opts: RecordingOptions, input: RunInput): RunRecording {
  return new RunRecording(opts, opts.store.createRun(input));
}

/**
 * One Run's `runs` row and raw output file. It keeps what the row shows so far, so a Run that fails
 * after spending something still records what it spent.
 */
export class RunRecording {
  readonly runId: number;
  readonly #opts: RecordingOptions;
  readonly #started = Date.now();
  /** The row as recorded so far: the Agent's settings, then the model and usage once the Runner returns. */
  #rowSoFar: Partial<RunRow> = {};

  constructor(opts: RecordingOptions, runId: number) {
    this.#opts = opts;
    this.runId = runId;
  }

  /** The Run's settings are known: the row shows them if the Run fails before it returns. */
  planned(spec: RunSpec): void {
    this.#rowSoFar = { model: spec.model ?? null, effort: spec.effort ?? null };
  }

  /** The Runner returned: keep what the Run printed, and what it used and which model did it. */
  async returned(spec: RunSpec, result: RunResult): Promise<void> {
    await this.#keepRaw(result.stdout);
    this.#rowSoFar = {
      model: result.model ?? spec.model ?? null,
      effort: spec.effort ?? null,
      ...result.usage,
    };
  }

  /** Closes the row of a Run that passed. */
  finish(result: RunResult): void {
    this.#opts.store.finishRun(this.runId, {
      ...this.#rowSoFar,
      verdict: result.verdict,
      duration_ms: this.#duration(),
      exit_code: 0,
      report_path: result.reportPath,
    });
  }

  /** Closes the row of a Run that failed for any reason, keeping what a `RunFailure` carries. */
  async fail(error: unknown): Promise<void> {
    if (error instanceof RunFailure) {
      if (error.stdout) await this.#keepRaw(error.stdout);
      if (error.usage) this.#rowSoFar = { ...this.#rowSoFar, ...error.usage };
    }
    this.#opts.store.finishRun(this.runId, {
      ...this.#rowSoFar,
      ...(error instanceof RunFailure &&
        error.exitCode !== undefined && { exit_code: error.exitCode }),
      duration_ms: this.#duration(),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  #duration(): number {
    return Date.now() - this.#started;
  }

  /**
   * Saves what a Run printed (Claude's whole `stream-json` output, one JSON object per line) to
   * `<runsDir>/<id>.json`. It is for diagnosis, so a failure to write it is logged and never hides
   * the Run's own outcome.
   */
  async #keepRaw(stdout: string): Promise<void> {
    const { runsDir, log = console.error } = this.#opts;
    try {
      await mkdir(runsDir, { recursive: true });
      await writeFile(join(runsDir, `${this.runId}.json`), stdout);
    } catch (e) {
      log(`could not keep the output of Run ${this.runId}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
