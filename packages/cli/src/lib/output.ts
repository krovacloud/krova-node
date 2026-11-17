/**
 * Stop quietly when the reader of stdout goes away (`krova cubes list | head -1`),
 * the way standard Unix tools do: an EPIPE ends the process with status 0 and no
 * stack trace. Every other write error is still reported, as `Error: ...` with
 * status 1; only the one expected case is silent.
 */
export function exitQuietlyOnBrokenPipe(
  stream: NodeJS.EventEmitter = process.stdout,
  exit: (code: number) => void = (code) => process.exit(code),
  warn: (text: string) => void = (text) => void process.stderr.write(text)
): void {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE") return exit(0);
    warn(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    exit(1);
  });
}

export function printJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Where to connect for a TCP mapping: `host:port`.
 *
 * `host` is the Cube's OWN stable hostname, which survives migration to
 * another server — not the server's hostname, which does not. Shared by
 * `tcp list` and `tcp add` so the two can never disagree about how a connect
 * target is spelled.
 *
 * Falls back to the bare port when the Cube has no host (no server assigned).
 * Printing a port alone is honest about what is known; inventing a host, or
 * printing `null:30000`, is not.
 */
export function mappingConnectTarget(mapping: {
  host?: string | null;
  hostPort: number;
}): string {
  return mapping.host
    ? `${mapping.host}:${mapping.hostPort}`
    : String(mapping.hostPort);
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
