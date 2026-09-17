# Contributing to krova-node

Thanks for your interest in improving the Krova Cloud libraries! This is the
**monorepo** for every official Node.js/TypeScript package. This document explains
how to get set up, the conventions we follow, and how releases work.

## Getting started

```sh
git clone https://github.com/krovacloud/krova-node.git
cd krova-node
pnpm install    # installs the whole workspace
pnpm -r build   # build every package
pnpm -r test    # test every package
```

Requirements: **Node.js 20+** and [pnpm](https://pnpm.io/) (the version is pinned
via the root `packageManager` field — `corepack enable` will use it automatically).

## Repository layout

This is a single [pnpm workspace](https://pnpm.io/workspaces). Each published
package lives under `packages/*`:

| Path | Package | What it is |
| --- | --- | --- |
| `packages/sdk` | `@krovacloud/sdk` | The Krova Cloud API client for Node.js. |
| `packages/cli` | `@krovacloud/cli` | The `krova` command-line tool (pure TypeScript). |
| `packages/mcp` | `@krovacloud/mcp` | Model Context Protocol server for Krova. |
| `packages/webhook` | `@krovacloud/webhook` | Webhook signature verification + types. |
| `packages/n8n-node` | `n8n-nodes-krova` | The Krova node for n8n. |

Supporting files:

- `scripts/release.mjs` — the automated per-package release script (see below).
- `.github/workflows/ci-release.yml` — CI (build + test on every push/PR) and the
  release step (publish changed packages on push to `main`).

Internal dependencies between packages use the `workspace:*` protocol; pnpm
rewrites them to the real published version at publish time.

## Workflow

1. Branch off `main` (do not commit directly to `main` — it is protected).
2. Make your change in the relevant `packages/*` directory.
3. Update that package's `CHANGELOG.md` and its `README.md` if the public surface
   changed.
4. Run the full check before opening a PR:

   ```sh
   pnpm -r build
   pnpm -r test
   ```

   Both must pass. New behavior needs matching tests — including failure paths,
   not just the happy path. You can scope work to one package with
   `pnpm --filter @krovacloud/<name> <script>`.
5. Open a pull request. The `ci` check must be green and conversations resolved
   before it can merge.

## The SDK's types are generated — never edit them by hand

`packages/sdk/src/generated/types.ts` is produced by `openapi-typescript` from
`packages/sdk/openapi.json`, which is itself a snapshot of the spec Krova Cloud
serves at `https://krova.cloud/api/v1/openapi.json`. Two checks keep the three
in agreement, and both are part of `ci`:

- `packages/sdk/tests/generated-types-match-spec.test.ts` regenerates from the
  committed snapshot and fails if the committed types differ. No network.
- `pnpm check:openapi-drift` fetches the live spec and fails if the snapshot no
  longer matches it. It exits `1` on drift and `2` when the spec is unreachable,
  so "could not check" is never reported as "checked and fine".

When the API changes, refresh both in one step:

```sh
pnpm check:openapi-drift -- --write     # pull the live spec into the snapshot
pnpm --filter @krovacloud/sdk gen       # regenerate the types
```

Both the check and `--write` read production by default. Set `KROVA_API_BASE`
to point them at a staging deployment or a local dev server while an API change
is still in flight:

```sh
KROVA_API_BASE=http://localhost:3000 pnpm check:openapi-drift
```

⛔ That override is for working on the API. Never put it in the SDK's README or
anywhere else a consumer reads — `KrovaClient`'s own `baseUrl` option is the
supported way for a caller to point somewhere else, and the default is the only
base a customer should ever need to think about.

Commit the snapshot and the regenerated types together. If a hand-written
helper in `src/client.ts` stops compiling afterwards, that is the point — the
API contract moved and the SDK was describing the old one.

⛔ **If the live spec is missing an endpoint that exists in production, fix the
spec in the API, not the snapshot here.** Editing `openapi.json` by hand is what
made `TcpMapping.host` ship as a required field the API does not always send.

## Conventions

- **TypeScript strict**, ESM-first, Node ≥20.
- Conventional-ish commit subjects (e.g. `feat:`, `fix:`, `docs:`, `chore:`).
- Never hardcode an internal dependency version or link to a package's old
  standalone repo — those were consolidated here. Use `workspace:*`.
- Keep changes surgical and scoped to a single package where possible; never mix
  unrelated packages in one PR.

## How releases work

Releases are **fully automated** on merge to `main` — you do **not** bump versions
or publish by hand:

1. `scripts/release.mjs` inspects each package and compares its published surface
   against the last release tag (`<name>@<version>`). Changes to tests, tooling
   config, or `.github/` do **not** count — only the code and docs that ship to
   npm.
2. For each **changed** package it computes the next version: a **patch bump** from
   the current npm-latest, unless `package.json` already declares a higher version
   (set a minor/major there in your PR when you need one).
3. It publishes with **npm provenance** (via GitHub OIDC — this repo is public and
   the workflow has `id-token: write`), creates the git tag, and cuts a GitHub
   Release.

So: to ship a **patch**, just merge your change. To ship a **minor/major**, set the
target version in that package's `package.json` in your PR, and note it in the PR
"Release note" section.

## Reporting bugs & requesting features

Please use the GitHub issue templates. For security issues, do **not** open a
public issue — see [SECURITY.md](./SECURITY.md).

## Code of conduct

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).
