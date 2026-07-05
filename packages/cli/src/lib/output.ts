export function printJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const fmt = (cols: string[]) =>
    cols
      .map((c, i) => (c ?? "").padEnd(widths[i] ?? 0))
      .join("  ")
      .replace(/\s+$/, "");
  process.stdout.write(`${fmt(header)}\n`);
  for (const r of rows) process.stdout.write(`${fmt(r)}\n`);
}

export function printKeyValue(pairs: Array<[string, string]>): void {
  const w = Math.max(0, ...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) {
    process.stdout.write(`${k.padEnd(w)}  ${v}\n`);
  }
}
