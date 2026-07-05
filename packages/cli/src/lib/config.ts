// Reads/writes ~/.config/krova/config.json in the EXACT shape the Go CLI used,
// so existing configs keep working. Multi-context, with legacy single-key
// migration. The file is always tightened to 0600 on save.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "https://krova.cloud/api/v1";
export const DEFAULT_CONTEXT_NAME = "default";

export const ENV = {
  apiKey: "KROVA_API_KEY",
  spaceId: "KROVA_SPACE_ID",
  baseUrl: "KROVA_BASE_URL",
  context: "KROVA_CONTEXT",
} as const;

export interface Context {
  name: string;
  apiKey?: string;
  spaceId?: string;
  spaceName?: string;
  baseUrl?: string;
}

export interface Config {
  currentContext?: string;
  contexts?: Context[];
  // legacy (pre-context) fields — parsed then migrated into a "default" context
  apiKey?: string;
  spaceId?: string;
  baseUrl?: string;
}

export function configDir(): string {
  const xdg = (process.env.XDG_CONFIG_HOME ?? "").trim();
  if (xdg) return join(xdg, "krova");
  return join(homedir(), ".config", "krova");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function load(): Config {
  let cfg: Config = {};
  try {
    cfg = JSON.parse(readFileSync(configPath(), "utf8")) as Config;
  } catch {
    cfg = {};
  }
  return migrate(cfg);
}

// If only legacy fields are set, synthesize a "default" context from them.
function migrate(cfg: Config): Config {
  if ((cfg.apiKey ?? "").trim() && (!cfg.contexts || cfg.contexts.length === 0)) {
    cfg.contexts = [
      {
        name: DEFAULT_CONTEXT_NAME,
        apiKey: cfg.apiKey,
        spaceId: cfg.spaceId,
        baseUrl: cfg.baseUrl,
      },
    ];
    cfg.currentContext = DEFAULT_CONTEXT_NAME;
  }
  cfg.apiKey = undefined;
  cfg.spaceId = undefined;
  cfg.baseUrl = undefined;
  return cfg;
}

export function save(cfg: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // clear legacy fields; only serialize non-empty keys (matches Go omitempty)
  const clean: Config = {};
  if (cfg.currentContext) clean.currentContext = cfg.currentContext;
  if (cfg.contexts && cfg.contexts.length) {
    clean.contexts = cfg.contexts.map((c) => {
      const o: Context = { name: c.name };
      if (c.apiKey) o.apiKey = c.apiKey;
      if (c.spaceId) o.spaceId = c.spaceId;
      if (c.spaceName) o.spaceName = c.spaceName;
      if (c.baseUrl) o.baseUrl = c.baseUrl;
      return o;
    });
  }
  writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies mode on creation — re-tighten an existing file.
  chmodSync(path, 0o600);
}

export function find(cfg: Config, name: string): Context | undefined {
  return (cfg.contexts ?? []).find((c) => c.name === name);
}

/** The active context: `override` (e.g. --context) wins, else currentContext. */
export function current(cfg: Config, override?: string): Context | undefined {
  const name = (override ?? "").trim() || (cfg.currentContext ?? "").trim();
  if (!name) return undefined;
  return find(cfg, name);
}

/** Merge-in a context: only non-empty apiKey/spaceId/spaceName overwrite;
 *  baseUrl is always set. First-ever context becomes current. Returns it. */
export function upsert(cfg: Config, incoming: Context): Context {
  cfg.contexts ??= [];
  let ctx = cfg.contexts.find((c) => c.name === incoming.name);
  if (!ctx) {
    ctx = { name: incoming.name };
    cfg.contexts.push(ctx);
    if (!cfg.currentContext) cfg.currentContext = ctx.name;
  }
  if ((incoming.apiKey ?? "").trim()) ctx.apiKey = incoming.apiKey;
  if ((incoming.spaceId ?? "").trim()) ctx.spaceId = incoming.spaceId;
  if ((incoming.spaceName ?? "").trim()) ctx.spaceName = incoming.spaceName;
  ctx.baseUrl = incoming.baseUrl;
  return ctx;
}

export function remove(cfg: Config, name: string): boolean {
  const before = (cfg.contexts ?? []).length;
  cfg.contexts = (cfg.contexts ?? []).filter((c) => c.name !== name);
  if (cfg.contexts.length === before) return false;
  if (cfg.currentContext === name) {
    cfg.currentContext = cfg.contexts[0]?.name ?? "";
  }
  return true;
}

export type Source = "flag" | "env" | "context" | "";

export interface Resolved {
  apiKey: string;
  spaceId: string;
  baseUrl: string;
  apiKeySource: Source;
  spaceIdSource: Source;
  contextName: string;
}

export interface GlobalFlags {
  apiKey?: string;
  space?: string;
  baseUrl?: string;
  context?: string;
}

/** Resolve credentials with precedence flag > env > active context. */
export function resolve(cfg: Config, flags: GlobalFlags): Resolved {
  const ctx = current(cfg, (flags.context ?? "").trim() || process.env[ENV.context]);
  const pick = (
    flag: string | undefined,
    env: string | undefined,
    ctxVal: string | undefined
  ): [string, Source] => {
    if ((flag ?? "").trim()) return [flag as string, "flag"];
    if ((env ?? "").trim()) return [env as string, "env"];
    if ((ctxVal ?? "").trim()) return [ctxVal as string, "context"];
    return ["", ""];
  };
  const [apiKey, apiKeySource] = pick(flags.apiKey, process.env[ENV.apiKey], ctx?.apiKey);
  const [spaceId, spaceIdSource] = pick(flags.space, process.env[ENV.spaceId], ctx?.spaceId);
  const [baseUrlRaw] = pick(flags.baseUrl, process.env[ENV.baseUrl], ctx?.baseUrl);
  return {
    apiKey,
    spaceId,
    baseUrl: baseUrlRaw || DEFAULT_BASE_URL,
    apiKeySource,
    spaceIdSource,
    contextName: ctx?.name ?? "",
  };
}

export function sanitizeContextName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
