import { Command } from "commander";

import {
  buildSCPArgs,
  buildSSHArgs,
  execInherit,
  parseCpOperands,
  resolveSshTarget,
} from "../lib/ssh.js";

export function execCommand(): Command {
  return new Command("exec")
    .argument("<cube>", "cube name or ID")
    .argument("<command...>", "command to run (after --)")
    .description(
      "run a command on a Cube over SSH without a terminal, and exit with its exit code. The words after -- are joined with spaces and run by the remote shell, like ssh."
    )
    .option("-i, --identity <file>", "SSH identity (private key) file, passed to ssh -i")
    .action(async (cubeRef: string, command: string[], opts, cmd: Command) => {
      if (!command.some((w) => w.trim())) {
        throw new Error("exec needs a command to run, e.g. krova exec <cube> -- uname -a");
      }
      const { info, knownHosts } = await resolveSshTarget(cmd, cubeRef);
      const args = buildSSHArgs(info, {
        preArgs: ["-T"],
        identity: opts.identity as string | undefined,
        knownHosts,
        remoteCmd: command,
      });
      process.exitCode = await execInherit("ssh", args);
    });
}

export function cpCommand(): Command {
  return new Command("cp")
    .argument("<src>", "source: a local path or <cube>:<path>")
    .argument("<dst>", "destination: a local path or <cube>:<path>")
    .description(
      "copy files between this machine and a Cube over scp. Exactly one side is <cube>:<path> (cube by name or ID)."
    )
    .option("-r, --recursive", "copy directories recursively")
    .option("-i, --identity <file>", "SSH identity (private key) file, passed to scp -i")
    .action(async (src: string, dst: string, opts, cmd: Command) => {
      const operands = parseCpOperands(src, dst);
      const { info, knownHosts } = await resolveSshTarget(cmd, operands.cube);
      const args = buildSCPArgs(info, {
        knownHosts,
        identity: opts.identity as string | undefined,
        recursive: Boolean(opts.recursive),
        operands,
      });
      process.exitCode = await execInherit("scp", args);
    });
}
