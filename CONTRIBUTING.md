# Contributing to @krovacloud/sdk

Thanks for your interest in improving the Krova Cloud SDK! This document explains how to get set up and the conventions we follow.

## Getting started

```sh
git clone https://github.com/krovacloud/krova-js.git
cd krova-js
pnpm install
```

Requirements: Node.js 18+ and [pnpm](https://pnpm.io/).

## Project layout

- `openapi.json` — the vendored Krova Cloud OpenAPI spec (source of truth).
- `src/generated/types.ts` — types generated from the spec (committed; regenerate with `pnpm gen`).
- `src/client.ts` — the `KrovaClient` class and ergonomic helpers.
- `src/error.ts` — `KrovaError`.
- `tests/` — `node:test` suites (no network; a local mock HTTP server is used).

## Workflow

1. Make your change.
2. If you touched endpoint shapes, update `openapi.json` and run `pnpm gen`.
3. Run the full check before opening a PR:

   ```sh
   pnpm gen        # only if the spec changed
   pnpm typecheck
   pnpm build
   pnpm test
   ```

All four must pass. New behavior needs matching tests — including failure paths, not just the happy path.

## Conventions

- **TypeScript strict**, ESM-first.
- Endpoint shapes are driven by the OpenAPI spec — do not hand-invent request/response types; regenerate from `openapi.json`.
- Keep helpers thin wrappers over `client.raw`.
- Conventional-ish commit subjects (e.g. `feat:`, `fix:`, `docs:`).

## Reporting bugs & requesting features

Please use the GitHub issue templates. For security issues, do **not** open a public issue — see [SECURITY.md](./SECURITY.md).

## Code of conduct

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).
