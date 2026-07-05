import { createServer } from "node:http";

import { verifyKrovaWebhookOrThrow } from "@krovacloud/webhook";
import { Command } from "commander";

import { printJSON } from "../lib/output.js";
import { getRuntime } from "../lib/runtime.js";

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 4666;

/**
 * Parse a `--addr` value into `{ host, port }`. Handles `host:port`, a bare host
 * (e.g. `localhost`), a bare port, bracketed IPv6 (`[::1]:4666`), and bare IPv6
 * (`::1`). Exported for testing.
 */
export function parseListenAddr(addr: string): { host: string; port: number } {
  const s = (addr ?? "").trim();
  // Bracketed IPv6: [::1] or [::1]:4666
  const bracket = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    return { host: bracket[1] as string, port: bracket[2] ? Number(bracket[2]) : DEFAULT_LISTEN_PORT };
  }
  // Two or more colons and no brackets ⇒ a bare IPv6 address with no port.
  if ((s.match(/:/g)?.length ?? 0) >= 2) {
    return { host: s, port: DEFAULT_LISTEN_PORT };
  }
  // Single colon ⇒ host:port.
  const i = s.lastIndexOf(":");
  if (i > 0) {
    const port = Number(s.slice(i + 1));
    return {
      host: s.slice(0, i),
      port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_LISTEN_PORT,
    };
  }
  // No colon ⇒ a bare port (all digits) or a bare host.
  if (/^\d+$/.test(s)) {
    const port = Number(s);
    return { host: DEFAULT_LISTEN_HOST, port: port > 0 && port <= 65535 ? port : DEFAULT_LISTEN_PORT };
  }
  return { host: s || DEFAULT_LISTEN_HOST, port: DEFAULT_LISTEN_PORT };
}

export function webhooksCommand(): Command {
  const wh = new Command("webhooks").description("developer tools for Krova Cloud webhooks");

  wh.command("listen")
    .description("run a local server that verifies + prints incoming webhook deliveries")
    .option("--addr <host:port>", "address to listen on", "127.0.0.1:4666")
    .option("--path <path>", "path to accept POSTs on", "/")
    .option("--secret <secret>", "signing secret (or the KROVA_WEBHOOK_SECRET env var)")
    .action((opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const secret = (opts.secret as string) || process.env.KROVA_WEBHOOK_SECRET || "";
      if (!secret) {
        throw new Error(
          "a signing secret is required: pass --secret or set KROVA_WEBHOOK_SECRET"
        );
      }
      const { host, port } = parseListenAddr(String(opts.addr));
      const wantPath = String(opts.path);

      const server = createServer((req, res) => {
        const reqPath = (req.url ?? "/").split("?")[0];
        if (req.method !== "POST" || reqPath !== wantPath) {
          res.writeHead(405);
          res.end("method not allowed");
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= 1_048_576) chunks.push(c);
        });
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const sig = (req.headers["x-krova-signature"] as string) || "";
          try {
            verifyKrovaWebhookOrThrow({ payload: body, signature: sig, secret });
          } catch (e) {
            process.stderr.write(`✗ rejected delivery: ${(e as Error).message}\n`);
            res.writeHead(400);
            res.end("invalid signature");
            return;
          }
          try {
            const event = JSON.parse(body);
            if (rt.json) process.stdout.write(`${JSON.stringify(event)}\n`);
            else printJSON(event);
          } catch {
            process.stdout.write(`${body}\n`);
          }
          res.writeHead(200);
          res.end("ok");
        });
      });

      server.listen(port, host, () => {
        process.stderr.write(`Listening for webhooks on http://${host}:${port}${wantPath}\n`);
      });
      const stop = () => server.close(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });

  return wh;
}
