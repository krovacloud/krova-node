import { Command } from "commander";

import { rawRequest } from "../lib/client.js";
import { resolveCube } from "../lib/resolve.js";
import { getRuntime, makeClient, resolveSpace } from "../lib/runtime.js";
import {
  type SshInfo,
  buildSSHArgs,
  execSSH,
  validateSSHHost,
  validateSSHUser,
  writeKnownHosts,
} from "../lib/ssh.js";

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
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const space = await resolveSpace(rt);
      const id = await resolveCube(client, space, cubeRef);

      const { status, data } = await rawRequest<SshInfo>({
        method: "GET",
        baseUrl: rt.res.baseUrl,
        path: `/spaces/${space}/cubes/${id}/ssh`,
        apiKey: rt.res.apiKey,
        timeoutMs: rt.timeoutMs,
      });
      if (status === 404) {
        throw new Error(
          `SSH info isn't available on this server yet — try \`krova cubes get ${cubeRef}\` for the Cube's IP and ssh manually`
        );
      }
      if (status === 401 || status === 403) {
        throw new Error(`SSH info request was rejected (HTTP ${status})`);
      }
      if (status !== 200 || !data?.host) {
        throw new Error(`couldn't fetch SSH info (HTTP ${status})`);
      }

      const info: SshInfo = {
        host: data.host,
        port: data.port ?? 0,
        user: data.user ?? "",
        hostKeys: data.hostKeys ?? [],
      };
      validateSSHHost(info.host);
      validateSSHUser(info.user);
      if (info.port < 0 || info.port > 65535) throw new Error("invalid ssh port");

      let knownHosts = "";
      if (info.hostKeys.length) {
        knownHosts = writeKnownHosts(info);
      } else {
        process.stderr.write(
          "note: this server didn't provide host keys — using ssh trust-on-first-use (host-key checking stays on).\n"
        );
      }

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
