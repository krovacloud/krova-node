import { createRequire } from "node:module";

import { Command } from "commander";

import { printJSON } from "../lib/output.js";
import { getRuntime } from "../lib/runtime.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const CLI_VERSION = pkg.version;

export function versionCommand(): Command {
  return new Command("version")
    .description("print the krova CLI version")
    .action((_opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const info = {
        version: CLI_VERSION,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
      };
      if (rt.json) return printJSON(info);
      process.stdout.write(`krova ${info.version} (node ${info.node}, ${info.platform})\n`);
    });
}
