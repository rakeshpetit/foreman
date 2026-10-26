import { execFile } from "node:child_process";

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The seam to the `docker` CLI. Resolves with the exit code instead of throwing on a non-zero exit. */
export interface Docker {
  run(args: string[]): Promise<DockerResult>;
}

export class CliDocker implements Docker {
  run(args: string[]): Promise<DockerResult> {
    return new Promise((resolve, reject) => {
      execFile("docker", args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        // A numeric `code` is docker's own exit status; anything else (ENOENT, a signal) is not a result.
        if (typeof error.code === "number") return resolve({ code: error.code, stdout, stderr });
        reject(error);
      });
    });
  }
}

export class DockerError extends Error {}

/** The last lines of a command's output: where its error is. */
export function tail(text: string): string {
  return text.trim().split("\n").slice(-10).join("\n");
}

/** Runs a docker command that must succeed. */
export async function mustRun(docker: Docker, args: string[]): Promise<DockerResult> {
  const result = await docker.run(args);
  if (result.code !== 0) {
    const detail = tail(result.stderr);
    // The command and subcommand only: the flags after them are noise in a message.
    const firstFlag = args.findIndex((a) => a.startsWith("-"));
    const command = firstFlag === -1 ? args : args.slice(0, firstFlag);
    throw new DockerError(`docker ${command.join(" ")} failed (exit ${result.code}): ${detail}`);
  }
  return result;
}
