# @krovacloud/ai-sdk

Tools for the [Vercel AI SDK](https://ai-sdk.dev) that let an agent use a [Krova Cube](https://krova.cloud) as its sandbox: run a command, read a file and write a file, over SSH. Built on `connectCube` from [`@krovacloud/sdk/ssh`](../sdk).

## Install

```sh
npm install @krovacloud/ai-sdk @krovacloud/sdk ai zod
```

Needs Node 22 or newer, `ai` 7 and `zod` 3.25.76 or 4.1.8 or newer. The Cube must already be running, and the public half of `privateKey` must be in its `authorized_keys`.

## Use

```ts
import { KrovaClient } from "@krovacloud/sdk";
import { createKrovaSandbox } from "@krovacloud/ai-sdk";
import { generateText, isStepCount } from "ai";

const krova = new KrovaClient({ apiKey: process.env.KROVA_API_KEY! });
const sandbox = await createKrovaSandbox({ krova, spaceId, cubeId, privateKey: process.env.CUBE_SSH_KEY! });
try {
  const { text } = await generateText({
    model, // any model from your AI SDK provider
    tools: sandbox.tools,
    stopWhen: isStepCount(10),
    prompt: "Write a script that prints the first 10 primes, run it, and show the output.",
  });
  console.log(text);
} finally {
  await sandbox.close();
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `krova_run` | Run a shell command. Input: `command`, optional `cwd` and `timeoutSeconds`. Returns `stdout`, `stderr`, `exitCode`, and `signal` if the command was killed. |
| `krova_read_file` | Read a text file. Binary files are reported by size, not returned. |
| `krova_write_file` | Write a text file, replacing it. Creates missing parent directories unless `createParents` is false. |

Each `krova_run` call is a fresh shell, so `cd` and exported variables do not carry over. Paths are literal: `~` and `$VAR` are not expanded.

Output is capped at 32 KB each for `stdout`, `stderr` and file content. When it is cut, the text ends with `[truncated: N more bytes omitted]` and the result has `truncated: true`. Change the cap with `maxOutputBytes`. Commands default to a 120 second timeout; change it with `defaultTimeoutMs`.

If you already hold a connection, skip `createKrovaSandbox`:

```ts
import { connectCube } from "@krovacloud/sdk/ssh";
import { krovaTools } from "@krovacloud/ai-sdk";

const shell = await connectCube(krova, spaceId, cubeId, { privateKey });
const tools = krovaTools({ shell, maxOutputBytes: 8192 });
```

## Not covered

- Creating, starting, stopping or deleting Cubes. Use the [Krova MCP server](../mcp) or the SDK for that.
- Streaming output while a command runs. `krova_run` returns once the command exits.
- Listing directories, binary files, and files larger than memory. Use `krova_run` with `ls` or `tar` for those.
- Approval prompts. The agent can run any command as the Cube's user, so give it a Cube that holds nothing you care about.
- Cubes have CPUs only. There is no GPU.

## License

MIT
