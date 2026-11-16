import { Command } from "commander";

import { displayKey, find } from "../lib/config.js";
import { printJSON, printKeyValue } from "../lib/output.js";
import { getRuntime, probeAuth } from "../lib/runtime.js";

/** "never", or the ISO date with how far away it is, e.g. `2026-12-16T12:00:00.000Z (in 30 days)`. */
export function describeExpiry(expiresAt: string | null, now: number = Date.now()): string {
  if (expiresAt === null) return "never";
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return expiresAt;
  const days = Math.floor((at - now) / 86_400_000);
  if (days < 0) return `${expiresAt} (expired)`;
  if (days === 0) return `${expiresAt} (within a day)`;
  return `${expiresAt} (in ${days} ${days === 1 ? "day" : "days"})`;
}

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
      // `undefined` when unknown: the key was not checked, the key came from an
      // OAuth token (the API sends `apiKey: null`), or an older server omits it.
      const keyInfo = probe.state === "valid" ? probe.space.apiKey : undefined;
      const expiresAt = keyInfo ? keyInfo.expiresAt : undefined;

      // A rejected key used to render as a bare "Space —", which reads like a
      // missing setting rather than dead credentials. Say so out loud.
      const warning =
        probe.state === "rejected"
          ? `the API rejected this key (HTTP ${probe.status}): it is invalid, revoked or expired. Run \`krova login\`. The values below are cached locally and may be stale.`
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
          ...(expiresAt !== undefined ? { apiKeyExpiresAt: expiresAt } : {}),
          apiKeySource: rt.res.apiKeySource,
          apiKeyStorage: rt.res.apiKeyStorage || undefined,
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
        [
          "API key",
          rt.res.apiKey
            ? `${displayKey(rt.res.apiKey, showSecrets)} (${rt.res.apiKeySource}${rt.res.apiKeyStorage ? `, ${rt.res.apiKeyStorage}` : ""})`
            : "—",
        ],
        ...(expiresAt !== undefined
          ? [["Key expires", describeExpiry(expiresAt)] as [string, string]]
          : []),
        ["Base URL", rt.res.baseUrl],
      ]);
      if (warning) process.stdout.write(`\n${warning}\n`);
      if (probe.state === "rejected") process.exitCode = 1;
    });
}
