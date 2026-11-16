import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface TTYState {
  stdin: boolean;
  stdout: boolean;
}

/** The real terminal state of this process. */
export function currentTTY(): TTYState {
  return { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) };
}

/**
 * Whether a destructive or risky command should stop and ask first.
 *
 * Only a person at a terminal is asked: when stdin or stdout is piped (a script,
 * CI, an agent), the command proceeds exactly as it always did, so adding a
 * prompt never turns a working script into a hung one. `--yes` always skips it.
 */
export function shouldConfirm(opts: { yes?: boolean }, tty: TTYState = currentTTY()): boolean {
  if (opts.yes) return false;
  return tty.stdin && tty.stdout;
}

/** Dotted-quad IPv4 to a 32-bit number, or null when it is not one. */
function ipv4ToNumber(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

/**
 * Whether a whitelist leaves the port open to every address.
 *
 * Open means: no entries at all; any entry whose prefix length is numerically 0
 * (`0.0.0.0/0`, `::/0`, and spellings such as `0.0.0.0/00` or `1.2.3.4/0`); or
 * the two IPv4 halves `0.0.0.0/1` and `128.0.0.0/1` together, which cover the
 * whole IPv4 space.
 */
export function isOpenWhitelist(whitelist: readonly string[]): boolean {
  const entries = whitelist.map((w) => w.trim()).filter(Boolean);
  if (entries.length === 0) return true;
  const halves = new Set<number>();
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/");
    if (slash < 0) continue;
    const prefix = entry.slice(slash + 1).trim();
    if (!/^\d+$/.test(prefix)) continue;
    const length = Number(prefix);
    if (length === 0) return true;
    if (length === 1) {
      const n = ipv4ToNumber(entry.slice(0, slash).trim());
      if (n !== null) halves.add(n >= 2 ** 31 ? 1 : 0);
    }
  }
  return halves.size === 2;
}

export function publicExposureWarning(cube: string, cubePort: number): string {
  return `Warning: port ${cubePort} on ${cube} will be reachable from the whole internet. Limit it with --whitelist <cidr>, or use a private tunnel instead: krova tunnel ${cube} ${cubePort}.`;
}

/**
 * Read a y/N answer. The prompt goes to stderr so `--json` stdout stays pure
 * JSON. Anything but y or yes counts as no. If the input ends before an answer
 * (Ctrl+D), the answer is no and the exit code is set to 1: nobody chose to
 * abort, so a script wrapping a terminal session must not read it as success.
 * The streams are injectable for tests.
 */
export function confirm(
  question: string,
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stderr },
): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.input, output: io.output });
    let answered = false;
    rl.on("close", () => {
      if (answered) return;
      process.exitCode = 1;
      resolve(false);
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Print the abort notice: stdout for people, stderr under `--json`. */
export function printAborted(json: boolean): void {
  (json ? process.stderr : process.stdout).write("Aborted.\n");
}
