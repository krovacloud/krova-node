---
name: Bug report
about: Report a problem with a Krova Cloud package (SDK, CLI, MCP, webhook, n8n)
title: "[Bug]: "
labels: bug
assignees: ""
---

## Which package?

<!-- Tick the one this bug is about. -->

- [ ] `@krovacloud/sdk`
- [ ] `@krovacloud/cli`
- [ ] `@krovacloud/mcp`
- [ ] `@krovacloud/webhook`
- [ ] `n8n-nodes-krova`

## Describe the bug

A clear and concise description of what the bug is.

## To reproduce

Minimal steps or a code snippet that triggers the issue (please redact any secrets):

```ts
// ...
```

For the CLI, include the exact command you ran (e.g. `krova cubes list --json`).

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include the full error / stack trace if there is one. If a
`KrovaError` was thrown, include its `status`, `code`, and `requestId`.

## Environment

- Package + version (e.g. `@krovacloud/cli@0.4.1`):
- Node.js version (`node --version`):
- Package manager (pnpm/npm/yarn) + version:
- OS:

## Additional context

Anything else that might help.
