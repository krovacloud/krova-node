import { Command } from "commander";

import { ENV } from "../lib/config.js";
import { printJSON } from "../lib/output.js";
import { getRuntime } from "../lib/runtime.js";
import { compareVersions, parseVersion } from "../lib/semver.js";
import { CLI_VERSION } from "./version.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const UPDATE_COMMAND = "npm install -g @krovacloud/cli@latest";
const CHECK_TIMEOUT_MS = 10_000;

/** One reason line, plus a hint when the failure looks like the network —
 *  the top-level handler names the API base URL for any connection failure,
 *  which would be wrong here: this check talks to npm, not to Krova. */
function failureFor(err: unknown): { reason: string; hint?: string } {
  const mirrorHint = `Check your connection or set ${ENV.npmRegistry} to use an npm mirror.`;
  if (!(err instanceof Error)) return { reason: String(err) };
  const code = (err as Error & { code?: unknown }).code;
  if (err.name === "TimeoutError" || code === "ABORT_ERR") {
    return { reason: `timed out after ${CHECK_TIMEOUT_MS / 1000}s`, hint: mirrorHint };
  }
  const cause = (err as Error & { cause?: unknown }).cause;
  if (
    cause &&
    typeof cause === "object" &&
    typeof (cause as { message?: unknown }).message === "string"
  ) {
    return { reason: (cause as { message: string }).message, hint: mirrorHint };
  }
  return { reason: err.message, hint: err.message === "fetch failed" ? mirrorHint : undefined };
}

function registryError(reason: string, hint?: string): Error {
  const err = new Error(`could not check the npm registry: ${reason}`);
  return hint ? Object.assign(err, { hint }) : err;
}

/** The registry's latest published version, e.g. "0.7.0". */
async function fetchLatestVersion(baseUrl: string): Promise<string> {
  const base = (baseUrl || DEFAULT_REGISTRY).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/@krovacloud%2fcli/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    const failure = failureFor(err);
    throw registryError(failure.reason, failure.hint);
  }
  if (!res.ok) throw registryError(`the registry answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw registryError("the response was not valid JSON");
  }
  const version = (body as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || !parseVersion(version)) {
    throw registryError("the response did not name a version");
  }
  return version.trim();
}

export function updateCommand(): Command {
  return new Command("update")
    .description("check the npm registry for a newer krova CLI (never installs)")
    .action(async (_opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const latest = await fetchLatestVersion(process.env[ENV.npmRegistry] ?? "");
      const current = CLI_VERSION;
      const updateAvailable = compareVersions(latest, current) > 0;

      if (rt.json) {
        return printJSON({ current, latest, updateAvailable, command: UPDATE_COMMAND });
      }
      process.stdout.write(
        updateAvailable
          ? `krova ${latest} is available (you have ${current}). Update with: ${UPDATE_COMMAND}\n`
          : `krova ${latest} is the latest version.\n`
      );
    });
}
