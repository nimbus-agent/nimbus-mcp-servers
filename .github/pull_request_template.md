## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `bun run check` passes — lint, typecheck, the four connector audits, full suite (tests added/updated for behavior changes)
- [ ] The PR title is a Conventional Commit whose type reflects the change for semver — release-please reads the squash commit, whose subject defaults to it
- [ ] Every new mutating tool registers through `createWriteToolRegistrar` (`shared/consent-kit.ts`), and its connector's `hitlRequired` lists `write`/`delete`
- [ ] Added or renamed a tool? `bun run sync:tool-names` was run
- [ ] No new runtime dependency — or it is pure JavaScript, declared in the root `package.json` and on the `audit:connector-deps` allow-list
- [ ] No `any` (used `unknown` + a type guard for external/cross-boundary data)
- [ ] A connector that should also be indexed has its sync half in [nimbus-agent/Nimbus](https://github.com/nimbus-agent/Nimbus)
