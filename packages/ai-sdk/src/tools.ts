import { posix } from "node:path";
import type { ConnectCubeOptions, CubeSshSource, RunOptions, RunResult } from "@krovacloud/sdk/ssh";
import { connectCube } from "@krovacloud/sdk/ssh";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { assertMaxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, truncateText } from "./truncate.js";

/**
 * The part of a `CubeShell` the tools use. A real `CubeShell` satisfies it, and so does a
 * plain object in a test.
 */
export interface KrovaShell {
  run(command: string | readonly string[], options?: RunOptions): Promise<RunResult>;
  files: {
    read(remotePath: string): Promise<Uint8Array>;
    write(remotePath: string, data: string | Uint8Array): Promise<void>;
  };
}

export interface KrovaToolsOptions {
  /** An open connection to a Cube, from `connectCube` in `@krovacloud/sdk/ssh`. */
  shell: KrovaShell;
  /** Cap for each of stdout, stderr and a file's content, in bytes. Default 32768. */
  maxOutputBytes?: number;
  /** Command timeout when the model gives none, in milliseconds. Default 120000. */
  defaultTimeoutMs?: number;
}

const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_TIMEOUT_MS = 120_000;

const RUN_DESCRIPTION =
  "Run a shell command in a Krova Cube, a CPU-only Linux VM, over SSH. Returns stdout, stderr and the exit code. Each call is a fresh shell, so state such as `cd` does not carry over; pass `cwd` instead.";
const READ_DESCRIPTION =
  "Read a text file from the Cube's filesystem. The path is literal: `~` and `$VAR` are not expanded.";
const WRITE_DESCRIPTION =
  "Write a text file in the Cube's filesystem, replacing it if it exists. The path is literal: `~` and `$VAR` are not expanded.";

export interface RunToolInput {
  command: string;
  cwd?: string | undefined;
  timeoutSeconds?: number | undefined;
}

export interface RunToolOutput {
  /** `null` when the command was killed by a signal. */
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  /** True when stdout or stderr was cut to the output cap. */
  truncated: boolean;
}

export interface ReadFileToolInput {
  path: string;
}

export type ReadFileToolOutput =
  | { path: string; sizeBytes: number; binary: true }
  | { path: string; sizeBytes: number; binary: false; content: string; truncated: boolean };

export interface WriteFileToolInput {
  path: string;
  content: string;
  createParents?: boolean | undefined;
}

export interface WriteFileToolOutput {
  path: string;
  bytesWritten: number;
}

/**
 * The tool set `krovaTools` returns. Spelled out because the inferred type names modules
 * under `@ai-sdk/*` that a published `.d.ts` cannot reference.
 */
// A type alias, not an interface: only an alias gets the implicit index signature `ToolSet` needs.
export type KrovaTools = {
  krova_run: Tool<RunToolInput, RunToolOutput>;
  krova_read_file: Tool<ReadFileToolInput, ReadFileToolOutput>;
  krova_write_file: Tool<WriteFileToolInput, WriteFileToolOutput>;
};

/** Tools that let an agent run commands and read and write files in one Krova Cube. */
export function krovaTools(options: KrovaToolsOptions): KrovaTools {
  const { shell } = options;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  assertMaxOutputBytes(maxBytes);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const krova_run = tool({
    description: RUN_DESCRIPTION,
    inputSchema: z.object({
      command: z.string().min(1).describe("The command line to run, for example `ls -la`."),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe("Directory to run in. Defaults to the home directory."),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_SECONDS)
        .optional()
        .describe(
          `Stop the command after this many seconds. Default ${Math.round(defaultTimeoutMs / 1000)}.`,
        ),
    }),
    execute: async ({ command, cwd, timeoutSeconds }, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      const run: RunOptions = {
        timeoutMs: timeoutSeconds === undefined ? defaultTimeoutMs : timeoutSeconds * 1000,
      };
      if (cwd !== undefined) run.cwd = cwd;
      const result = await shell.run(command, run);
      const stdout = truncateText(result.stdout, maxBytes);
      const stderr = truncateText(result.stderr, maxBytes);
      return {
        exitCode: result.exitCode,
        ...(result.signal === undefined ? {} : { signal: result.signal }),
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      };
    },
  });

  const krova_read_file = tool({
    description: READ_DESCRIPTION,
    inputSchema: z.object({
      path: z.string().min(1).describe("Absolute path, or relative to the home directory."),
    }),
    execute: async ({ path }, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      const data = await shell.files.read(path);
      if (data.includes(0)) {
        return { path, sizeBytes: data.length, binary: true as const };
      }
      const text = truncateText(Buffer.from(data).toString("utf8"), maxBytes);
      return {
        path,
        sizeBytes: data.length,
        binary: false as const,
        content: text.text,
        truncated: text.truncated,
      };
    },
  });

  const krova_write_file = tool({
    description: WRITE_DESCRIPTION,
    inputSchema: z.object({
      path: z.string().min(1).describe("Absolute path, or relative to the home directory."),
      content: z.string().describe("The full new content of the file."),
      createParents: z
        .boolean()
        .optional()
        .describe("Create missing parent directories first. Default true."),
    }),
    execute: async ({ path, content, createParents }, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      const dir = posix.dirname(path);
      if ((createParents ?? true) && dir !== "." && dir !== "/") {
        const made = await shell.run(["mkdir", "-p", dir], { timeoutMs: defaultTimeoutMs });
        if (made.exitCode !== 0) {
          throw new Error(
            `Could not create ${dir}: ${truncateText(made.stderr.trim(), 1024).text || `exit code ${made.exitCode}`}`,
          );
        }
      }
      await shell.files.write(path, content);
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    },
  });

  return { krova_run, krova_read_file, krova_write_file };
}

export interface CreateKrovaSandboxOptions
  extends ConnectCubeOptions,
    Omit<KrovaToolsOptions, "shell"> {
  /** A `KrovaClient`, or anything with `cubes.ssh(spaceId, cubeId)`. */
  krova: CubeSshSource;
  spaceId: string;
  cubeId: string;
}

export interface KrovaSandbox {
  tools: KrovaTools;
  /** The open connection, for code that wants to run its own commands. */
  shell: KrovaShell;
  /** Close the SSH connection. Call it when the agent is done. */
  close(): Promise<void>;
}

/** Connect to a Cube over SSH and return the tools for it, plus a `close()` for the connection. */
export async function createKrovaSandbox(
  options: CreateKrovaSandboxOptions,
): Promise<KrovaSandbox> {
  const { krova, spaceId, cubeId, maxOutputBytes, defaultTimeoutMs, ...connect } = options;
  const toolOptions: Omit<KrovaToolsOptions, "shell"> = {};
  if (maxOutputBytes !== undefined) toolOptions.maxOutputBytes = maxOutputBytes;
  if (defaultTimeoutMs !== undefined) toolOptions.defaultTimeoutMs = defaultTimeoutMs;
  // Validate before opening a connection so a bad option does not leak one.
  if (maxOutputBytes !== undefined) assertMaxOutputBytes(maxOutputBytes);
  const shell = await connectCube(krova, spaceId, cubeId, connect);
  return {
    tools: krovaTools({ shell, ...toolOptions }),
    shell,
    close: () => shell.close(),
  };
}
