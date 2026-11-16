import { Command } from "commander";

import { contextKey, displayKey, load, remove, renameContext, save, storageOf } from "../lib/config.js";
import { printJSON, printTable } from "../lib/output.js";
import { getRuntime } from "../lib/runtime.js";

export function contextCommand(): Command {
  const ctx = new Command("context")
    .aliases(["ctx", "contexts"])
    .description("manage named credential contexts (like kubectl/aws profiles)");

  ctx
    .command("list")
    .aliases(["ls"])
    .description("list all contexts")
    .option("--show-secrets", "print full API keys instead of masked ones (JSON output only; the table has no key column)")
    .action((opts, cmd: Command) => {
      const { json } = getRuntime(cmd);
      const cfg = load();
      if (json) {
        return printJSON({
          currentContext: cfg.currentContext ?? "",
          contexts: (cfg.contexts ?? []).map((c) => ({
            name: c.name,
            apiKey: displayKey(contextKey(c), Boolean(opts.showSecrets)),
            keyStorage: storageOf(c),
            spaceId: c.spaceId ?? "",
            spaceName: c.spaceName ?? "",
            baseUrl: c.baseUrl ?? "",
          })),
        });
      }
      printTable(
        ["CURRENT", "NAME", "SPACE", "SPACE ID", "BASE URL"],
        (cfg.contexts ?? []).map((c) => [
          c.name === cfg.currentContext ? "*" : "",
          c.name,
          c.spaceName ?? "",
          c.spaceId ?? "",
          c.baseUrl ?? "",
        ])
      );
    });

  ctx
    .command("current")
    .description("print the current context name")
    .action(() => {
      const cfg = load();
      if (!cfg.currentContext) throw new Error("no current context set");
      process.stdout.write(`${cfg.currentContext}\n`);
    });

  ctx
    .command("use")
    .argument("<name>", "context name")
    .description("switch the current context")
    .action((name: string) => {
      const cfg = load();
      if (!(cfg.contexts ?? []).some((c) => c.name === name)) {
        throw new Error(`no context named "${name}"`);
      }
      cfg.currentContext = name;
      save(cfg);
      process.stdout.write(`Switched to context ${name}\n`);
    });

  ctx
    .command("rename")
    .argument("<old>", "current name")
    .argument("<new>", "new name")
    .description("rename a context")
    .action((oldName: string, newName: string) => {
      const cfg = load();
      if (!newName.trim()) throw new Error("new name must not be empty");
      // Moves the keychain item too, so the key follows the context name.
      renameContext(cfg, oldName, newName);
      save(cfg);
      process.stdout.write(`Renamed ${oldName} → ${newName}\n`);
    });

  ctx
    .command("delete")
    .aliases(["rm"])
    .argument("<name>", "context name")
    .description("delete a context")
    .action((name: string) => {
      const cfg = load();
      if (!remove(cfg, name)) throw new Error(`no context named "${name}"`);
      save(cfg);
      process.stdout.write(`Deleted context ${name}\n`);
    });

  return ctx;
}
