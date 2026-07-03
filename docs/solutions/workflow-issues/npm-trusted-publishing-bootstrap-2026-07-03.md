---
title: npm trusted publishing requires a bootstrap publish for new packages
date: 2026-07-03
category: workflow-issues
module: space-bus
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - publishing a brand-new npm package through GitHub Actions OIDC trusted publishing
  - migrating a package from token-based publishing to trusted publishing
  - setting up changesets-driven releases with provenance
tags: [npm, trusted-publishing, oidc, provenance, changesets, release-workflow, bootstrap]
---

# npm trusted publishing requires a bootstrap publish for new packages

## Context

Trusted publishers are package-scoped settings on npmjs.com — and the package must already exist before one can be configured. A repo can ship a perfect OIDC release workflow and still have no way to complete its first publish through CI. Hit while setting up `@fro.bot/space-bus`.

## Guidance

Bootstrap sequence for a new package (operator steps in order):

1. Land the initial changeset in the repo *before* bootstrapping, so the first CI release PR carries a real version bump.
2. Manually `npm publish` a placeholder version (we used `0.0.0`) as a maintainer — 2FA or granular token; this is the only token-based publish the package ever needs.
3. On the package's npmjs.com settings, configure the trusted publisher: owner, repo, and the workflow **filename exactly** (`release.yaml` — filename only, no path, `.yml`/`.yaml` sensitive, case-sensitive).
4. Merge the changesets version PR; the second release flows through CI OIDC and satisfies the real acceptance check.

Workflow requirements (verified on the `0.1.0` release):

```yaml
on:
  workflow_dispatch:
  workflow_run:
    workflows: [CI]
    branches: [main]        # fork PRs never reach the publish job
    types: [completed]
jobs:
  release:
    if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'
    permissions:
      contents: write
      id-token: write       # the OIDC credential
      pull-requests: write
    steps:
      # ...app token, git user, checkout, setup-node with registry-url...
      - name: Upgrade npm for OIDC trusted publishing
        run: npm install -g npm@11.18.0   # OIDC publish needs npm >= 11.5.1; runner default may be older
      # changesets/action with version/publish commands
```

- **No `NPM_TOKEN` anywhere.** A leftover token or auth `.npmrc` makes npm skip OIDC.
- **No `--provenance` flag and no `publishConfig.provenance`.** Trusted publishing auto-generates provenance; the explicit flag is for the token path.
- `changesets/action` needs no special OIDC support — it just runs the publish script; the job's `id-token: write` + new-enough npm do the work.

## Why This Matters

The chicken-and-egg is invisible until the first release fails: nothing in the workflow, npm docs snippets, or changesets setup warns that the trusted publisher config screen doesn't exist for an unpublished package. Planning the bootstrap as an explicit manual step (and deferring the "publishes via OIDC" acceptance check to the *second* release) avoids a stalled release day.

## When to Apply

- First release of any new npm package that will use trusted publishing.
- Auditing a release pipeline: if a package claims OIDC publishing, its first version was either token-published or the trusted publisher was configured between releases.

## Examples

Verified outcome for `@fro.bot/space-bus`: `0.0.0` manual bootstrap → trusted publisher configured → `0.1.0` published by CI with SLSA provenance attestations (`predicateType: https://slsa.dev/provenance/v1`) and no npm token in the repo.

## Related

- `opencode-copilot-delegate/docs/solutions/workflow-issues/bootstrap-missing-github-release-2026-04-26.md` — same chicken-and-egg discovered on that package; this doc adds the current npm version floor, provenance auto-generation, and changesets mechanics.
- `fro-bot/agent/docs/solutions/best-practices/reusable-workflow-permissions-replace-not-merge-2026-07-01.md` — `id-token: write` permission-block gotcha that can break the same pipeline.
