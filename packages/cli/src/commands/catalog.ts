import { Command } from "commander";

import { printJSON, printKeyValue, printTable } from "../lib/output.js";
import { getRuntime, makeClient } from "../lib/runtime.js";

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Render like the Go CLI: table the first array-valued field, else key/value. */
function renderCatalog(obj: Record<string, unknown>): void {
  const arrKey = Object.keys(obj).find((k) => Array.isArray(obj[k]));
  if (arrKey) {
    const arr = (obj[arrKey] as Record<string, unknown>[]) ?? [];
    const cols = [...new Set(arr.flatMap((o) => Object.keys(o)))];
    printTable(
      cols.map((c) => c.toUpperCase()),
      arr.map((o) => cols.map((c) => fmtVal(o[c])))
    );
    return;
  }
  printKeyValue(Object.entries(obj).map(([k, v]) => [k, fmtVal(v)]));
}

function catalogCmd(
  name: string,
  desc: string,
  fetch: (c: ReturnType<typeof makeClient>) => Promise<Record<string, unknown>>
): Command {
  return new Command(name)
    .description(desc)
    .action(async (_opts, cmd: Command) => {
      const rt = getRuntime(cmd);
      const client = makeClient(rt.res);
      const data = await fetch(client);
      if (rt.json) return printJSON(data);
      renderCatalog(data);
    });
}

export function regionsCommand(): Command {
  return catalogCmd("regions", "list regions with available capacity", (c) =>
    c.catalog.regions() as Promise<Record<string, unknown>>
  );
}
export function imagesCommand(): Command {
  return catalogCmd("images", "list available OS images", (c) =>
    c.catalog.images() as Promise<Record<string, unknown>>
  );
}
export function pricingCommand(): Command {
  return catalogCmd("pricing", "show per-resource hourly pricing", (c) =>
    c.catalog.pricing() as Promise<Record<string, unknown>>
  );
}
