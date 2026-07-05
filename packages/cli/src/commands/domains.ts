import { Command } from "commander";

import { printJSON, printTable } from "../lib/output.js";
import { resolveCube } from "../lib/resolve.js";
import { getRuntime, makeClient, resolveSpace } from "../lib/runtime.js";

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
      const domain = await client.domains.create(space, id, { domain: opts.domain, port });
      if (rt.json) return printJSON(domain);
      process.stdout.write(`Attached ${domain.domain} (${domain.id}) — status ${domain.status}\n`);
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
