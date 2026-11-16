import * as readline from "node:readline";

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

/** `0.0.0.0/0` and `::/0` accept every address; an empty list means no limit at all. */
export function isOpenWhitelist(whitelist: readonly string[]): boolean {
  const entries = whitelist.map((w) => w.trim()).filter(Boolean);
  if (entries.length === 0) return true;
  return entries.some((w) => w === "0.0.0.0/0" || w === "::/0");
}

export function publicExposureWarning(cube: string, cubePort: number): string {
  return `Warning: port ${cubePort} on ${cube} will be reachable from the whole internet. Limit it with --whitelist <cidr>, or use a private tunnel instead: krova tunnel ${cube} ${cubePort}.`;
}

/**
 * Read a y/N answer. The prompt goes to stderr so `--json` stdout stays pure
 * JSON. Anything but y or yes counts as no.
 */
export function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** Print the abort notice: stdout for people, stderr under `--json`. */
export function printAborted(json: boolean): void {
  (json ? process.stderr : process.stdout).write("Aborted.\n");
}
