import { Command } from "commander";

import { authCommand } from "./commands/auth.js";
import { backupsCommand } from "./commands/backups.js";
import { imagesCommand, pricingCommand, regionsCommand } from "./commands/catalog.js";
import { completionCommand } from "./commands/completion.js";
import { contextCommand } from "./commands/context.js";
import { cubesCommand, rootGetCommand, rootListCommand } from "./commands/cubes.js";
import { domainsCommand } from "./commands/domains.js";
import { loginCommand } from "./commands/login.js";
import { snapshotsCommand } from "./commands/snapshots.js";
import { mysqlCommand, psqlCommand, redisCommand } from "./commands/dbclients.js";
import { cpCommand, execCommand } from "./commands/exec.js";
import { sshCommand } from "./commands/ssh.js";
import { connectCommand, tunnelCommand } from "./commands/tunnel.js";
import { tcpCommand } from "./commands/tcp.js";
import { updateCommand } from "./commands/update.js";
import { CLI_VERSION, versionCommand } from "./commands/version.js";
import { webhooksCommand } from "./commands/webhooks.js";
import { whoamiCommand } from "./commands/whoami.js";
import { DEFAULT_BASE_URL, ENV, load, resolve } from "./lib/config.js";
import { errorHint } from "./lib/hints.js";
import { parseOutputFormat } from "./lib/output-format.js";
import { exitQuietlyOnBrokenPipe } from "./lib/output.js";
import { activeRuntime } from "./lib/runtime.js";

exitQuietlyOnBrokenPipe();

const program = new Command();
program
  .name("krova")
  .description(
    "krova is the command-line interface for Krova Cloud — manage Cubes (Firecracker microVMs), browse the catalog, and receive webhooks."
  )
  .version(CLI_VERSION, "-v, --version", "print the krova CLI version")
  .showHelpAfterError();

program.addCommand(loginCommand());
program.addCommand(authCommand());
program.addCommand(contextCommand());
program.addCommand(whoamiCommand());
program.addCommand(cubesCommand());
program.addCommand(domainsCommand());
program.addCommand(snapshotsCommand());
program.addCommand(backupsCommand());
program.addCommand(tcpCommand());
program.addCommand(sshCommand());
program.addCommand(tunnelCommand());
program.addCommand(connectCommand());
program.addCommand(psqlCommand());
program.addCommand(redisCommand());
program.addCommand(mysqlCommand());
program.addCommand(execCommand());
program.addCommand(cpCommand());
program.addCommand(rootListCommand()); // `krova list` (alias `ls`)
program.addCommand(rootGetCommand()); // `krova get`
program.addCommand(regionsCommand());
program.addCommand(imagesCommand());
program.addCommand(pricingCommand());
program.addCommand(webhooksCommand());
program.addCommand(versionCommand());
program.addCommand(updateCommand());
program.addCommand(completionCommand());

// cobra-style persistent flags: usable on any command, before or after it.
// Skips a flag a command already defines locally (e.g. login's own --context).
const applyGlobals = (cmd: Command): void => {
  const have = new Set(cmd.options.map((o) => o.long));
  const add = (flags: string, desc: string, def?: string) => {
    const long = flags.split(/[ ,<[]/).find((f) => f.startsWith("--"));
    if (long && !have.has(long)) cmd.option(flags, desc, def);
  };
  add("--api-key <key>", "Krova Cloud API key (overrides env and context)");
  add("--space <id>", "Space ID (overrides KROVA_SPACE_ID and context)");
  add("--base-url <url>", "override the API base URL");
  add("--context <name>", "use a named context (overrides KROVA_CONTEXT)");
  add("--json", "output machine-readable JSON instead of a table");
  add("-o, --output <format>", "output format: table (default) or json; -o json is the same as --json");
  add("--timeout <duration>", "per-request timeout", "30s");
  for (const c of cmd.commands) applyGlobals(c);
};
applyGlobals(program);

// Reject a bad `-o` before any command runs, with a one-line error.
program.hook("preAction", (_root, actionCmd) => {
  parseOutputFormat((actionCmd.optsWithGlobals() as { output?: unknown }).output);
});

/** The base URL for a connection hint: the one the failing command resolved,
 *  else what the environment and saved context would give. */
function hintBaseUrl(): string {
  const active = activeRuntime();
  if (active) return active.baseUrl;
  try {
    return resolve(load(), {}).baseUrl;
  } catch {
    return process.env[ENV.baseUrl] || DEFAULT_BASE_URL;
  }
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    // One actionable line under the error. Not in JSON mode: errors there stay
    // exactly as they were (plain text on stderr), so a script's parsing is unchanged.
    if (!activeRuntime()?.json) {
      const hint = errorHint(err, hintBaseUrl());
      if (hint) process.stderr.write(`${hint}\n`);
    }
    process.exitCode = 1;
  }
}

void main();
