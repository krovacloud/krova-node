const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\x1b[K";

export interface Spinner {
  /** Stop the spinner and clear its line. Safe to call more than once. */
  stop(): void;
}

const NOOP: Spinner = { stop() {} };

/**
 * Whether a spinner may be drawn: only on an interactive stderr, and never
 * when the command prints JSON (the caller passes `json`).
 */
export function spinnerEnabled(json: boolean, stream: NodeJS.WriteStream = process.stderr): boolean {
  return Boolean(stream.isTTY) && !json;
}

/**
 * Start a tiny stderr spinner with `label`. Returns a no-op when stderr is not
 * a TTY or `json` is set, so piped and scripted output never changes.
 * The line is cleared by `stop()` and, as a backstop, when the process exits.
 */
export function startSpinner(
  label: string,
  opts: { json?: boolean; stream?: NodeJS.WriteStream } = {}
): Spinner {
  const stream = opts.stream ?? process.stderr;
  if (!spinnerEnabled(Boolean(opts.json), stream)) return NOOP;

  let i = 0;
  let active = true;
  const draw = () => stream.write(`${CLEAR_LINE}${FRAMES[i++ % FRAMES.length]} ${label}`);
  const clear = () => stream.write(CLEAR_LINE);
  const onExit = () => {
    if (active) clear();
  };
  draw();
  const timer = setInterval(draw, 80);
  timer.unref();
  process.once("exit", onExit);
  return {
    stop() {
      if (!active) return;
      active = false;
      clearInterval(timer);
      process.removeListener("exit", onExit);
      clear();
    },
  };
}

/** Run `fn` with a spinner that is cleared on success and on failure. */
export async function withSpinner<T>(
  label: string,
  opts: { json?: boolean; stream?: NodeJS.WriteStream },
  fn: () => Promise<T>
): Promise<T> {
  const spinner = startSpinner(label, opts);
  try {
    return await fn();
  } finally {
    spinner.stop();
  }
}
