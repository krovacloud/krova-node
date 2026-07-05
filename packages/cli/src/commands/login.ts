import { spawn } from "node:child_process";

import { Command } from "commander";

import { rawRequest } from "../lib/client.js";
import { configPath } from "../lib/config.js";
import { persistLogin } from "../lib/persist.js";
import { getRuntime } from "../lib/runtime.js";

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

/** Only open https URLs, or http to a loopback host. Everything else is unsafe. */
export function safeBrowserURL(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === "https:" && u.hostname) return raw;
  if (
    u.protocol === "http:" &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1")
  ) {
    return raw;
  }
  return null;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true, shell: process.platform === "win32" });
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
      process.stdout.write("Waiting for approval…\n");

      // poll loop
      // eslint-disable-next-line no-constant-condition
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
          const { ctxName, spaceName } = await persistLogin({
            apiKey: poll.data.apiKey,
            baseUrl,
            spaceId: poll.data.spaceId,
            ctxName: opts.context as string | undefined,
            timeoutMs: rt.timeoutMs,
          });
          process.stdout.write(`Logged in. Saved context "${ctxName}" to ${configPath()}\n`);
          if (spaceName) process.stdout.write(`Space: ${spaceName}\n`);
          return;
        }
        if (poll.status === 202 || poll.status === 425 || poll.status === 428) continue;
        if (poll.status === 410) {
          throw new Error("login expired: request a new code with `krova login`");
        }
        if (poll.status === 404) throw new Error(BROWSER_UNAVAILABLE);
        throw new Error(`login failed while polling (HTTP ${poll.status})`);
      }
    });
}
