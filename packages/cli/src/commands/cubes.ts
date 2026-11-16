import { Command } from "commander";

import {
  type CatalogSource,
  type KeyFiles,
  type PromptIO,
  DEFAULT_RESOURCES,
  PromptAbortError,
  confirmCreate,
  createReadlineIO,
  defaultKeyFiles,
  isInteractive,
  promptCreate,
  summarize,
} from "../lib/create-prompt.js";
import { printJSON, printKeyValue, printTable } from "../lib/output.js";
import { resolveCube } from "../lib/resolve.js";
import { confirm, printAborted, shouldConfirm } from "../lib/safety.js";
import { getRuntime, makeClient, resolveSpace } from "../lib/runtime.js";
import { withSpinner } from "../lib/spinner.js";

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
        ["ID", "NAME", "STATE", "VCPU", "RAM(GB)", "DISK(GB)", "IMAGE", "IPV4", "PROTECTED"],
        cubes.map((c) => [
          c.id,
          c.name,
          c.state,
          String(c.resources.vcpu),
          String(c.resources.ramGb),
          String(c.resources.diskGb),
          c.image,
          c.publicIpv4 ?? "—",
          // The ✓ is the only character readable in a terminal at 80-column
          // width; spelling out "yes"/"no" pushes the column past the screen
          // edge on the smallest supported layout. Empty cell when the flag is
          // off — the header column is the cue.
          c.terminationProtection ? "✓" : "",
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

/** The values `cubes create` turns into a request body. All strings, as typed. */
export interface CreateBodyInput {
  name: string;
  image: string;
  sshKey: string;
  vcpu: string;
  ram: string;
  disk: string;
  region?: string;
  userData?: string;
  terminationProtection?: boolean;
}

/**
 * Build the POST /cubes body. Validates resources client-side so bad input
 * fails with a clear message rather than being coerced to NaN, then JSON null,
 * then a generic server 400.
 */
export function buildCreateBody(input: CreateBodyInput): Record<string, unknown> {
  const posInt = (flag: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--${flag} must be a positive integer (got "${raw}").`);
    }
    return n;
  };
  const body: Record<string, unknown> = {
    name: input.name,
    image: input.image,
    sshPublicKey: input.sshKey,
    resources: {
      vcpu: posInt("vcpu", input.vcpu),
      ramGb: posInt("ram", input.ram),
      diskGb: posInt("disk", input.disk),
    },
  };
  if (input.region) body.region = input.region;
  if (input.userData) body.userData = input.userData;
  // Only send the flag when explicitly turned on; the server defaults it
  // to `false`, and an explicit `false` would just be noise on the wire.
  if (input.terminationProtection) body.terminationProtection = true;
  return body;
}

/** What `cubes create` needs from the outside world; tests swap these. */
export interface CreateDeps {
  /** Whether prompting is allowed (a real terminal, and not --json). */
  interactive: (json: boolean) => boolean;
  makeIO: () => PromptIO;
  keyFiles: () => KeyFiles;
  /** Catalog to list images and regions from; defaults to the API client's. */
  catalog?: (client: ReturnType<typeof makeClient>) => CatalogSource;
  /** Where human messages go; defaults to stdout. */
  stdout?: (text: string) => void;
}

const defaultCreateDeps: CreateDeps = {
  interactive: (json) => isInteractive({ json }),
  makeIO: createReadlineIO,
  keyFiles: defaultKeyFiles,
};

// Required on the command line unless the terminal can ask. Order is the order
// commander reports a missing one in.
const REQUIRED_CREATE_FLAGS = [
  ["--name", "name"],
  ["--image", "image"],
  ["--ssh-key", "sshKey"],
] as const;

export function createCmd(deps: CreateDeps = defaultCreateDeps): Command {
  return new Command("create")
    .description("provision a new Cube (in a terminal, asks for anything you leave out)")
    .option("--name <name>", "cube name")
    .option("--image <slug>", "OS image slug (see `krova images`)")
    .option("--ssh-key <key>", "SSH public key written to authorized_keys")
    .option("--vcpu <n>", "number of vCPUs", DEFAULT_RESOURCES.vcpu)
    .option("--ram <gb>", "RAM in GB", DEFAULT_RESOURCES.ram)
    .option("--disk <gb>", "disk size in GB", DEFAULT_RESOURCES.disk)
    .option("--region <slug>", "region slug (see `krova regions`)")
    .option("--user-data <script>", "cloud-init script")
    .option("--idempotency-key <key>", "idempotency key (24h dedupe)")
    .option(
      "--termination-protection",
      "turn on termination protection (the cube cannot be deleted until turned off)",
      false
    )
    .option("-y, --yes", "skip the confirmation after the prompts")
    .action(async (opts, cmd: Command) => {
      // --name, --image and --ssh-key were requiredOption; without a terminal
      // they still are, with commander's own message and exit code.
      const missing = REQUIRED_CREATE_FLAGS.filter(([, key]) => opts[key] === undefined);
      const globals = cmd.optsWithGlobals() as { json?: unknown; output?: unknown };
      const wantsJson = Boolean(globals.json) || globals.output === "json";
      const prompting = missing.length > 0 && deps.interactive(wantsJson);
      if (missing.length > 0 && !prompting) {
        const flags = cmd.options.find((o) => o.long === missing[0]?.[0])?.flags;
        cmd.error(`error: required option '${flags}' not specified`, {
          code: "commander.missingMandatoryOptionValue",
        });
      }
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const out = deps.stdout ?? ((text: string) => void process.stdout.write(text));
      const build = (v: {
        name: string;
        image: string;
        sshKey: string;
        vcpu: string;
        ram: string;
        disk: string;
        region?: string;
      }) =>
        buildCreateBody({
          ...v,
          userData: opts.userData,
          terminationProtection: opts.terminationProtection,
        });
      let body: Record<string, unknown>;
      if (prompting) {
        const io = deps.makeIO();
        try {
          // A resource flag counts as given only when it came from the command line.
          const given = (key: "vcpu" | "ram" | "disk") =>
            cmd.getOptionValueSource(key) === "default" ? undefined : (opts[key] as string);
          const answers = await promptCreate(
            {
              name: opts.name,
              image: opts.image,
              sshKey: opts.sshKey,
              region: opts.region,
              vcpu: given("vcpu"),
              ram: given("ram"),
              disk: given("disk"),
            },
            {
              io,
              catalog: deps.catalog ? deps.catalog(client) : client.catalog,
              keyFiles: deps.keyFiles(),
            }
          );
          // Build first so a bad flag value fails before the confirmation, not after it.
          body = build(answers);
          if (!opts.yes && !(await confirmCreate(io, summarize(answers)))) {
            out("Aborted.\n");
            return;
          }
        } catch (err) {
          if (!(err instanceof PromptAbortError)) throw err;
          out("\nAborted.\n");
          process.exitCode = 1;
          return;
        } finally {
          io.close();
        }
      } else {
        body = build({
          name: opts.name,
          image: opts.image,
          sshKey: opts.sshKey,
          vcpu: opts.vcpu,
          ram: opts.ram,
          disk: opts.disk,
          region: opts.region,
        });
      }
      const cube = await withSpinner("Creating cube", { json: rt.json }, () =>
        client.cubes.create(
          space,
          body as never,
          opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined
        )
      );
      if (rt.json) return printJSON(cube);
      out(`Created cube ${cube.id} (${cube.state})\n`);
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

function deleteCmd(): Command {
  return new Command("delete")
    .argument("<cube>", "cube name or ID")
    .option("-y, --yes", "skip the confirmation prompt")
    .description("delete a Cube (permanent)")
    .action(async (cubeRef: string, opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      if (shouldConfirm(opts)) {
        const ok = await confirm(
          `Delete cube ${cubeRef}${cubeRef === id ? "" : ` (${id})`}? This is permanent and cannot be undone. [y/N] `,
        );
        if (!ok) return printAborted(rt.json);
      }
      await client.cubes.delete(space, id);
      if (rt.json) return printJSON({ id, result: "Deleting" });
      process.stdout.write(`Deleting cube ${id}\n`);
    });
}

function restartCmd(): Command {
  return new Command("restart")
    .argument("<cube>", "cube name or ID")
    .description("restart a Cube (cold restart — picks up a refreshed kernel)")
    .action(async (cubeRef: string, _opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      await client.cubes.restart(space, id);
      if (rt.json) return printJSON({ id, result: "Restarting" });
      // Say COLD explicitly. A `reboot` from inside the Cube looks equivalent
      // but cannot change the kernel — Firecracker treats a guest reboot as a
      // shutdown and the kernel comes from the host.
      process.stdout.write(
        `Restarting cube ${id} (cold restart — disk state is preserved)\n`,
      );
    });
}

function sshPortCmd(): Command {
  return new Command("ssh-port")
    .argument("<cube>", "cube name or ID")
    .requiredOption(
      "--port <n>",
      "the port INSIDE the Cube that sshd listens on (default 22)",
    )
    .description("change the in-Cube port that SSH is forwarded to (not the host port)")
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
      // Be explicit about WHICH side changed. The host port is assigned by
      // Krova and is not affected by this call, so pointing this at a port
      // nothing is listening on inside the Cube silently breaks SSH access.
      process.stdout.write(
        `Cube ${id}: SSH now forwarded to in-Cube port ${cubePort}.\n` +
          (cubePort === 22
            ? ""
            : `Warning: sshd inside the Cube must be listening on ${cubePort}, ` +
              "or SSH will stop working. The default is 22.\n"),
      );
    });
}

/**
 * Toggle a Cube's termination-protection flag. Shared by `protect` and
 * `unprotect`; only the boolean `enabled` differs.
 */
function setProtectionCmd(name: string, enabled: boolean, past: string): Command {
  return new Command(name)
    .argument("<cube>", "cube name or ID")
    .description(
      enabled
        ? "turn on termination protection (idempotent — no-op if already on; the cube cannot be deleted until turned off)"
        : "turn off termination protection (idempotent — no-op if already off)",
    )
    .action(async (cubeRef: string, _opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      // The SDK call is idempotent: re-protecting a protected cube or
      // unprotecting an unprotected one is a no-op on the server. The CLI
      // surfaces the latest audit fields in `--json` for callers that want to
      // see who last changed the flag.
      const cube = await client.cubes.setTerminationProtection(space, id, enabled);
      if (rt.json) return printJSON(cube);
      process.stdout.write(`${past} cube ${id}\n`);
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
  cubes.addCommand(deleteCmd());
  cubes.addCommand(restartCmd());
  cubes.addCommand(sshPortCmd());
  cubes.addCommand(setProtectionCmd("protect", true, "Protected"));
  cubes.addCommand(setProtectionCmd("unprotect", false, "Unprotected"));
  return cubes;
}

// `list` and `get` are also mounted at the root (parity with the Go CLI).
export const rootListCommand = listCmd;
export const rootGetCommand = getCmd;
