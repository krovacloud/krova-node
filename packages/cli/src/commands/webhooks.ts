import { createServer } from "node:http";

import { verifyKrovaWebhookOrThrow } from "@krovacloud/webhook";
import { Command } from "commander";

import { printJSON } from "../lib/output.js";
import { getRuntime } from "../lib/runtime.js";

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
      const addr = String(opts.addr);
      const lastColon = addr.lastIndexOf(":");
      const host = lastColon > 0 ? addr.slice(0, lastColon) : "127.0.0.1";
      const port = Number(lastColon > 0 ? addr.slice(lastColon + 1) : addr) || 4666;
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
