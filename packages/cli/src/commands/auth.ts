import { Command } from "commander";

import { configPath, maskKey } from "../lib/config.js";
import { printJSON, printKeyValue } from "../lib/output.js";
import { persistLogin } from "../lib/persist.js";
import { getRuntime, probeAuth } from "../lib/runtime.js";

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
    .description("show the resolved credentials and verify them against the API")
    .option("--offline", "skip the live check; only report what's stored locally")
    .action(async (opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const offline = Boolean(opts.offline);

      // A STORED key is not a WORKING key — it can be revoked server-side at
      // any time. Reporting local presence as "Authenticated: yes" sends the
      // user hunting for a config problem that isn't there, so unless they ask
      // for --offline we go and ask the API.
      const probe = offline
        ? ({ state: "missing" } as const)
        : await probeAuth(rt.res.baseUrl, rt.res.apiKey, rt.timeoutMs);

      const hasKey = Boolean(rt.res.apiKey);
      const authenticated = offline ? hasKey : probe.state === "valid";

      const detail =
        offline || !hasKey
          ? ""
          : probe.state === "rejected"
            ? `the API rejected this key (HTTP ${probe.status}) — it was revoked or belongs to another environment; run \`krova login\``
            : probe.state === "unreachable"
              ? `could not reach ${rt.res.baseUrl} (${probe.error}) — the key was NOT verified`
              : probe.state === "unsupported"
                ? "this server has no /space endpoint, so the key could not be verified"
                : "";

      // Live space beats the cached copy: a stale spaceId in the config is
      // exactly the kind of drift this command exists to surface.
      const spaceId = probe.state === "valid" ? probe.space.id : rt.res.spaceId;

      if (rt.json) {
        return printJSON({
          authenticated,
          verified: probe.state === "valid",
          checkState: offline ? "skipped" : probe.state,
          detail: detail || undefined,
          context: rt.res.contextName,
          apiKeySource: rt.res.apiKeySource,
          apiKeyMasked: maskKey(rt.res.apiKey),
          spaceId,
          spaceSource: rt.res.spaceIdSource,
          baseUrl: rt.res.baseUrl,
          configPath: configPath(),
        });
      }

      const label = !hasKey
        ? "no (no API key found)"
        : offline
          ? "not checked (--offline; a key is stored)"
          : probe.state === "valid"
            ? "yes (verified against the API)"
            : probe.state === "rejected"
              ? "NO — key rejected by the API"
              : "unknown (could not verify)";

      printKeyValue([
        ["Authenticated", label],
        ["Context", rt.res.contextName || "—"],
        ["API key", rt.res.apiKey ? `${maskKey(rt.res.apiKey)} (${rt.res.apiKeySource})` : "—"],
        ["Space ID", spaceId ? `${spaceId} (${rt.res.spaceIdSource})` : "—"],
        ["Base URL", rt.res.baseUrl],
        ["Config", configPath()],
      ]);
      if (detail) process.stdout.write(`\n${detail}\n`);

      // Exit non-zero only when the credentials are KNOWN to be unusable, so
      // scripts and CI can gate on `krova auth status` (matches
      // `gh auth status`). An unreachable or too-old API says nothing about
      // the key, so those stay 0 rather than failing a build over a blip.
      if (!hasKey || probe.state === "rejected") process.exitCode = 1;
    });

  return auth;
}
