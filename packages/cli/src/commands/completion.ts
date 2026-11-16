import { Argument, Command } from "commander";

import {
  COMPLETION_INSTALL_HELP,
  COMPLETION_SHELLS,
  type CompletionShell,
  generateCompletion,
} from "../lib/completion.js";

export function completionCommand(): Command {
  return new Command("completion")
    .description("print a shell completion script (bash, zsh or fish)")
    .addArgument(new Argument("<shell>", "target shell").choices(COMPLETION_SHELLS))
    .addHelpText("after", COMPLETION_INSTALL_HELP)
    .action((shell: CompletionShell, _opts, cmd: Command) => {
      let root = cmd;
      while (root.parent) root = root.parent;
      process.stdout.write(generateCompletion(shell, root));
    });
}
