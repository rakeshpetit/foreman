import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedCall {
  topic: string;
  title: string | undefined;
  priority: string | undefined;
  tags: string | undefined;
  body: string;
}

/** A local HTTP server that records ntfy publishes. Set `status` to simulate failure, `hang` to never answer. */
export class FakeNtfy {
  readonly calls: RecordedCall[] = [];
  status = 200;
  hang = false;
  #server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const h = req.headers;
      this.calls.push({
        topic: decodeURIComponent((req.url ?? "").slice(1)),
        title: h.title as string | undefined,
        priority: h.priority as string | undefined,
        tags: h.tags as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (this.hang) return;
      res.statusCode = this.status;
      res.end("{}");
    });
  });

  async start(): Promise<string> {
    await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
}
