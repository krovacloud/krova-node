---
name: Bug report
about: Report a problem with @krovacloud/sdk
title: "[Bug]: "
labels: bug
assignees: ""
---

## Describe the bug

A clear and concise description of what the bug is.

## To reproduce

A minimal code snippet that triggers the issue:

```ts
import { KrovaClient } from "@krovacloud/sdk";

// ...
```

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include the full error / stack trace if there is one. If a `KrovaError` was thrown, include its `status`, `code`, and `requestId` (please redact any secrets).

## Environment

- `@krovacloud/sdk` version:
- Node.js version:
- Package manager (pnpm/npm/yarn) + version:
- OS:

## Additional context

Anything else that might help — e.g. whether you were using an ergonomic helper or `client.raw`.
