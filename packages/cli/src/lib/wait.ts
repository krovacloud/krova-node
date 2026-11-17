import { KrovaError } from "@krovacloud/sdk";
import type { Command } from "commander";

import { spinnerEnabled } from "./spinner.js";

/** Every state the API reports for a Cube. */
export const CUBE_STATES = [
  "pending",
  "booting",
  "running",
  "stopped",
  "stopping",
  "resizing",
  "error",
  "deleted",
] as const;

export type CubeState = (typeof CUBE_STATES)[number];

export const DEFAULT_WAIT_TIMEOUT_S = 300;
/** Product behavior: how often the CLI asks the API while it waits. */
export const WAIT_POLL_MS = 2000;

/** States a Cube does not come back from, so waiting on another state is over. */
const DEAD_ENDS: ReadonlySet<string> = new Set(["error", "deleted"]);

/** Consecutive failed polls (a dropped connection, a 5xx) before the wait gives up. */
const MAX_POLL_FAILURES = 3;

/** A whole number of seconds, 1 or more. `undefined` gives the default. */
export function parseWaitSeconds(raw: string | undefined, flag: string): number {
  if (raw === undefined) return DEFAULT_WAIT_TIMEOUT_S;
  const s = String(raw).trim();
  const n = Number(s);
  if (!/^\d+$/.test(s) || !Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} must be a whole number of seconds, 1 or more (got "${raw}").`);
  }
  return n;
}

export function parseWaitState(raw: string | undefined): CubeState {
  const s = (raw ?? "running").trim().toLowerCase();
  if (!(CUBE_STATES as readonly string[]).includes(s)) {
    throw new Error(`--state must be one of ${CUBE_STATES.join(", ")} (got "${raw}").`);
  }
  return s as CubeState;
}

/**
 * A flag's value only when it was typed on the command line, looking through
 * the parents too. The root command defines `--timeout` as well (the per-request
 * timeout), and commander hands a flag to the outermost command that knows it,
 * so a subcommand's own `--timeout` never sees the value.
 */
export function optionFromCli(cmd: Command, key: string): string | undefined {
  for (let c: Command | null = cmd; c; c = c.parent) {
    if (c.getOptionValueSource(key) === "cli") return String(c.getOptionValue(key));
  }
  return undefined;
}

export interface WaitOptions<T extends { state: string }> {
  /** What the user typed, for messages. */
  cubeRef: string;
  target: string;
  timeoutS: number;
  /** One look at the Cube. */
  get: () => Promise<T>;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called after every look, with the state and the seconds waited so far. */
  onPoll?: (state: string, elapsedS: number) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function transient(err: unknown): boolean {
  return !(err instanceof KrovaError) || err.status >= 500;
}

/**
 * Poll a Cube until it reaches `target`. Resolves with the Cube as last seen.
 * Rejects with a one-line message on a timeout, or when the Cube lands in
 * `error` or `deleted` (unless that is the state asked for).
 */
export async function waitForCubeState<T extends { state: string }>(
  o: WaitOptions<T>
): Promise<T> {
  const interval = o.intervalMs ?? WAIT_POLL_MS;
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const start = now();
  const deadline = start + o.timeoutS * 1000;
  let last = "unknown";
  let failures = 0;
  for (;;) {
    let cube: T | undefined;
    try {
      cube = await o.get();
      failures = 0;
    } catch (err) {
      if (!transient(err) || ++failures >= MAX_POLL_FAILURES) throw err;
    }
    if (cube) {
      last = cube.state;
      o.onPoll?.(last, Math.floor((now() - start) / 1000));
      if (last === o.target) return cube;
      if (DEAD_ENDS.has(last)) {
        throw new Error(
          `cube ${o.cubeRef} is in the "${last}" state, so it will not become ${o.target}`
        );
      }
    }
    const left = deadline - now();
    if (left <= 0) {
      throw new Error(
        `timed out after ${o.timeoutS}s waiting for cube ${o.cubeRef} to be ${o.target} (last state: ${last})`
      );
    }
    await sleep(Math.min(interval, left));
  }
}

/** The one-line progress readout on stderr: a TTY only, never with JSON. */
export function startWaitProgress(
  cubeRef: string,
  target: string,
  json: boolean,
  stream: NodeJS.WriteStream = process.stderr
): { update: (state: string, elapsedS: number) => void; stop: () => void } {
  if (!spinnerEnabled(json, stream)) return { update() {}, stop() {} };
  const CLEAR = "\r\x1b[K";
  let drawn = false;
  const clear = () => {
    if (drawn) stream.write(CLEAR);
    drawn = false;
  };
  process.once("exit", clear);
  return {
    update(state, elapsedS) {
      drawn = true;
      stream.write(`${CLEAR}Waiting for cube ${cubeRef} to be ${target}: ${state}, ${elapsedS}s`);
    },
    stop() {
      clear();
      process.removeListener("exit", clear);
    },
  };
}
