import { createServer } from "node:http";
import * as readline from "node:readline";

import type { components } from "@krovacloud/sdk";
import { krovaErrorFrom } from "@krovacloud/sdk";
import { verifyKrovaWebhookOrThrow } from "@krovacloud/webhook";
import { Command } from "commander";

import { printJSON, printKeyValue, printTable } from "../lib/output.js";
import { getRuntime, makeClient, resolveSpace } from "../lib/runtime.js";

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

  // A webhook endpoint as the API returns it. The list endpoint omits
  // `description`; POST and GET /:id include it. Keep it optional so a single
  // type covers both shapes without inventing fields the server didn't send.
  type Webhook = components["schemas"]["Webhook"] & { description?: string | null };
  type WebhookWithSecret = Webhook & { secret: string };
  type WebhookDelivery = components["schemas"]["WebhookDelivery"];

  /** Read a y/N line from stdin. Empty / non-y answers count as "no". */
  function confirm(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      });
    });
  }

  wh
    .command("list")
    .description("list webhook endpoints in the active space")
    .action(async (_opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const { data, error, response } = await client.raw.GET(
        "/spaces/{spaceId}/webhooks",
        { params: { path: { spaceId: space } } },
      );
      if (!response.ok) throw krovaErrorFrom(response, error);
      const { webhooks } = data as unknown as { webhooks: Webhook[] };
      if (rt.json) return printJSON(webhooks);
      printTable(
        ["ID", "URL", "DESCRIPTION", "EVENTS", "ENABLED", "CREATED AT"],
        webhooks.map((w) => [
          w.id,
          w.url,
          w.description ?? "—",
          w.events.join(","),
          String(w.enabled),
          w.createdAt,
        ]),
      );
    });

  wh
    .command("add")
    .description("create a webhook endpoint (signing secret shown once)")
    .requiredOption("--url <url>", "the URL Krova should POST events to")
    .requiredOption(
      "--events <list>",
      "comma-separated event names (e.g. cube.running,cube.stopped)",
    )
    .option("--description <text>", "human-readable description for this endpoint")
    .action(async (opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const events = String(opts.events)
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      if (events.length === 0) {
        throw new Error("--events must list at least one event (e.g. cube.running).");
      }
      const body: { url: string; events: string[]; description?: string } = {
        url: String(opts.url),
        events,
      };
      if (opts.description) body.description = String(opts.description);
      const { data, error, response } = await client.raw.POST(
        "/spaces/{spaceId}/webhooks",
        { params: { path: { spaceId: space } }, body: body as never },
      );
      if (!response.ok) throw krovaErrorFrom(response, error);
      const created = (data as unknown as { webhook: WebhookWithSecret }).webhook;
      if (rt.json) {
        // Emit the full { webhook, secret } shape so callers don't have to
        // guess which field carries the secret. After this point, the CLI
        // must NOT echo the secret again.
        return printJSON({ webhook: created, secret: created.secret });
      }
      process.stdout.write(`\nCreated webhook ${created.id} for ${created.url}\n`);
      process.stdout.write("\n=== SIGNING SECRET (save now, shown once) ===\n");
      process.stdout.write(`${created.secret}\n`);
      process.stdout.write("=== END SIGNING SECRET ===\n\n");
      process.stdout.write("Save this now — it is the only time the secret will be shown.\n");
    });

  wh
    .command("get")
    .argument("<endpoint-id>", "the webhook endpoint ID")
    .description("show a single webhook endpoint")
    .action(async (endpointId: string, _opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const { data, error, response } = await client.raw.GET(
        "/spaces/{spaceId}/webhooks/{endpointId}",
        { params: { path: { spaceId: space, endpointId } } },
      );
      if (!response.ok) throw krovaErrorFrom(response, error);
      const { webhook } = data as unknown as { webhook: Webhook };
      if (rt.json) return printJSON(webhook);
      const rows: Array<[string, string]> = [
        ["ID", webhook.id],
        ["URL", webhook.url],
      ];
      if (webhook.description != null) rows.push(["Description", webhook.description]);
      rows.push(
        ["Events", webhook.events.join(",")],
        ["Enabled", String(webhook.enabled)],
        ["Created At", webhook.createdAt],
        ["Updated At", webhook.updatedAt],
      );
      printKeyValue(rows);
    });

  wh
    .command("rm")
    .argument("<endpoint-id>", "the webhook endpoint ID")
    .option("-y, --yes", "skip the confirmation prompt")
    .description("delete a webhook endpoint (and its delivery history)")
    .action(async (endpointId: string, opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      if (!opts.yes) {
        const ok = await confirm(
          `Delete webhook ${endpointId}? This also drops its delivery history. [y/N] `,
        );
        if (!ok) {
          process.stdout.write("Aborted.\n");
          return;
        }
      }
      const { error, response } = await client.raw.DELETE(
        "/spaces/{spaceId}/webhooks/{endpointId}",
        { params: { path: { spaceId: space, endpointId } } },
      );
      if (!response.ok) throw krovaErrorFrom(response, error);
      if (rt.json) return printJSON({ id: endpointId, result: "deleted" });
      process.stdout.write(`Deleted webhook ${endpointId}\n`);
    });

  wh
    .command("deliveries")
    .argument("<endpoint-id>", "the webhook endpoint ID")
    .option("--limit <n>", "max deliveries to return (1-100)", "50")
    .description("list recent delivery attempts for a webhook endpoint")
    .action(async (endpointId: string, opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("--limit must be an integer between 1 and 100.");
      }
      const { data, error, response } = await client.raw.GET(
        "/spaces/{spaceId}/webhooks/{endpointId}/deliveries",
        { params: { path: { spaceId: space, endpointId }, query: { limit } } },
      );
      if (!response.ok) throw krovaErrorFrom(response, error);
      const { deliveries } = data as unknown as { deliveries: WebhookDelivery[] };
      if (rt.json) return printJSON(deliveries);
      printTable(
        ["ID", "EVENT", "STATUS", "ATTEMPTS", "LAST ATTEMPT", "RESPONSE", "CREATED AT"],
        deliveries.map((d) => [
          d.id,
          d.event,
          d.status,
          String(d.attempts),
          d.lastAttemptAt ?? "—",
          d.responseStatus != null ? String(d.responseStatus) : "—",
          d.createdAt,
        ]),
      );
    });

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
