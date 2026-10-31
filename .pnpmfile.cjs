// ⛔ `openapi-typescript` must see TypeScript 5, and this hook is the only thing keeping `pnpm --filter @krovacloud/sdk gen` alive.
//
// It declares `"peerDependencies": { "typescript": "^5.x" }` and calls `ts.factory.createKeywordTypeNode` at module load. This repo is on typescript@7, whose JS API does not expose `ts.factory`, so the generator dies on import with `TypeError: Cannot read properties of undefined (reading 'createKeywordTypeNode')`.
//
// pnpm only WARNS on an unmet peer range, so the mismatch is invisible until someone runs the generator. `packages/sdk/tests/generated-types-match-spec.test.ts` runs it and fails if the committed `src/generated/types.ts` is stale, and `scripts/check-openapi-drift.mjs` fails CI on drift against the live spec.
//
// History: pnpm 11 honoured `overrides: { "openapi-typescript>typescript": "5.9.3" }` by turning the peer into a real dependency. pnpm 12 only rewrites the peer range and still links the importer's typescript@7, so the override stopped working and the generated-types test failed. This hook does the same job explicitly: it drops the peer and gives openapi-typescript its own typescript@5.9.3.
//
// 7.13.0 is the LATEST openapi-typescript (checked 2026-10-25) and still peers on ^5.x. Delete this file the day it supports typescript 7, and not before: `pnpm gen` and the generated-types test are the check.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "openapi-typescript" && pkg.peerDependencies && pkg.peerDependencies.typescript) {
        delete pkg.peerDependencies.typescript;
        pkg.dependencies = { ...pkg.dependencies, typescript: "5.9.3" };
      }
      return pkg;
    },
  },
};
