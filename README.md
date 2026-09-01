# krova-node

The single home for the [Krova Cloud](https://krova.cloud) **JavaScript / TypeScript** packages — SDK,
CLI, MCP server, webhook verifier, and the n8n node. A pnpm-workspace monorepo:
the CLI/MCP consume the SDK via `workspace:*`, so everything stays in sync and a
cross-package change is one PR.

| Package | npm | What it is |
| --- | --- | --- |
| [`packages/sdk`](packages/sdk) | [`@krovacloud/sdk`](https://www.npmjs.com/package/@krovacloud/sdk) | Typed TypeScript SDK for the Krova Cloud API |
| [`packages/cli`](packages/cli) | [`@krovacloud/cli`](https://www.npmjs.com/package/@krovacloud/cli) | The `krova` CLI (pure Node — built on the SDK) |
| [`packages/mcp`](packages/mcp) | [`@krovacloud/mcp`](https://www.npmjs.com/package/@krovacloud/mcp) | MCP server for Claude/Cursor/etc. |
| [`packages/webhook`](packages/webhook) | [`@krovacloud/webhook`](https://www.npmjs.com/package/@krovacloud/webhook) | Outbound-webhook signature verification |
| [`packages/n8n-node`](packages/n8n-node) | [`@krovacloud/n8n-nodes-krova`](https://www.npmjs.com/package/@krovacloud/n8n-nodes-krova) | n8n community node |

## Develop

```sh
pnpm install
pnpm -r build      # topological — the SDK builds before its consumers
pnpm -r test
pnpm -r typecheck
```

## Releasing (automatic, no manual version bumps)

Every push to `main` runs [`scripts/release.mjs`](scripts/release.mjs): for each
package that **changed since its last release tag**, it patch-increments the
latest version on npm, publishes it (with provenance), and records a
`<name>@<version>` git tag + GitHub release. Unchanged packages are skipped.
An explicit higher version in a package's `package.json` is honored as-is.

Publishing uses npm **trusted publishing (OIDC)** — the release workflow has
`id-token: write` and runs `pnpm publish --provenance`, so **no `NPM_TOKEN`** (or
any long-lived npm token) is required. See "How releases work" in
[CONTRIBUTING.md](./CONTRIBUTING.md).
