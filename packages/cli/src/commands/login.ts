import { spawn } from "node:child_process";

import { Command } from "commander";

import { rawRequest } from "../lib/client.js";
import { loginMessage, persistLogin } from "../lib/persist.js";
import { getRuntime } from "../lib/runtime.js";
import { spinnerEnabled, withSpinner } from "../lib/spinner.js";

interface StartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}
interface PollResponse {
  apiKey: string;
  spaceId: string;
}

const BROWSER_UNAVAILABLE =
  "Browser login isn't enabled on this server yet — run `krova auth login` to paste an API key from https://krova.cloud";

/** Characters that never appear in a device-login URL and that cmd.exe treats as operators. */
const SHELL_METACHARS = /[&|^<>"]/;

/**
 * Only open https URLs, or http to a loopback host, and return the normalized href.
 * The device-login URL is `<base>/cli?code=<ALNUM-ALNUM>`: it never needs `& | ^ < > "`, so a URL
 * carrying one is refused on every platform. `%` is refused on Windows only, where it expands
 * environment variables in some launchers; the real URL never contains it (the code is alphanumeric).
 * A refused URL is not opened: the caller prints it for the user to open by hand.
 */
export function safeBrowserURL(
  raw: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const loopbackHttp =
    u.protocol === "http:" &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  if (!((u.protocol === "https:" && u.hostname) || loopbackHttp)) return null;
  const href = u.href;
  if (SHELL_METACHARS.test(href)) return null;
  if (platform === "win32" && href.includes("%")) return null;
  return href;
}

export interface BrowserSpawnPlan {
  command: string;
  args: string[];
  options: { stdio: "ignore"; detached: true; windowsHide?: true };
}

/**
 * How to open `href` in the default browser. Never uses a shell: on Windows `rundll32` is a real
 * executable, so cmd.exe never parses the URL.
 */
export function browserSpawnPlan(
  href: string,
  platform: NodeJS.Platform = process.platform
): BrowserSpawnPlan {
  if (platform === "win32") {
    return {
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", href],
      options: { stdio: "ignore", detached: true, windowsHide: true },
    };
  }
  return {
    command: platform === "darwin" ? "open" : "xdg-open",
    args: [href],
    options: { stdio: "ignore", detached: true },
  };
}

function openBrowser(href: string): void {
  const plan = browserSpawnPlan(href);
  const child = spawn(plan.command, plan.args, plan.options);
  child.on("error", () => {
    /* fall through — the URL was already printed */
  });
  child.unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loginCommand(): Command {
  return new Command("login")
    .description("log in through your browser (device authorization)")
    .option("--no-browser", "don't open a browser; just print the URL")
    .option("--context <name>", "name for the saved context")
    .action(async (opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const baseUrl = rt.res.baseUrl;

      const start = await rawRequest<StartResponse>({
        method: "POST",
        baseUrl,
        path: "/auth/cli/start",
        timeoutMs: rt.timeoutMs,
      });
      if (start.status === 404) throw new Error(BROWSER_UNAVAILABLE);
      if (start.status !== 200 || !start.data?.deviceCode) {
        throw new Error(`device login failed to start (HTTP ${start.status})`);
      }
      const s = start.data;
      process.stdout.write(`Your verification code is: ${s.userCode}\n`);

      const target = s.verificationUriComplete || s.verificationUri;
      const safe = safeBrowserURL(target);
      if (safe && opts.browser !== false) {
        process.stdout.write(`Opening ${safe} …\n`);
        openBrowser(safe);
      } else {
        process.stdout.write(`Open this URL to approve the login:\n  ${target}\n`);
      }

      const intervalMs = Math.max((s.interval || 5) * 1000, 5000);
      const deadline = Date.now() + Math.max(s.expiresIn || 600, 1) * 1000;
      // On an interactive terminal the spinner says it; otherwise keep the plain line.
      if (!spinnerEnabled(rt.json)) process.stdout.write("Waiting for approval…\n");

      // Poll loop. withSpinner clears the spinner line on success and on failure.
      const approved = await withSpinner("Waiting for approval", { json: rt.json }, async () => {
        for (;;) {
          if (Date.now() >= deadline) {
            throw new Error(
              "login timed out: the verification code expired before it was approved"
            );
          }
          await sleep(intervalMs);
          const poll = await rawRequest<PollResponse>({
            method: "POST",
            baseUrl,
            path: "/auth/cli/poll",
            body: { deviceCode: s.deviceCode },
            timeoutMs: rt.timeoutMs,
          });
          if (poll.status === 200) {
            if (!poll.data?.apiKey) throw new Error("login succeeded but no API key was returned");
            return poll.data;
          }
          if (poll.status === 202 || poll.status === 425 || poll.status === 428) continue;
          if (poll.status === 410) {
            throw new Error("login expired: request a new code with `krova login`");
          }
          if (poll.status === 404) throw new Error(BROWSER_UNAVAILABLE);
          throw new Error(`login failed while polling (HTTP ${poll.status})`);
        }
      });
      const { ctxName, spaceName, stored } = await persistLogin({
        apiKey: approved.apiKey,
        baseUrl,
        spaceId: approved.spaceId,
        ctxName: opts.context as string | undefined,
        timeoutMs: rt.timeoutMs,
      });
      process.stdout.write(`${loginMessage(ctxName, stored)}\n`);
      if (spaceName) process.stdout.write(`Space: ${spaceName}\n`);
    });
}
