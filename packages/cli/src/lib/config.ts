// Reads/writes ~/.config/krova/config.json in the EXACT shape the Go CLI used,
// so existing configs keep working. Multi-context, with legacy single-key
// migration. The file is always tightened to 0600 on save. API keys live in the
// OS keychain when one is available (see keychain.ts) and in this file otherwise.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  KeychainUnavailableError,
  KEYCHAIN_SERVICE,
  readBackend,
  writeBackend,
} from "./keychain.js";

export const DEFAULT_BASE_URL = "https://krova.cloud/api/v1";
export const DEFAULT_CONTEXT_NAME = "default";

export const ENV = {
  apiKey: "KROVA_API_KEY",
  spaceId: "KROVA_SPACE_ID",
  baseUrl: "KROVA_BASE_URL",
  context: "KROVA_CONTEXT",
} as const;

/** Where a context's API key lives. A context with no `keyStorage` is a file context. */
export type KeyStorage = "keychain" | "file";

export interface Context {
  name: string;
  apiKey?: string;
  keyStorage?: KeyStorage;
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
      // A keychain context never writes its key to the file.
      if (c.apiKey && c.keyStorage !== "keychain") o.apiKey = c.apiKey;
      if (c.keyStorage) o.keyStorage = c.keyStorage;
      if (c.spaceId) o.spaceId = c.spaceId;
      if (c.spaceName) o.spaceName = c.spaceName;
      if (c.baseUrl) o.baseUrl = c.baseUrl;
      return o;
    });
  }
  // Atomic: write a 0600 temp file in the same directory, then rename over the config, so a
  // crash or full disk never leaves a half-written file (and the key is never briefly world-readable).
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw e;
  }
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

/** Merge-in a context: only NON-EMPTY apiKey/spaceId/spaceName/baseUrl
 *  overwrite an existing value. This keeps a transient per-command override
 *  (e.g. a one-off `--base-url`) from being silently persisted over the
 *  context's real base URL. First-ever context becomes current. Returns it. */
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
  if ((incoming.baseUrl ?? "").trim()) ctx.baseUrl = incoming.baseUrl;
  return ctx;
}

/** Drop a context from `cfg` in memory only (the caller still calls `save`). Does not touch the
 *  keychain: use `removeContext` to remove a context and its keychain item together. */
export function remove(cfg: Config, name: string): boolean {
  const before = (cfg.contexts ?? []).length;
  cfg.contexts = (cfg.contexts ?? []).filter((c) => c.name !== name);
  if (cfg.contexts.length === before) return false;
  if (cfg.currentContext === name) {
    cfg.currentContext = cfg.contexts[0]?.name ?? "";
  }
  return true;
}

/** Remove a context, save the config, and only then delete its keychain item, so a failed save
 *  leaves both the context and its key intact. Returns false when there is no such context. */
export function removeContext(cfg: Config, name: string, persist: () => void = () => save(cfg)): boolean {
  const gone = find(cfg, name);
  if (!gone) return false;
  const snapshot = { contexts: [...(cfg.contexts ?? [])], currentContext: cfg.currentContext };
  remove(cfg, name);
  try {
    persist();
  } catch (e) {
    cfg.contexts = snapshot.contexts;
    cfg.currentContext = snapshot.currentContext;
    throw e;
  }
  deleteContextKey(gone);
  return true;
}

export type Source = "flag" | "env" | "context" | "";

