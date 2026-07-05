import { Command } from "commander";

import { printJSON, printKeyValue, printTable } from "../lib/output.js";
import { getRuntime, makeClient } from "../lib/runtime.js";

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Flatten a top-level object field one level deep into `key.subkey` rows, so
 *  nested objects (e.g. pricing's `rates`) render as readable key/value pairs
 *  instead of a JSON blob. Exported for testing. */
export function flattenRows(entries: [string, unknown][]): [string, string][] {
  const rows: [string, string][] = [];
  for (const [k, v] of entries) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        rows.push([`${k}.${sk}`, fmtVal(sv)]);
      }
    } else {
      rows.push([k, fmtVal(v)]);
    }
  }
  return rows;
}

/**
 * Render a catalog payload as text. If the payload has an array field, print any
 * scalar/object fields first (as key/value) and then the array as a table —
 * otherwise the non-array fields are silently dropped. This matters for
 * `pricing`, whose per-resource `rates` (the actual hourly prices), `currency`,
 * and `note` sit alongside the `tiers` array. `regions`/`images` have only the
 * array, so their output is unchanged.
 */
function renderCatalog(obj: Record<string, unknown>): void {
  const arrKey = Object.keys(obj).find((k) => Array.isArray(obj[k]));
  if (!arrKey) {
    printKeyValue(flattenRows(Object.entries(obj)));
    return;
  }
  const rest = flattenRows(Object.entries(obj).filter(([k]) => k !== arrKey));
  if (rest.length) printKeyValue(rest);
  const arr = (obj[arrKey] as Record<string, unknown>[]) ?? [];
  const cols = [...new Set(arr.flatMap((o) => Object.keys(o)))];
  printTable(
    cols.map((c) => c.toUpperCase()),
    arr.map((o) => cols.map((c) => fmtVal(o[c])))
  );
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
