import { Command } from "commander";

import { printJSON, printTable } from "../lib/output.js";
import { resolveCube } from "../lib/resolve.js";
import { getRuntime, makeClient, resolveSpace } from "../lib/runtime.js";

/**
 * Narrow a `--origin-scheme` / positional scheme to the two the API accepts.
 * Returns undefined when the flag was omitted, so callers can leave the field
 * off the request entirely rather than sending an explicit default.
 */
export function parseOriginScheme(value: unknown): "http" | "https" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "http" || value === "https") return value;
  throw new Error(`--origin-scheme must be "http" or "https" (got "${String(value)}").`);
}

type PrintableRecord = {
  type: string;
  host: string;
  value: string;
  note?: string | null;
  mustBeGrey?: boolean;
  state?: string;
  detail?: string;
};

/** How each live state reads on a terminal. */
const STATE_LABEL: Record<string, string> = {
  found: "found",
  // ⛔ NOT "failed". Before you publish a record, absent is the expected state.
  missing: "not added yet",
  mismatch: "needs a change",
  // ⛔ OUR lookup failed. Never phrased as the user's mistake.
  unknown: "couldn't check",
};

/**
 * Print the DNS records a domain needs.
 *
 * Both the host AND the value, because a record cannot be created from the
 * value alone — which is what made the old guidance impossible to act on.
 */
function printRecords(records: PrintableRecord[], withState = false): void {
  if (records.length === 0) return;
  process.stdout.write("\nDNS records to publish:\n");
  for (const r of records) {
    const state = withState && r.state ? `  [${STATE_LABEL[r.state] ?? r.state}]` : "";
    process.stdout.write(`\n  ${r.type.padEnd(5)} ${r.host}${state}\n`);
    process.stdout.write(`        -> ${r.value}\n`);
    if (r.mustBeGrey) {
      // The single most common wildcard failure: proxied, so the CA sees
      // Cloudflare's addresses instead of the record.
      process.stdout.write("        On Cloudflare: DNS only (grey cloud)\n");
    }
    if (withState && r.detail && r.state !== "found") {
      process.stdout.write(`        ${r.detail}\n`);
    }
  }
}

/** `krova domains` — manage a Cube's custom domains. */
export function domainsCommand(): Command {
  const cmd = new Command("domains").description("manage a Cube's custom domains");

  cmd
    .command("list")
    .argument("<cube>", "cube name or ID")
    .description("list the custom domains attached to a Cube")
    .action(async (cubeRef: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const domains = await client.domains.list(space, id);
      if (rt.json) return printJSON(domains);
      printTable(
        ["ID", "DOMAIN", "PORT", "STATUS"],
        domains.map((d) => [d.id, d.domain, String(d.port ?? ""), d.status]),
      );
    });

  cmd
    .command("add")
    .argument("<cube>", "cube name or ID")
    .requiredOption("--domain <domain>", "the domain name to attach")
    .requiredOption("--port <n>", "the in-Cube port to route to")
    .option("--origin-scheme <scheme>", "transport the edge uses to reach the Cube: http (default) or https when the Cube terminates TLS itself")
    .description("attach a custom domain to a Cube")
    .action(async (cubeRef: string, opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`--port must be a valid port (got "${opts.port}").`);
      }
      const originScheme = parseOriginScheme(opts.originScheme);
      const { domain, records } = await client.domains.create(space, id, {
        domain: opts.domain,
        port,
        ...(originScheme ? { originScheme } : {}),
      });
      if (rt.json) return printJSON({ domain, records });
      process.stdout.write(`Attached ${domain.domain} (${domain.id}) — status ${domain.status}\n`);
      // ⛔ Print the records. Attaching a domain does nothing until they exist,
      // and before this the CLI sent people away to find out what to publish —
      // for a wildcard, two of the three records were not discoverable from
      // anything the CLI printed.
      printRecords(records);
      process.stdout.write(
        `\nAfter publishing them: krova domains records ${cubeRef} ${domain.id}\n`,
      );
    });

  cmd
    .command("records")
    .argument("<cube>", "cube name or ID")
    .argument("<domain-id>", "the domain mapping ID (see `krova domains list`)")
    .description("show the DNS records a domain needs, and whether they resolve yet")
    .action(async (cubeRef: string, mappingId: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const out = await client.domains.records(space, id, mappingId);
      if (rt.json) return printJSON(out);
      process.stdout.write(
        `${out.domain} — ${out.summary.found} of ${out.summary.total} records found\n`,
      );
      printRecords(out.records, true);
      if (!out.summary.complete) {
        process.stdout.write("\nDNS changes can take a few minutes to spread.\n");
      }
    });

  cmd
    .command("set-origin")
    .argument("<cube>", "cube name or ID")
    .argument("<domain-id>", "the domain mapping ID (see `krova domains list`)")
    .argument("<scheme>", "http or https")
    .description("set the transport the edge uses to reach the Cube")
    .action(async (cubeRef: string, mappingId: string, scheme: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const originScheme = parseOriginScheme(scheme);
      if (!originScheme) {
        throw new Error(`scheme must be "http" or "https" (got "${scheme}").`);
      }
      const domain = await client.domains.update(space, id, mappingId, { originScheme });
      if (rt.json) return printJSON(domain);
      process.stdout.write(`${domain.domain} now reached over ${originScheme}\n`);
    });

  cmd
    .command("rm")
    .argument("<cube>", "cube name or ID")
    .argument("<domain-id>", "the domain mapping ID (see `krova domains list`)")
    .description("detach a custom domain from a Cube")
    .action(async (cubeRef: string, mappingId: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      await client.domains.delete(space, id, mappingId);
      if (rt.json) return printJSON({ id: mappingId, result: "detached" });
      process.stdout.write(`Detached domain ${mappingId}\n`);
    });

  return cmd;
}
