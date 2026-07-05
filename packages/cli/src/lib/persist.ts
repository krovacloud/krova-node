import { DEFAULT_CONTEXT_NAME, load, sanitizeContextName, save, upsert } from "./config.js";
import { fetchSpace } from "./runtime.js";

/** Save + switch to a context after a login. Best-effort space lookup fills in
 *  spaceId/spaceName and a nicer context name. Mirrors the Go persistLogin. */
export async function persistLogin(input: {
  apiKey: string;
  baseUrl: string;
  spaceId?: string;
  ctxName?: string;
  timeoutMs: number;
}): Promise<{ ctxName: string; spaceName: string }> {
  const cfg = load();
  let spaceId = input.spaceId ?? "";
  let spaceName = "";
  let derivedName = "";

  const sp = await fetchSpace(input.baseUrl, input.apiKey, input.timeoutMs);
  if (sp) {
    spaceId = sp.id;
    spaceName = sp.name ?? "";
    derivedName = (sp.slug || sp.name || "").trim();
  }

  let name = (input.ctxName ?? "").trim();
  if (!name) name = derivedName || DEFAULT_CONTEXT_NAME;
  name = sanitizeContextName(name);

  const cur = upsert(cfg, {
    name,
    apiKey: input.apiKey,
    spaceId,
    spaceName,
    baseUrl: input.baseUrl,
  });
  cfg.currentContext = cur.name; // login always switches current
  save(cfg);
  return { ctxName: cur.name, spaceName: cur.spaceName ?? "" };
}
