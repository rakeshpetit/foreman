import { readFileSync } from "node:fs";

export function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--version")) console.log(version());
}
