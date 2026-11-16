import { Command } from "commander";

import { resolveSshTarget } from "../lib/ssh.js";
import {
  LOOPBACK,
  buildTunnelArgs,
  findOnPath,
  freeLoopbackPort,
  parsePort,
  runClientThroughTunnel,
} from "../lib/tunnel.js";

const PRIVATE_NOTE =
  "It uses a private SSH tunnel on a free local port, so the database never needs a public `krova tcp add` mapping. Passwords are never read from flags: the client prompts for one itself.";

/** A user or database name: no leading `-`, nothing a client could read as a
 *  connection string (`=`, `:`, `/`, spaces). */
const IDENT = /^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,62}$/;

export function validateIdent(value: string, label: string): string {
  if (!IDENT.test(value)) {
    throw new Error(
      `${label} may only use letters, digits, '_', '.', '$' and '-', and must not start with '-'`
    );
  }
  return value;
}

export interface DbClientSpec {
  command: string;
  client: string;
  defaultPort: number;
  description: string;
  userDefault?: string;
  dbDefault?: string;
  clientArgs(o: { port: number; user?: string; db?: string }): string[];
}

export const DB_CLIENTS: DbClientSpec[] = [
  {
    command: "psql",
    client: "psql",
    defaultPort: 5432,
    userDefault: "postgres",
    dbDefault: "postgres",
    description: "open psql against a PostgreSQL server in a Cube",
    clientArgs: ({ port, user, db }) => [
      "-h",
      LOOPBACK,
      "-p",
      String(port),
      "-U",
      user as string,
      "-d",
      db as string,
    ],
  },
  {
    command: "redis",
    client: "redis-cli",
    defaultPort: 6379,
    description: "open redis-cli against a Redis server in a Cube",
    clientArgs: ({ port }) => ["-h", LOOPBACK, "-p", String(port)],
  },
  {
    command: "mysql",
    client: "mysql",
    defaultPort: 3306,
    userDefault: "root",
    description: "open mysql against a MySQL or MariaDB server in a Cube",
    clientArgs: ({ port, user, db }) => [
      "-h",
      LOOPBACK,
      "-P",
      String(port),
      "--protocol=tcp",
      "-u",
      user as string,
      ...(db ? [`--database=${db}`] : []),
    ],
  },
];

function dbClientCommand(spec: DbClientSpec): Command {
  const c = new Command(spec.command)
    .argument("<cube>", "cube name or ID")
    .description(`${spec.description}. ${PRIVATE_NOTE}`)
    .option("--port <cubePort>", `port inside the Cube (default ${spec.defaultPort})`)
    .option("-i, --identity <file>", "SSH identity (private key) file, passed to ssh -i");
  if (spec.userDefault) {
    c.option("--user <user>", `database user (default ${spec.userDefault})`, spec.userDefault);
  }
  if (spec.command === "psql") c.option("--db <name>", "database name (default postgres)", "postgres");
  if (spec.command === "mysql") c.option("--db <name>", "database to use");
  return c.action(async (cubeRef: string, opts, cmd: Command) => {
    // Check everything that needs no network first, so a typo or a missing
    // client fails before any tunnel is opened.
    const cubePort =
      opts.port !== undefined ? parsePort(opts.port as string, "--port") : spec.defaultPort;
    const user = spec.userDefault ? validateIdent(opts.user as string, "--user") : undefined;
    const db = opts.db ? validateIdent(opts.db as string, "--db") : undefined;
    if (!findOnPath(spec.client)) {
      throw new Error(`\`${spec.client}\` was not found on your PATH — install it and try again`);
    }

    const { info, knownHosts } = await resolveSshTarget(cmd, cubeRef);
    const localPort = await freeLoopbackPort();
    const sshArgs = buildTunnelArgs(info, {
      identity: opts.identity as string | undefined,
      knownHosts,
      localPort,
      cubePort,
    });
    process.exitCode = await runClientThroughTunnel({
      sshArgs,
      localPort,
      client: spec.client,
      clientArgs: spec.clientArgs({ port: localPort, user, db }),
    });
  });
}

export const psqlCommand = () => dbClientCommand(DB_CLIENTS[0] as DbClientSpec);
export const redisCommand = () => dbClientCommand(DB_CLIENTS[1] as DbClientSpec);
export const mysqlCommand = () => dbClientCommand(DB_CLIENTS[2] as DbClientSpec);
