import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline/promises";

/**
 * The interactive half of `krova cubes create`.
 *
 * Everything the prompt flow touches from the outside (the terminal, the
 * catalog, the key files) comes in through an interface, so tests drive it
 * with scripted answers and never need a TTY, a network or a real home dir.
 */

/** Defaults for the resource flags. `cubes create` registers them on its options too. */
export const DEFAULT_RESOURCES = { vcpu: "1", ram: "1", disk: "10" } as const;

/** One question-and-answer channel. */
export interface PromptIO {
  /** Show `question` and resolve with the typed line. Rejects with PromptAbortError when input ends. */
  ask(question: string): Promise<string>;
  /** Text for the person at the terminal (stdout). */
  write(text: string): void;
  /** A warning (stderr). */
  warn(text: string): void;
  close(): void;
}

/** Input ended (Ctrl+C, Ctrl+D, closed pipe) before the questions were answered. */
export class PromptAbortError extends Error {
  constructor() {
    super("input closed");
    this.name = "PromptAbortError";
  }
}

/** Prompts run only on a real terminal, and never when the caller asked for JSON. */
export function isInteractive(opts: {
  json: boolean;
  stdin?: { isTTY?: boolean };
  stdout?: { isTTY?: boolean };
}): boolean {
  if (opts.json) return false;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** The real terminal, via node:readline/promises. */
export function createReadlineIO(): PromptIO {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<never>((_, reject) => {
    rl.once("close", () => reject(new PromptAbortError()));
  });
  // The rejection is observed through `ask`; this keeps it from surfacing unhandled.
  closed.catch(() => undefined);
  rl.on("SIGINT", () => rl.close());
  return {
    ask: (question) => Promise.race([rl.question(question), closed]),
    write: (text) => void process.stdout.write(text),
    warn: (text) => void process.stderr.write(text),
    close: () => rl.close(),
  };
}

export interface CatalogImage {
  id: string;
  name: string;
  version: string;
}

export interface CatalogRegion {
  slug: string;
  name: string;
}

/** The slice of `client.catalog` the prompts use. */
export interface CatalogSource {
  images(): Promise<{ images: CatalogImage[] }>;
  regions(): Promise<{ regions: CatalogRegion[] }>;
}

/** Where public keys are read from. Only `.pub` paths ever reach `readFile`. */
export interface KeyFiles {
  home: string;
  readFile(path: string): Promise<string>;
}

export function defaultKeyFiles(): KeyFiles {
  return { home: homedir(), readFile: (path) => readFile(path, "utf8") };
}

/** Key files offered, in order. Public halves only; a private key is never opened. */
export const KEY_CANDIDATE_FILES = ["id_ed25519.pub", "id_rsa.pub"] as const;

/** What the person typed on the command line; `undefined` means not given. */
export interface CreateGiven {
  name?: string;
  image?: string;
  sshKey?: string;
  region?: string;
  vcpu?: string;
  ram?: string;
  disk?: string;
}

export interface CreateAnswers {
  name: string;
  image: string;
  sshKey: string;
  region?: string;
  vcpu: string;
  ram: string;
  disk: string;
}

export interface PromptDeps {
  io: PromptIO;
  catalog: CatalogSource;
  keyFiles: KeyFiles;
}

// Mirrors the API's own checks (validateName and isValidSshPublicKey in krova-cloud).
const KEY_PREFIXES = [
  "ssh-rsa",
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "ssh-dss",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
];

/** A cube name: 1 to 64 characters after trimming, no control characters. Returns the trimmed name or null. */
export function validCubeName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0 || name.length > 64) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is the point
  if (/[\x00-\x1F\x7F]/.test(name)) return null;
  return name;
}

