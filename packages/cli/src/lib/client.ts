import { KrovaClient } from "@krovacloud/sdk";

import type { Resolved } from "./config.js";

/** Build the SDK client, or throw the same message the Go CLI used. */
export function makeClient(res: Resolved): KrovaClient {
  if (!res.apiKey) {
    throw new Error(
      "no API key found: run `krova auth login`, set KROVA_API_KEY, or pass --api-key"
    );
  }
  return new KrovaClient({ apiKey: res.apiKey, baseUrl: res.baseUrl });
}

/** Raw JSON request for endpoints the SDK doesn't cover:
 *  GET /space, GET .../ssh, POST /auth/cli/start, POST /auth/cli/poll. */
export async function rawRequest<T>(opts: {
  method: string;
  baseUrl: string;
  path: string;
  apiKey?: string;
  body?: unknown;
  timeoutMs: number;
}): Promise<{ status: number; data: T | undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.apiKey) headers["X-API-KEY"] = opts.apiKey;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    let data: T | undefined;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = undefined;
      }
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}