export interface Resolved {
  apiKey: string;
  spaceId: string;
  baseUrl: string;
  apiKeySource: Source;
  /** Where a context-sourced key is stored; "" when the key came from a flag or env var, or is missing. */
  apiKeyStorage: KeyStorage | "";
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
  // --api-key and KROVA_API_KEY win without ever touching the keychain: the stored
  // key is only read (and the keychain only prompted) when nothing overrides it.
  const overridden = Boolean((flags.apiKey ?? "").trim() || (process.env[ENV.apiKey] ?? "").trim());
  const [apiKey, apiKeySource] = pick(
    flags.apiKey,
    process.env[ENV.apiKey],
    overridden || !ctx ? undefined : contextKey(ctx),
  );
  const [spaceId, spaceIdSource] = pick(flags.space, process.env[ENV.spaceId], ctx?.spaceId);
  const [baseUrlRaw] = pick(flags.baseUrl, process.env[ENV.baseUrl], ctx?.baseUrl);
  return {
    apiKey,
    spaceId,
    baseUrl: baseUrlRaw || DEFAULT_BASE_URL,
    apiKeySource,
    apiKeyStorage: apiKeySource === "context" && ctx ? storageOf(ctx) : "",
    spaceIdSource,
    contextName: ctx?.name ?? "",
  };
}

// --- API key storage (OS keychain with a 0600 file fallback) ---------------

