/** The values the global `-o, --output <format>` flag accepts. */
export const OUTPUT_FORMATS = ["table", "json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Values worth completing after a flag, keyed by the flag as typed. */
export const FLAG_VALUE_CHOICES: Record<string, readonly string[]> = {
  "-o": OUTPUT_FORMATS,
  "--output": OUTPUT_FORMATS,
};

/**
 * Validate the `--output` value. Unset means the default, `table`.
 * Throws a one-line error for anything else, so a typo never silently
 * falls back to a table in a script that expects JSON.
 */
export function parseOutputFormat(raw: unknown): OutputFormat {
  if (raw === undefined || raw === null || raw === "") return "table";
  const value = String(raw);
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new Error(`--output must be "json" or "table" (got "${value}")`);
}
