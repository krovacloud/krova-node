import { Command } from "commander";

import { printJSON } from "../lib/output.js";
import { resolveSshTarget } from "../lib/ssh.js";
import {
  LOOPBACK,
  buildTunnelArgs,
  freeLoopbackPort,
  holdTunnel,
  parsePort,
  parseTunnelSpec,
} from "../lib/tunnel.js";

const PRIVATE_NOTE =
  "The port is reachable only from this machine, over your SSH key. Prefer it to a public `krova tcp add` mapping for databases.";

export function tunnelCommand(): Command {
  return new Command("tunnel")
    .argument("<cube>", "cube name or ID")
    .argument("<ports>", "[localPort:]cubePort (the local port defaults to the Cube port)")
    .description(
      `forward a local port to a port inside a Cube over SSH. ${PRIVATE_NOTE}`
    )
    .option("-i, --identity <file>", "SSH identity (private key) file, passed to ssh -i")
    .action(async (cubeRef: string, spec: string, opts, cmd: Command) => {
      const { localPort, cubePort } = parseTunnelSpec(spec);
      const { info, knownHosts } = await resolveSshTarget(cmd, cubeRef, { requireHostKeys: true });
      const args = buildTunnelArgs(info, {
        identity: opts.identity as string | undefined,
        knownHosts,
        localPort,
        cubePort,
      });
      process.stderr.write(
        `Forwarding localhost:${localPort} -> ${cubeRef}:${cubePort}. Press Ctrl+C to stop.\n`
      );
      process.exitCode = await holdTunnel(args);
    });
}

export function connectCommand(): Command {
  return new Command("connect")
    .argument("<cube>", "cube name or ID")
    .description(
      `open a private tunnel to a Cube port on a free local port and print the local endpoint. ${PRIVATE_NOTE}`
    )
    .requiredOption("--port <cubePort>", "port inside the Cube to reach")
    .option("--local-port <port>", "local port to listen on (default: a free one)")
    .option("-i, --identity <file>", "SSH identity (private key) file, passed to ssh -i")
    .action(async (cubeRef: string, opts, cmd: Command) => {
      const cubePort = parsePort(opts.port as string, "--port");
      const localPort =
        opts.localPort !== undefined
          ? parsePort(opts.localPort as string, "--local-port")
          : await freeLoopbackPort();
      const json = Boolean(cmd.optsWithGlobals().json);
      const { info, knownHosts } = await resolveSshTarget(cmd, cubeRef, { requireHostKeys: true });
      const args = buildTunnelArgs(info, {
        identity: opts.identity as string | undefined,
        knownHosts,
        localPort,
        cubePort,
      });
      process.exitCode = await holdTunnel(args, {
        readyPort: localPort,
        onReady: () => {
          if (json) {
            printJSON({ host: LOOPBACK, port: localPort, cube: cubeRef, cubePort });
          } else {
            process.stdout.write(`localhost:${localPort}\n`);
          }
          process.stderr.write(
            `Forwarding localhost:${localPort} -> ${cubeRef}:${cubePort}. Press Ctrl+C to stop.\n`
          );
        },
      });
    });
}
