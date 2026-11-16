import { KrovaError } from "@krovacloud/sdk";
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
        ["Idle timeout", describeIdleTimeout(cube.idleTimeoutMinutes)],
        ["Last active", cube.lastActiveAt ?? "-"],
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
  /** Minutes (10 to 10080) or `null` for off; leave out to send nothing. */
  idleTimeoutMinutes?: number | null;
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
  // `null` (--idle-timeout off) is sent on purpose; only `undefined` means "not given".
  if (input.idleTimeoutMinutes !== undefined) body.idleTimeoutMinutes = input.idleTimeoutMinutes;
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
    .option("--idle-timeout <minutes>", IDLE_TIMEOUT_HELP)
    .option("-y, --yes", "skip the confirmation after the prompts")
    .action(async (opts, cmd: Command) => {
      // Checked first so a bad value fails before any prompt or request.
      const idleTimeoutMinutes =
        opts.idleTimeout === undefined ? undefined : parseIdleTimeout(opts.idleTimeout);
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
          idleTimeoutMinutes,
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
      if (idleTimeoutMinutes !== undefined && !idleTimeoutApplied(cube.idleTimeoutMinutes, idleTimeoutMinutes)) {
        // An older server ignores the field it does not know and still answers 201.
        process.stderr.write(IDLE_UNSUPPORTED_WARNING);
      }
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

function renameCmd(): Command {
  return new Command("rename")
    .argument("<cube>", "cube name or ID")
    .argument("<new-name>", "the new name (1 to 64 printable characters)")
    .description("rename a Cube (names do not have to be unique; a running Cube's hostname changes on its next cold restart)")
    .action(async (cubeRef: string, rawName: string, _opts, cmd: Command) => {
      const newName = parseCubeName(rawName);
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const cube = await client.cubes.rename(space, id, newName);
      if (rt.json) return printJSON(cube);
      process.stdout.write(`Renamed cube ${id} to ${cube.name}\n`);
    });
}

const IDLE_TIMEOUT_HELP =
  'power the Cube off after this many minutes without activity (10 to 10080), or "off" (needs a server with the idle-timeout feature)';

const IDLE_UNSUPPORTED_WARNING =
  "Warning: this server did not report the requested idle timeout for the Cube, so --idle-timeout was probably ignored. It needs a server with the idle-timeout feature.\n";

/**
 * Parse `--idle-timeout`: whole minutes from 10 to 10080 (7 days), or `off`
 * (sent as `null`). Plain decimal digits only, so 1e2, 0x10 and " 20" fail.
 */
export function parseIdleTimeout(raw: string): number | null {
  if (raw === "off") return null;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 10 || n > 10080) {
    throw new Error('--idle-timeout must be a whole number of minutes from 10 to 10080, or "off"');
  }
  return n;
}

/**
 * Did the server apply the requested timeout? A present field must equal the request. An absent field means
 * the server omitted it (an older server, or a null it left out): that only counts as applied for `off`.
 */
export function idleTimeoutApplied(
  returned: number | null | undefined,
  requested: number | null,
): boolean {
  return returned === undefined ? requested === null : returned === requested;
}

/** `off` for a Cube with no timeout, `N min` for one with a timeout, `-` when the server does not say. */
export function describeIdleTimeout(minutes: number | null | undefined): string {
  if (minutes === undefined) return "-";
  return minutes === null ? "off" : `${minutes} min`;
}

function updateCmd(): Command {
  return new Command("update")
    .argument("<cube>", "cube name or ID")
    .option("--idle-timeout <minutes>", IDLE_TIMEOUT_HELP)
    .description("change a Cube's settings (idle auto-stop; `rename`, `resize` and `protect` cover the rest)")
    .action(async (cubeRef: string, opts, cmd: Command) => {
      if (opts.idleTimeout === undefined) {
        throw new Error("nothing to update: pass --idle-timeout <minutes|off>");
      }
      const minutes = parseIdleTimeout(opts.idleTimeout);
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);
      const cube = await client.cubes.setIdleTimeout(space, id, minutes);
      // A 200 that does not carry the new value means the server ignored the field; never report a change that did not happen.
      if (!idleTimeoutApplied(cube.idleTimeoutMinutes, minutes)) {
        throw new Error(
          cube.idleTimeoutMinutes === undefined
            ? "the server did not apply --idle-timeout (it needs a server with the idle-timeout feature)"
            : `the server kept the idle timeout at ${describeIdleTimeout(cube.idleTimeoutMinutes)}`
        );
      }
      if (rt.json) return printJSON(cube);
      process.stdout.write(
        minutes === null
          ? `Turned off idle auto-stop for cube ${id}\n`
          : `Set idle auto-stop for cube ${id} to ${minutes} min\n`
      );
    });
}

