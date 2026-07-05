## Summary

<!-- What does this PR change and why? -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation / tooling only

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm build` passes (ESM + CJS + `.d.ts` emitted)
- [ ] `pnpm test` passes, and I added/updated tests for this change
- [ ] No new runtime dependencies were added (still `node:crypto`-only)
- [ ] The security guarantees (constant-time compare, timestamp tolerance) are
      preserved
- [ ] Updated `CHANGELOG.md` if this is a user-facing change

## Notes for reviewers

<!-- Anything reviewers should pay special attention to. -->
