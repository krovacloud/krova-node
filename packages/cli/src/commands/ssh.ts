import { Command } from "commander";

import { buildSSHArgs, execSSH, resolveSshTarget } from "../lib/ssh.js";

const collect = (v: string, acc: string[]) => {
  acc.push(v);
  return acc;
};

export function sshCommand(): Command {
  return new Command("ssh")
    .argument("<cube>", "cube name or ID")
    .argument("[command...]", "command to run non-interactively (after --)")
    .description("open an SSH session to a Cube (by name or ID)")
    .option("-i, --identity <file>", "SSH identity (private key) file, passed to ssh -i")
    .option("-L, --local-forward <spec>", "local port forward, passed to ssh -L (repeatable)", collect, [])
    .option("-R, --remote-forward <spec>", "remote port forward, passed to ssh -R (repeatable)", collect, [])
    .action(async (cubeRef: string, command: string[], opts, cmd: Command) => {
      const { info, knownHosts } = await resolveSshTarget(cmd, cubeRef);
      const args = buildSSHArgs(info, {
        identity: opts.identity as string | undefined,
        localFwd: opts.localForward as string[],
        remoteFwd: opts.remoteForward as string[],
        knownHosts,
        remoteCmd: command,
      });
      process.exitCode = await execSSH(args);
    });
}