/** Parse a `--vcpu`/`--ram`/`--disk` value. `integer` rejects fractions (RAM may be fractional). */
export function parseSize(flag: string, raw: string, integer: boolean): number {
  // Plain decimal digits only: Number() would also take 0x10, 1e1 and " 5 ".
  const n = Number(raw);
  if (!(integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(raw) || !Number.isFinite(n) || n <= 0) {
    throw new Error(`${flag} must be a positive ${integer ? "whole number" : "number"}`);
  }
  return n;
}

/** Trim a new Cube name and check it locally: 1 to 64 characters, no control, line-separator or bidi characters. */
export function parseCubeName(raw: string): string {
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > 64 || /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(name)) {
    throw new Error("the new name must be 1 to 64 printable characters");
  }
  return name;
}

const RESIZE_DIMENSIONS = [
  { key: "vcpu", label: "vCPU", unit: "" },
  { key: "ramGb", label: "RAM", unit: " GB" },
  { key: "diskGb", label: "Disk", unit: " GB" },
] as const;

function describeSize(size: { vcpu: number; ramGb: number; diskGb: number }): string {
  return `${size.vcpu} vCPU, ${size.ramGb} GB RAM, ${size.diskGb} GB disk`;
}

function resizeCmd(): Command {
  return new Command("resize")
    .argument("<cube>", "cube name or ID")
    .option("--vcpu <n>", "new vCPU count")
    .option("--ram <gb>", "new RAM in GB (fractions allowed)")
    .option("--disk <gb>", "new disk in GB (disk can only grow)")
    .option("-y, --yes", "skip the confirmation prompt")
    .description(
      "change a Cube's vCPU, RAM and/or disk; the API says whether it is applied live or restarts the Cube",
    )
    .action(async (cubeRef: string, opts, cmd: Command) => {
      const resources: { vcpu?: number; ramGb?: number; diskGb?: number } = {};
      if (opts.vcpu !== undefined) resources.vcpu = parseSize("--vcpu", opts.vcpu, true);
      if (opts.ram !== undefined) resources.ramGb = parseSize("--ram", opts.ram, false);
      if (opts.disk !== undefined) resources.diskGb = parseSize("--disk", opts.disk, true);
      if (Object.keys(resources).length === 0) {
        throw new Error("give at least one of --vcpu, --ram or --disk");
      }

      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);

      // The API only says whether a resize is live or restarts the Cube AFTER it
      // queues the job, so the question cannot name the outcome: it states the
      // change and that some changes restart. Only a person at a terminal is
      // asked; scripts and pipes proceed, and -y skips it.
      if (shouldConfirm(opts)) {
        const current = (await client.cubes.get(space, id)).resources;
        const target = { ...current, ...resources };
        const ok = await confirm(
          `Resize cube ${cubeRef}${cubeRef === id ? "" : ` (${id})`} from ${describeSize(current)} to ${describeSize(target)}? A RAM decrease, or a vCPU change on a Cube that cannot hotplug, restarts the Cube. [y/N] `,
        );
        if (!ok) return printAborted(rt.json);
      }

      let result: Awaited<ReturnType<typeof client.cubes.resize>>;
      try {
        result = await client.cubes.resize(space, id, resources);
      } catch (err) {
        // The host, not the request, is out of room: retrying the same size
        // will not help, so say what will.
        if (
          err instanceof KrovaError &&
          err.status === 400 &&
          (err.body as { code?: unknown } | undefined)?.code === "insufficient_host_capacity"
        ) {
          Object.assign(err, {
            hint: "The server this Cube runs on has no room for that size. Try a smaller size, or contact support.",
          });
        }
        throw err;
      }

      if (rt.json) return printJSON({ id, ...result });
      process.stdout.write(`Resize queued for cube ${id} (job ${result.jobId})\n`);
      for (const { key, label, unit } of RESIZE_DIMENSIONS) {
        const from = result.previous[key];
        const to = result.requested[key];
        process.stdout.write(
          `  ${label}: ${from === to ? `${to}${unit} (unchanged)` : `${from}${unit} -> ${to}${unit}`}\n`,
        );
      }
      process.stdout.write(
        result.requiresRestart
          ? "The Cube restarts to apply this change.\n"
          : "Applied live: the Cube does not restart.\n",
      );
      process.stdout.write(`The Cube keeps its current size until the change is applied. Check with: krova cubes get ${id}\n`);
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
  cubes.addCommand(updateCmd());
  cubes.addCommand(renameCmd());
  cubes.addCommand(resizeCmd());
  cubes.addCommand(setProtectionCmd("protect", true, "Protected"));
  cubes.addCommand(setProtectionCmd("unprotect", false, "Unprotected"));
  return cubes;
}

// `list` and `get` are also mounted at the root (parity with the Go CLI).
export const rootListCommand = listCmd;
export const rootGetCommand = getCmd;
