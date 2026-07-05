import { Command } from "commander";

import { configPath, maskKey } from "../lib/config.js";
import { printJSON, printKeyValue } from "../lib/output.js";
import { persistLogin } from "../lib/persist.js";
import { getRuntime } from "../lib/runtime.js";

/** Prompt for an API key. Hidden echo when stdin is a TTY. */
function promptAPIKey(): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write("Krova API key: ");
    const stdin = process.stdin;
    const tty = Boolean(stdin.isTTY);
    let buf = "";
    if (tty) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (fn: () => void) => {
      if (tty) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      fn();
    };
    const onData = (ch: string) => {
      for (const c of ch) {
        const code = c.charCodeAt(0);
        if (code === 10 || code === 13) {
          finish(() => {
            process.stdout.write("\n");
            resolve(buf.trim());
          });
          return;
        }
        if (code === 3) {
          finish(() => reject(new Error("cancelled")));
          return;
        }
        if (code === 127 || code === 8) {
          buf = buf.slice(0, -1);
        } else if (code >= 32) {
          buf += c;
        }
      }
    };
    stdin.on("data", onData);
  });
}

export function authCommand(): Command {
  const auth = new Command("auth").description("manage Krova Cloud credentials");

  auth
    .command("login")
    .description("log in by pasting an API key")
    .option("--api-key <key>", "API key (else you'll be prompted)")
    .option("--space <id>", "Space ID to store with the key")
    .option("--context <name>", "name for the saved context")
    .action(async (opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      let key = (opts.apiKey as string) || rt.flags.apiKey || "";
      if (!key.trim()) key = await promptAPIKey();
      if (!key.trim()) throw new Error("no API key provided");
      const { ctxName, spaceName } = await persistLogin({
        apiKey: key.trim(),
        baseUrl: rt.res.baseUrl,
        spaceId: opts.space as string | undefined,
        ctxName: opts.context as string | undefined,
        timeoutMs: rt.timeoutMs,
      });
      process.stdout.write(`Logged in. Saved context "${ctxName}" to ${configPath()}\n`);
      if (spaceName) process.stdout.write(`Space: ${spaceName}\n`);
    });

  auth
    .command("status")
    .description("show the resolved credentials")
    .action((_opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const authenticated = Boolean(rt.res.apiKey);
      if (rt.json) {
        return printJSON({
          authenticated,
          context: rt.res.contextName,
          apiKeySource: rt.res.apiKeySource,
          apiKeyMasked: maskKey(rt.res.apiKey),
          spaceId: rt.res.spaceId,
          spaceSource: rt.res.spaceIdSource,
          baseUrl: rt.res.baseUrl,
          configPath: configPath(),
        });
      }
      printKeyValue([
        ["Authenticated", authenticated ? "yes" : "no"],
        ["Context", rt.res.contextName || "—"],
        ["API key", rt.res.apiKey ? `${maskKey(rt.res.apiKey)} (${rt.res.apiKeySource})` : "—"],
        ["Space ID", rt.res.spaceId ? `${rt.res.spaceId} (${rt.res.spaceIdSource})` : "—"],
        ["Base URL", rt.res.baseUrl],
        ["Config", configPath()],
      ]);
    });

  return auth;
}