export function validSshPublicKey(raw: string): boolean {
  const type = raw.trim().split(/\s+/)[0] ?? "";
  return KEY_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function positiveInt(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Read one public key file. Refuses anything that is not a `.pub` path. */
async function readPublicKey(keyFiles: KeyFiles, path: string): Promise<string | null> {
  if (!path.endsWith(".pub")) throw new Error(`refusing to read a non-public key file: ${path}`);
  try {
    const key = (await keyFiles.readFile(path)).trim();
    return validSshPublicKey(key) ? key : null;
  } catch {
    return null;
  }
}

export interface KeyCandidate {
  /** Shown to the person, with `~` for the home directory. */
  label: string;
  key: string;
}

export async function findKeyCandidates(keyFiles: KeyFiles): Promise<KeyCandidate[]> {
  const found: KeyCandidate[] = [];
  for (const file of KEY_CANDIDATE_FILES) {
    const key = await readPublicKey(keyFiles, join(keyFiles.home, ".ssh", file));
    if (key) found.push({ label: `~/.ssh/${file}`, key });
  }
  return found;
}

/** "ssh-ed25519 AAAA you@laptop" -> "ssh-ed25519 you@laptop" (type and comment, never the key body). */
function keyBlurb(key: string): string {
  const [type, , ...comment] = key.trim().split(/\s+/);
  return [type, comment.join(" ")].filter(Boolean).join(" ");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function askName(io: PromptIO): Promise<string> {
  for (;;) {
    const name = validCubeName(await io.ask("Name: "));
    if (name) return name;
    io.write("A name is 1 to 64 characters with no control characters.\n");
  }
}

async function askImage(io: PromptIO, catalog: CatalogSource): Promise<string> {
  let images: CatalogImage[] = [];
  try {
    images = (await catalog.images()).images;
  } catch (err) {
    io.warn(`Could not load the image list (${errText(err)}).\n`);
  }
  if (images.length === 0) {
    for (;;) {
      const slug = (await io.ask("Image slug (see `krova images`): ")).trim();
      if (slug) return slug;
    }
  }
  io.write("Images:\n");
  images.forEach((img, i) => {
    io.write(`  ${i + 1}) ${img.id}  (${[img.name, img.version].filter(Boolean).join(" ")})\n`);
  });
  for (;;) {
    const answer = (await io.ask("Image (number or slug): ")).trim();
    const byNumber = /^\d+$/.test(answer) ? images[Number(answer) - 1] : undefined;
    if (byNumber) return byNumber.id;
    const byId = images.find((img) => img.id === answer);
    if (byId) return byId.id;
    io.write(`Pick a number from 1 to ${images.length}, or one of the slugs above.\n`);
  }
}

/** `undefined` means "let Krova choose". */
async function askRegion(io: PromptIO, catalog: CatalogSource): Promise<string | undefined> {
  let regions: CatalogRegion[] = [];
  try {
    regions = (await catalog.regions()).regions;
  } catch (err) {
    io.warn(`Could not load the region list (${errText(err)}).\n`);
  }
  if (regions.length === 0) return undefined;
  io.write("Regions:\n");
  regions.forEach((r, i) => {
    io.write(`  ${i + 1}) ${r.slug}  (${r.name})\n`);
  });
  for (;;) {
    const answer = (await io.ask("Region (number or slug, Enter to let Krova choose): ")).trim();
    if (!answer) return undefined;
    const byNumber = /^\d+$/.test(answer) ? regions[Number(answer) - 1] : undefined;
    if (byNumber) return byNumber.slug;
    const bySlug = regions.find((r) => r.slug === answer);
    if (bySlug) return bySlug.slug;
    io.write(`Pick a number from 1 to ${regions.length}, a slug above, or press Enter.\n`);
  }
}

async function askSize(io: PromptIO, label: string, fallback: string): Promise<string> {
  for (;;) {
    const answer = (await io.ask(`${label} [${fallback}]: `)).trim();
    const n = positiveInt(answer === "" ? fallback : answer);
    if (n !== null) return String(n);
    io.write(`${label} must be a positive whole number.\n`);
  }
}

async function askSshKey(io: PromptIO, keyFiles: KeyFiles): Promise<string> {
  const candidates = await findKeyCandidates(keyFiles);
  if (candidates.length > 0) {
    io.write("SSH public keys found:\n");
    candidates.forEach((c, i) => {
      io.write(`  ${i + 1}) ${c.label}  (${keyBlurb(c.key)})\n`);
    });
  }
  const prompt =
    candidates.length > 0
      ? "SSH key (number, or paste a public key) [1]: "
      : "SSH public key (paste it, e.g. ssh-ed25519 AAAA...): ";
  for (;;) {
    const answer = (await io.ask(prompt)).trim();
    if (candidates.length > 0 && answer === "") return (candidates[0] as KeyCandidate).key;
    const picked = /^\d+$/.test(answer) ? candidates[Number(answer) - 1] : undefined;
    if (picked) return picked.key;
    if (validSshPublicKey(answer)) return answer;
    io.write("That is not a public key. It starts with ssh-ed25519, ssh-rsa, ecdsa-sha2-... or sk-...\n");
  }
}

/**
 * Ask for every value not already given on the command line. Questions come in
 * the order name, image, region, size, SSH key; a value given as a flag is
 * never asked again.
 */
export async function promptCreate(given: CreateGiven, deps: PromptDeps): Promise<CreateAnswers> {
  const { io, catalog, keyFiles } = deps;
  const name = given.name ?? (await askName(io));
  const image = given.image ?? (await askImage(io, catalog));
  const region = given.region ?? (await askRegion(io, catalog));
  const vcpu = given.vcpu ?? (await askSize(io, "vCPUs", DEFAULT_RESOURCES.vcpu));
  const ram = given.ram ?? (await askSize(io, "RAM in GB", DEFAULT_RESOURCES.ram));
  const disk = given.disk ?? (await askSize(io, "Disk in GB", DEFAULT_RESOURCES.disk));
  const sshKey = given.sshKey ?? (await askSshKey(io, keyFiles));
  return { name, image, sshKey, ...(region ? { region } : {}), vcpu, ram, disk };
}

/** One line that says what is about to be created. */
export function summarize(
  a: Pick<CreateAnswers, "name" | "image" | "region" | "vcpu" | "ram" | "disk">,
): string {
  const parts = [
    a.image,
    a.region ? `region ${a.region}` : "region chosen by Krova",
    `${a.vcpu} vCPU`,
    `${a.ram} GB RAM`,
    `${a.disk} GB disk`,
  ];
  return `Create cube "${a.name}" (${parts.join(", ")})`;
}

/** `[Y/n]`: Enter or y/yes is yes, n/no is no, anything else asks again. */
export async function confirmCreate(io: PromptIO, summary: string): Promise<boolean> {
  for (;;) {
    const answer = (await io.ask(`${summary}? [Y/n] `)).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
  }
}
