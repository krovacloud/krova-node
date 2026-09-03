import { Command } from "commander";

import { printJSON, printTable } from "../lib/output.js";
import { resolveCube } from "../lib/resolve.js";
import { getRuntime, makeClient, resolveSpace } from "../lib/runtime.js";

/** `krova tcp` — manage a Cube's TCP port mappings. */
export function tcpCommand(): Command {
  const cmd = new Command("tcp").description("manage a Cube's TCP port mappings");

  cmd
    .command("list")
    .argument("<cube>", "cube name or ID")
    .description("list a Cube's TCP port mappings")
    .action(async (cubeRef: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const maps = await client.tcpMappings.list(space, id);
      if (rt.json) return printJSON(maps);
      printTable(
        ["ID", "CUBE PORT", "HOST PORT", "LABEL", "STATUS", "SSH"],
        maps.map((m) => [
          m.id,
          String(m.cubePort),
          String(m.hostPort),
          m.label ?? "",
          m.status,
          m.isSsh ? "yes" : "no",
        ]),
      );
    });

  cmd
    .command("add")
    .argument("<cube>", "cube name or ID")
    .requiredOption("--port <n>", "the in-Cube port to expose")
    .option(
      "--whitelist <cidr>",
      "restrict access to this IP/CIDR (repeatable)",
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .description("expose a Cube TCP port on the host, optionally IP-restricted")
    .action(async (cubeRef: string, opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const cubePort = Number(opts.port);
      if (!Number.isInteger(cubePort) || cubePort <= 0 || cubePort > 65535) {
        throw new Error(`--port must be a valid port (got "${opts.port}").`);
      }
      const whitelist = opts.whitelist as string[];
      // ⛔ `whitelistedIps` — NOT `whitelistIps`. The published spec named the
      // field `whitelistIps` while the server has always read
      // `whitelistedIps`, so every `--whitelist` mapping this CLI created was
      // silently published WORLD-OPEN, with a 201 and no error. Reproduced on
      // production 2026-09-02: a mapping added with `--whitelist
      // 203.0.113.0/24` served content to an off-list address.
      //
      // The server now accepts both names, so an older CLI keeps working; this
      // sends the canonical one.
      const mapping = await client.tcpMappings.create(space, id, {
        cubePort,
        ...(whitelist.length ? { whitelistedIps: whitelist } : {}),
      });
      if (rt.json) return printJSON(mapping);
      process.stdout.write(
        `Mapped cube port ${mapping.cubePort} → host port ${mapping.hostPort} (${mapping.id})\n`,
      );
    });

  cmd
    .command("rm")
    .argument("<cube>", "cube name or ID")
    .argument("<mapping-id>", "the mapping ID (see `krova tcp list`)")
    .description("remove a TCP port mapping")
    .action(async (cubeRef: string, mappingId: string, _opts, c: Command) => {
      const rt = getRuntime(c);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      await client.tcpMappings.delete(space, id, mappingId);
      if (rt.json) return printJSON({ id: mappingId, result: "removed" });
      process.stdout.write(`Removed TCP mapping ${mappingId}\n`);
    });

  return cmd;
}
