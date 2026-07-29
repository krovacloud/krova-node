import type { Command } from "commander";

import {
  type Config,
  type GlobalFlags,
  type Resolved,
  load,
  resolve,
  save,
  upsert,
} from "./config.js";
import { makeClient, rawRequest } from "./client.js";

/** Parse a Go-style duration ("30s", "500ms", "2m", "1h") to ms. Non-positive
 *  or unparseable floors to 30s (matches the Go requestTimeout behavior). */
export function parseDuration(input: string | undefined): number {
  const s = (input ?? "").trim();
  if (!s) return 30_000;
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let m: RegExpExecArray | null = re.exec(s);
  let matched = false;
  while (m) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    total += unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
    m = re.exec(s);
  }
  if (!matched) {
    const n = Number(s);
    if (Number.isFinite(n)) total = n * 1000; // bare number = seconds
  }
  return total > 0 ? total : 30_000;
}

export interface Runtime {
  flags: GlobalFlags;
  cfg: Config;
  res: Resolved;
  json: boolean;
  timeoutMs: number;
}

export function getRuntime(cmd: Command): Runtime {
  const opts = cmd.optsWithGlobals() as Record<string, unknown>;
  const flags: GlobalFlags = {
    apiKey: opts.apiKey as string | undefined,
    space: opts.space as string | undefined,
    baseUrl: opts.baseUrl as string | undefined,
    context: opts.context as string | undefined,
  };
  const cfg = load();
  const res = resolve(cfg, flags);
  return {
    flags,
    cfg,
    res,
    json: Boolean(opts.json),
    timeoutMs: parseDuration(opts.timeout as string | undefined),
  };
}

export interface SpaceInfo {
  id: string;
  name?: string;
  slug?: string;
}

/**
 * The outcome of actually asking the server whether a key works.
 *
 * A stored key is NOT a working key: it can be revoked server-side at any
 * time, and the local config has no way to know. Every caller that wants to
 * report on credentials must distinguish "rejected" from "couldn't reach the
 * server" — collapsing either into a plain boolean is what made `auth status`
 * print "Authenticated: yes" for a key the API answers 401 to.
 */
export type AuthProbe =
  /** The server accepted the key and told us which space it belongs to. */
  | { state: "valid"; space: SpaceInfo }
  /** The key is absent locally — nothing to check. */
  | { state: "missing" }
  /** The server actively rejected the key (revoked, deleted, wrong env). */
  | { state: "rejected"; status: number }
  /** Endpoint absent (older server) — the key may still be fine. */
  | { state: "unsupported" }
  /** Network/DNS/timeout — says nothing about the key's validity. */
  | { state: "unreachable"; error: string };

/** Ask the server whether `apiKey` is actually accepted. Never throws. */
export async function probeAuth(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number
): Promise<AuthProbe> {
  if (!apiKey) return { state: "missing" };
  try {
    const { status, data } = await rawRequest<SpaceInfo>({
      method: "GET",
      baseUrl,
      path: "/space",
      apiKey,
      timeoutMs,
    });
    if (status === 200 && data?.id) return { state: "valid", space: data };
    if (status === 401 || status === 403) return { state: "rejected", status };
    if (status === 404) return { state: "unsupported" };
    return { state: "unreachable", error: `HTTP ${status}` };
  } catch (err) {
    return {
      state: "unreachable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** GET /space with the given key; null on 404 / error (non-fatal). Thin
 *  wrapper over `probeAuth` for callers that only need the space. */
export async function fetchSpace(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number
): Promise<SpaceInfo | null> {
  const probe = await probeAuth(baseUrl, apiKey, timeoutMs);
  return probe.state === "valid" ? probe.space : null;
}

/** Resolve the active space id: explicit value wins, else auto-detect via
 *  GET /space (and cache it into the current context). */
export async function resolveSpace(rt: Runtime): Promise<string> {
  if (rt.res.spaceId) return rt.res.spaceId;
  const { status, data } = await rawRequest<SpaceInfo>({
    method: "GET",
    baseUrl: rt.res.baseUrl,
    path: "/space",
    apiKey: rt.res.apiKey,
    timeoutMs: rt.timeoutMs,
  });
  if (status === 200 && data?.id) {
    // Best-effort cache of the resolved space into the current named context.
    // Deliberately does NOT write baseUrl: rt.res.baseUrl already folds in a
    // one-off --base-url / KROVA_BASE_URL override, and persisting that here
    // would permanently rewrite the context's real base URL from a transient
    // flag. Only the space id/name are cached.
    if (rt.res.contextName) {
      upsert(rt.cfg, {
        name: rt.res.contextName,
        spaceId: data.id,
        spaceName: data.name,
      });
      try {
        save(rt.cfg);
      } catch {
        /* non-fatal */
      }
    }
    return data.id;
  }
  if (status === 404) {
    throw new Error(
      "couldn't auto-detect your space (the server doesn't support it yet) — pass --space, set KROVA_SPACE_ID, or run `krova login`"
    );
  }
  if (status === 401 || status === 403) {
    throw new Error(`auto-detect space failed: the API key was rejected (HTTP ${status})`);
  }
  throw new Error(`auto-detect space failed (HTTP ${status})`);
}

export { makeClient };
