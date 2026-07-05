import { Command } from "commander";

import { authCommand } from "./commands/auth.js";
import { imagesCommand, pricingCommand, regionsCommand } from "./commands/catalog.js";
import { contextCommand } from "./commands/context.js";
import { cubesCommand, rootGetCommand, rootListCommand } from "./commands/cubes.js";
import { loginCommand } from "./commands/login.js";
import { sshCommand } from "./commands/ssh.js";
import { CLI_VERSION, versionCommand } from "./commands/version.js";
import { webhooksCommand } from "./commands/webhooks.js";
import { whoamiCommand } from "./commands/whoami.js";

/** cobra-style persistent flags: usable on any command, before or after it.
 *  Skips a flag a command already defines locally (e.g. login's own --context). */
function addGlobalOptions(cmd: Command): void {
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
  add("--timeout <duration>", "per-request timeout", "30s");
}

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
program.addCommand(sshCommand());
program.addCommand(rootListCommand()); // `krova list` (alias `ls`)
program.addCommand(rootGetCommand()); // `krova get`
program.addCommand(regionsCommand());
program.addCommand(imagesCommand());
program.addCommand(pricingCommand());
program.addCommand(webhooksCommand());
program.addCommand(versionCommand());

// Apply the global flags to the root and every (sub)command.
const applyAll = (cmd: Command): void => {
  addGlobalOptions(cmd);
  for (const c of cmd.commands) applyAll(c);
};
applyAll(program);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
  }
}

void main();
