import { Command } from "commander";

import { displayKey, find } from "../lib/config.js";
import { printJSON, printKeyValue } from "../lib/output.js";
import { getRuntime, probeAuth } from "../lib/runtime.js";

export function whoamiCommand(): Command {
  return new Command("whoami")
    .description("show the current context, space, and base URL")
    .option("--show-secrets", "print the full API key instead of a masked one")
    .action(async (opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const showSecrets = Boolean(opts.showSecrets);
      const ctx = find(rt.cfg, rt.res.contextName);
      let spaceId = rt.res.spaceId;
      let spaceName = ctx?.spaceName ?? "";

      const probe = await probeAuth(rt.res.baseUrl, rt.res.apiKey, rt.timeoutMs);
      if (probe.state === "valid") {
        spaceId = probe.space.id;
        spaceName = probe.space.name ?? spaceName;
      }
      const spaceLive = probe.state === "valid";

      // A rejected key used to render as a bare "Space —", which reads like a
      // missing setting rather than dead credentials. Say so out loud.
      const warning =
        probe.state === "rejected"
          ? `the API rejected this key (HTTP ${probe.status}) — run \`krova login\`. The values below are cached locally and may be stale.`
          : probe.state === "unreachable"
            ? `could not reach ${rt.res.baseUrl} (${probe.error}) — showing locally cached values.`
            : "";

      if (rt.json) {
        return printJSON({
          context: rt.res.contextName,
          spaceId,
          spaceName,
          ...(showSecrets
            ? { apiKey: rt.res.apiKey }
            : { apiKeyMasked: displayKey(rt.res.apiKey, false) }),
          apiKeySource: rt.res.apiKeySource,
          baseUrl: rt.res.baseUrl,
          spaceLive,
          checkState: probe.state,
          warning: warning || undefined,
        });
      }
      printKeyValue([
        ["Context", rt.res.contextName || "—"],
        ["Space", spaceName || "—"],
        ["Space ID", spaceId || "—"],
        ["API key", rt.res.apiKey ? `${displayKey(rt.res.apiKey, showSecrets)} (${rt.res.apiKeySource})` : "—"],
        ["Base URL", rt.res.baseUrl],
      ]);
      if (warning) process.stdout.write(`\n${warning}\n`);
      if (probe.state === "rejected") process.exitCode = 1;
    });
}
