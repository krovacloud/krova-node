/** Default cap for each of stdout, stderr and file contents returned to the model. */
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;

export interface Truncated {
  text: string;
  /** True when bytes were dropped from the end. */
  truncated: boolean;
  /** Bytes dropped from the end; 0 when nothing was cut. */
  omittedBytes: number;
}

export function assertMaxOutputBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("maxOutputBytes must be a positive integer.");
  }
}

/**
 * Keep the first `maxBytes` bytes of `text` (UTF-8), never splitting a
 * character, and append a marker that says how much was dropped.
 */
export function truncateText(text: string, maxBytes: number): Truncated {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false, omittedBytes: 0 };
  let end = maxBytes;
  // 0b10xxxxxx marks a continuation byte; step back to the start of the character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const omittedBytes = bytes.length - end;
  const kept = bytes.subarray(0, end).toString("utf8");
  return {
    text: `${kept}\n[truncated: ${omittedBytes} more bytes omitted]`,
    truncated: true,
    omittedBytes,
  };
}