export function storageOf(ctx: Context): KeyStorage {
  return ctx.keyStorage === "keychain" ? "keychain" : "file";
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One short line on stderr (stdout stays clean for --json). */
function warn(msg: string): void {
  process.stderr.write(`krova: ${msg}\n`);
}

/** The context's API key: from the file, or from the OS keychain for a keychain context.
 *  A keychain that cannot be read warns on stderr and returns "" (so the caller sees
 *  "no key" and is told to log in again) instead of crashing every command. */
export function contextKey(ctx: Context): string {
  if (storageOf(ctx) !== "keychain") return ctx.apiKey ?? "";
  try {
    const key = readBackend().get(ctx.name);
    if (key) return key;
    warn(
      `the API key for context "${ctx.name}" is not in the OS keychain (service ${KEYCHAIN_SERVICE}); run \`krova login --context ${ctx.name}\` to store it again`,
    );
  } catch (e) {
    warn(
      `could not read the API key for context "${ctx.name}" from the OS keychain (${errText(e)}); run \`krova login --context ${ctx.name}\` to store it again`,
    );
  }
  return "";
}

export interface StoreResult {
  storage: KeyStorage;
  /** Human name of the keychain used, when storage is "keychain". */
  backend?: string;
}

/** Write `key` to the keychain (verified by a read-back) and mark `ctx` as a keychain
 *  context, else keep it in the 0600 file with a one-line stderr message. Mutates `ctx`;
 *  the caller still calls `save`. Never throws. */
export function setContextKey(ctx: Context, key: string): StoreResult {
  try {
    const backend = writeBackend();
    backend.set(ctx.name, key);
    if (backend.get(ctx.name) !== key) {
      try {
        backend.delete(ctx.name);
      } catch {
        /* best effort */
      }
      throw new Error("the keychain did not return the stored key");
    }
    ctx.keyStorage = "keychain";
    ctx.apiKey = undefined;
    return { storage: "keychain", backend: backend.name };
  } catch (e) {
    // An explicit KROVA_NO_KEYCHAIN opt-out is silent; every other reason is said once.
    if (!(e instanceof KeychainUnavailableError && e.optOut)) {
      warn(`OS keychain unavailable (${errText(e)}); storing the API key in ${configPath()} (mode 0600) instead`);
    }
  }
  // Leaving a keychain context for the file: drop the stale item.
  if (storageOf(ctx) === "keychain") deleteContextKey(ctx);
  ctx.keyStorage = "file";
  ctx.apiKey = key;
  return { storage: "file" };
}

/** Delete the context's keychain item, if it has one. Failure is a warning, not an error:
 *  the context is being removed either way. */
export function deleteContextKey(ctx: Context): void {
  if (storageOf(ctx) !== "keychain") return;
  try {
    readBackend().delete(ctx.name);
  } catch (e) {
    warn(`could not delete the keychain item for context "${ctx.name}" (${errText(e)}); remove it by hand (service ${KEYCHAIN_SERVICE}, account ${ctx.name})`);
  }
}

/** Rename a context and save the config. A keychain key moves with it: the new item is written
 *  and verified first, the config is saved, and only then is the old item deleted. A failure at
 *  any step before that leaves the context (and its old item) as it was. */
export function renameContext(
  cfg: Config,
  oldName: string,
  newName: string,
  persist: () => void = () => save(cfg),
): void {
  const c = find(cfg, oldName);
  if (!c) throw new Error(`no context named "${oldName}"`);
  assertContextName(newName);
  if (find(cfg, newName)) throw new Error(`a context named "${newName}" already exists`);
  const moved = storageOf(c) === "keychain";
  const backend = moved ? readBackend() : undefined;
  if (backend) {
    let key: string | undefined;
    try {
      key = backend.get(oldName);
    } catch (e) {
      throw new Error(`could not read the key for "${oldName}" from the OS keychain: ${errText(e)}`);
    }
    if (!key) throw new Error(`the API key for "${oldName}" is not in the OS keychain; run \`krova login --context ${oldName}\` first`);
    try {
      backend.set(newName, key);
      if (backend.get(newName) !== key) throw new Error("the keychain did not return the stored key");
    } catch (e) {
      try {
        backend.delete(newName);
      } catch {
        /* best effort */
      }
      throw new Error(`could not move the key to "${newName}" in the OS keychain: ${errText(e)}`);
    }
  }
  const wasCurrent = cfg.currentContext === oldName;
  c.name = newName;
  if (wasCurrent) cfg.currentContext = newName;
  try {
    persist();
  } catch (e) {
    c.name = oldName;
    if (wasCurrent) cfg.currentContext = oldName;
    if (backend) {
      try {
        backend.delete(newName);
      } catch {
        /* best effort */
      }
    }
    throw e;
  }
  if (backend) {
    try {
      backend.delete(oldName);
    } catch (e) {
      warn(`renamed, but could not delete the old keychain item (${errText(e)}); remove it by hand (service ${KEYCHAIN_SERVICE}, account ${oldName})`);
    }
  }
}

export interface MigrateEntry {
  context: string;
  result: "migrated" | "skipped" | "failed";
  detail?: string;
}

/** Move every file-stored key into the keychain. A key leaves the file only after the
 *  keychain read-back matches; `save` runs after each context so a later failure never
 *  loses an earlier move. Throws when no keychain can be used at all. */
export function migrateKeysToKeychain(cfg: Config): { backend: string; entries: MigrateEntry[] } {
  const backend = writeBackend(); // honors KROVA_NO_KEYCHAIN (throws KeychainUnavailableError)
  const entries: MigrateEntry[] = [];
  for (const ctx of cfg.contexts ?? []) {
    if (storageOf(ctx) === "keychain") {
      entries.push({ context: ctx.name, result: "skipped", detail: "already in the keychain" });
      continue;
    }
    const key = (ctx.apiKey ?? "").trim();
    if (!key) {
      entries.push({ context: ctx.name, result: "skipped", detail: "no API key stored" });
      continue;
    }
    try {
      backend.set(ctx.name, key);
      if (backend.get(ctx.name) !== key) {
        try {
          backend.delete(ctx.name);
        } catch {
          /* best effort */
        }
        throw new Error("the keychain did not return the stored key");
      }
    } catch (e) {
      entries.push({ context: ctx.name, result: "failed", detail: errText(e) });
      continue;
    }
    ctx.keyStorage = "keychain";
    ctx.apiKey = undefined;
    save(cfg);
    entries.push({ context: ctx.name, result: "migrated" });
  }
  return { backend: backend.name, entries };
}

/** A context name becomes a keychain account passed to `security` and `secret-tool`, so one that
 *  starts with `-` could be read as an option. */
export function assertContextName(name: string): void {
  if (name.trim().startsWith("-")) throw new Error(`context names cannot start with "-" (got "${name}")`);
}

export function sanitizeContextName(name: string): string {
  const clean = name.trim().toLowerCase().replace(/\s+/g, "-");
  assertContextName(clean);
  return clean;
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** The key as it should be printed: masked unless `--show-secrets` was passed. */
export function displayKey(key: string, showSecrets: boolean): string {
  return showSecrets ? key : maskKey(key);
}
