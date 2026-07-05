import { Command } from "commander";

import { load, maskKey, remove, save } from "../lib/config.js";
import { printJSON, printKeyValue, printTable } from "../lib/output.js";
import { getRuntime } from "../lib/runtime.js";

export function contextCommand(): Command {
  const ctx = new Command("context")
    .aliases(["ctx", "contexts"])
    .description("manage named credential contexts (like kubectl/aws profiles)");

  ctx
    .command("list")
    .aliases(["ls"])
    .description("list all contexts")
    .action((_opts, cmd: Command) => {
      const { json } = getRuntime(cmd);
      const cfg = load();
      if (json) {
        return printJSON({
          currentContext: cfg.currentContext ?? "",
          contexts: (cfg.contexts ?? []).map((c) => ({
            name: c.name,
            apiKey: maskKey(c.apiKey ?? ""),
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
      const c = (cfg.contexts ?? []).find((x) => x.name === oldName);
      if (!c) throw new Error(`no context named "${oldName}"`);
      if ((cfg.contexts ?? []).some((x) => x.name === newName)) {
        throw new Error(`a context named "${newName}" already exists`);
      }
      c.name = newName;
      if (cfg.currentContext === oldName) cfg.currentContext = newName;
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

export function whoamiKeyValue(pairs: Array<[string, string]>): void {
  printKeyValue(pairs);
}
