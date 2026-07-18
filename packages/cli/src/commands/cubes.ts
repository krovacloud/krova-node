import { Command } from "commander";

import { printJSON, printKeyValue, printTable } from "../lib/output.js";
import { resolveCube } from "../lib/resolve.js";
import { getRuntime, makeClient, resolveSpace } from "../lib/runtime.js";

function listCmd(): Command {
  return new Command("list")
    .aliases(["ls"])
    .description("list Cubes in the space")
    .action(async (_opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const { cubes } = await client.cubes.list(space);
      if (rt.json) return printJSON(cubes);
      printTable(
        ["ID", "NAME", "STATE", "VCPU", "RAM(GB)", "DISK(GB)", "IMAGE", "IPV4"],
        cubes.map((c) => [
          c.id,
          c.name,
          c.state,
          String(c.resources.vcpu),
          String(c.resources.ramGb),
          String(c.resources.diskGb),
          c.image,
          c.publicIpv4 ?? "—",
        ])
      );
    });
}

function getCmd(): Command {
  return new Command("get")
    .argument("<cube>", "cube name or ID")
    .description("show a single Cube")
    .action(async (cubeRef: string, _opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const cube = await client.cubes.get(space, id);
      if (rt.json) return printJSON(cube);
      printKeyValue([
        ["ID", cube.id],
        ["Name", cube.name],
        ["State", cube.state],
        ["Image", cube.image],
        ["vCPU", String(cube.resources.vcpu)],
        ["RAM (GB)", String(cube.resources.ramGb)],
        ["Disk (GB)", String(cube.resources.diskGb)],
        ["Public IPv4", cube.publicIpv4 ?? "—"],
        ["Cost/hour", `$${cube.costPerHour}`],
      ]);
    });
}

function createCmd(): Command {
  return new Command("create")
    .description("provision a new Cube")
    .requiredOption("--name <name>", "cube name")
    .requiredOption("--image <slug>", "OS image slug (see `krova images`)")
    .requiredOption("--ssh-key <key>", "SSH public key written to authorized_keys")
    .option("--vcpu <n>", "number of vCPUs", "1")
    .option("--ram <gb>", "RAM in GB", "1")
    .option("--disk <gb>", "disk size in GB", "10")
    .option("--region <slug>", "region slug (see `krova regions`)")
    .option("--user-data <script>", "cloud-init script")
    .option("--idempotency-key <key>", "idempotency key (24h dedupe)")
    .action(async (opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      // Validate resources client-side so bad input fails with a clear message
      // rather than being coerced to NaN → JSON null → a generic server 400.
      const posInt = (flag: string, raw: string): number => {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--${flag} must be a positive integer (got "${raw}").`);
        }
        return n;
      };
      const body: Record<string, unknown> = {
        name: opts.name,
        image: opts.image,
        sshPublicKey: opts.sshKey,
        resources: {
          vcpu: posInt("vcpu", opts.vcpu),
          ramGb: posInt("ram", opts.ram),
          diskGb: posInt("disk", opts.disk),
        },
      };
      if (opts.region) body.region = opts.region;
      if (opts.userData) body.userData = opts.userData;
      const cube = await client.cubes.create(
        space,
        body as never,
        opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined
      );
      if (rt.json) return printJSON(cube);
      process.stdout.write(`Created cube ${cube.id} (${cube.state})\n`);
    });
}

function actionCmd(
  name: string,
  past: string,
  fn: (c: ReturnType<typeof makeClient>["cubes"], space: string, id: string) => Promise<unknown>
): Command {
  return new Command(name)
    .argument("<cube>", "cube name or ID")
    .description(`${name} a Cube`)
    .action(async (cubeRef: string, _opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      await fn(client.cubes, space, id);
      if (rt.json) return printJSON({ id, result: past });
      process.stdout.write(`${past} cube ${id}\n`);
    });
}

function sshPortCmd(): Command {
  return new Command("ssh-port")
    .argument("<cube>", "cube name or ID")
    .requiredOption("--port <n>", "the host port to expose SSH on")
    .description("change the host port a Cube's SSH is reachable on")
    .action(async (cubeRef: string, opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const cubePort = Number(opts.port);
      if (!Number.isInteger(cubePort) || cubePort < 1 || cubePort > 65535) {
        throw new Error("--port must be an integer between 1 and 65535");
      }
      await client.cubes.update(space, id, { cubePort } as never);
      if (rt.json) return printJSON({ id, cubePort });
      process.stdout.write(`SSH port for cube ${id} set to ${cubePort}\n`);
    });
}

export function cubesCommand(): Command {
  const cubes = new Command("cubes").description("manage Cubes (Firecracker microVMs)");
  cubes.addCommand(listCmd());
  cubes.addCommand(getCmd());
  cubes.addCommand(createCmd());
  cubes.addCommand(
    actionCmd("power-off", "Powering off", (c, s, id) => c.powerOff(s, id)),
  );
  cubes.addCommand(actionCmd("wake", "Starting", (c, s, id) => c.wake(s, id)));
  cubes.addCommand(actionCmd("delete", "Deleting", (c, s, id) => c.delete(s, id)));
  cubes.addCommand(sshPortCmd());
  return cubes;
}

// `list` and `get` are also mounted at the root (parity with the Go CLI).
export const rootListCommand = listCmd;
export const rootGetCommand = getCmd;
