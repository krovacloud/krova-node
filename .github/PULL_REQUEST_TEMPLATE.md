## Summary

<!-- What does this PR change and why? Which package(s) under packages/* does it touch? -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Docs / tooling only

## Affected packages

<!-- Tick every published package this PR changes. Only ticked packages are
     re-versioned + republished by the release workflow on merge to main. -->

- [ ] `@krovacloud/sdk`
- [ ] `@krovacloud/cli`
- [ ] `@krovacloud/mcp`
- [ ] `@krovacloud/webhook`
- [ ] `n8n-nodes-krova`
- [ ] None (workspace tooling / CI / docs only)

## Checklist

- [ ] `pnpm -r build` passes.
- [ ] `pnpm -r test` passes, and I added/updated tests for this change (including failure paths where relevant).
- [ ] I updated each affected package's `CHANGELOG.md` and any relevant docs/README.
- [ ] Public API changes are reflected in the package README.
- [ ] Internal deps use `workspace:*` (never a hardcoded version or a link to a deleted repo).

## Release note

<!-- On merge to main, CI patch-bumps every changed package from the npm-latest
     version (or honors a higher version you set in package.json) and publishes
     with provenance. Note here if a package needs a minor/major bump instead of
     the default patch — set that version in its package.json in this PR. -->

## Related issues

<!-- e.g. Closes #123 -->
