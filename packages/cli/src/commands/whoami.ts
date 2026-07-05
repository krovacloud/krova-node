import { Command } from "commander";

import { find, maskKey } from "../lib/config.js";
import { printJSON, printKeyValue } from "../lib/output.js";
import { fetchSpace, getRuntime } from "../lib/runtime.js";

export function whoamiCommand(): Command {
  return new Command("whoami")
    .description("show the current context, space, and base URL")
    .action(async (_opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const ctx = find(rt.cfg, rt.res.contextName);
      let spaceId = rt.res.spaceId;
      let spaceName = ctx?.spaceName ?? "";
      let spaceLive = false;

      if (rt.res.apiKey) {
        const sp = await fetchSpace(rt.res.baseUrl, rt.res.apiKey, rt.timeoutMs);
        if (sp) {
          spaceId = sp.id;
          spaceName = sp.name ?? spaceName;
          spaceLive = true;
        }
      }

      if (rt.json) {
        return printJSON({
          context: rt.res.contextName,
          spaceId,
          spaceName,
          apiKeyMasked: maskKey(rt.res.apiKey),
          apiKeySource: rt.res.apiKeySource,
          baseUrl: rt.res.baseUrl,
          spaceLive,
        });
      }
      printKeyValue([
        ["Context", rt.res.contextName || "—"],
        ["Space", spaceName || "—"],
        ["Space ID", spaceId || "—"],
        ["API key", rt.res.apiKey ? `${maskKey(rt.res.apiKey)} (${rt.res.apiKeySource})` : "—"],
        ["Base URL", rt.res.baseUrl],
      ]);
    });
}
