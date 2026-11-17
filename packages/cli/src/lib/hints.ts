import { KrovaError, TerminationProtectedError } from "@krovacloud/sdk";

import { ENV } from "./config.js";

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Hint for an API status, or undefined when a generic hint would not help (e.g. 400, 422). */
export function hintForStatus(status: number): string | undefined {
  if (status === 401) return "Your API key was rejected. Run krova login, or check krova whoami.";
  if (status === 403) {
    return "Your key's member lacks the permission for this action. Ask a space owner to grant it.";
  }
  if (status === 404) return "Not found. Check the name or ID with the matching list command.";
  if (status === 409) return "The resource is busy or in a conflicting state. Try again in a moment.";
  if (status === 429) return "Rate limited. Wait a moment and try again.";
  if (status >= 500 && status <= 599) {
    return "Krova had a server error. Try again; if it keeps happening, contact support.";
  }
  return undefined;
}

/** True when `err` (or anything in its cause chain) is a connection failure. */
export function isNetworkError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (e: unknown, depth: number): boolean => {
    if (!e || typeof e !== "object" || depth > 5 || seen.has(e)) return false;
    seen.add(e);
    const { code, message, cause, errors } = e as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    if (typeof message === "string") {
      if (message === "fetch failed") return true;
      for (const c of NETWORK_CODES) if (message.includes(c)) return true;
    }
    if (walk(cause, depth + 1)) return true;
    return Array.isArray(errors) && errors.some((x) => walk(x, depth + 1));
  };
  return walk(err, 0);
}

/**
 * The one extra line the top-level error handler prints under `Error: ...`.
 *
 * - An error that carries its own `hint` string wins: it is returned as-is, so
 *   a command that already explains itself is never given a second, generic one.
 * - A `KrovaError` (the API answered) gets a hint by status. A termination
 *   protection refusal gets none: retrying cannot help and its message is exact.
 * - A connection failure gets a hint naming the base URL being used.
 * - Anything else (validation, local errors) gets none.
 */
export function errorHint(err: unknown, baseUrl: string): string | undefined {
  const own = (err as { hint?: unknown } | null)?.hint;
  if (typeof own === "string" && own) return own;
  if (err instanceof TerminationProtectedError) return undefined;
  if (err instanceof KrovaError) return hintForStatus(err.status);
  if (isNetworkError(err)) {
    return `Could not reach ${baseUrl}. Check your connection or ${ENV.baseUrl}.`;
  }
  return undefined;
}
