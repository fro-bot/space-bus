---
title: Template CI from the org's own repos, not adjacent personal repos
date: 2026-07-04
category: workflow-issues
module: space-bus
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - bootstrapping workflows, renovate config, or repo settings for a new repo in an org
  - copying CI conventions from a "similar" repo
symptoms:
  - workflows referenced the wrong renovate preset, prompt structure, and secrets naming
  - repo settings diverged from org conventions (description style, review requirements, job names)
tags: [ci, workflows, templates, org-conventions, renovate, repo-settings]
---

# Template CI from the org's own repos, not adjacent personal repos

## Context

Bootstrapping this repo's CI, the workflows were templated from a structurally similar personal-account plugin repo instead of the org's own repos. The files were internally consistent and passed actionlint — and were still wrong: renovate extended the personal preset instead of the org's, the review workflow carried a stale action pin, prompt sections, and provider inputs the org had dropped, and settings.yml missed the org's required-review block and naming conventions. A full correction round followed.

## Guidance

When creating `.github/` surface for a repo in an org:

1. Enumerate the conventions from two or three of the **org's own active repos** — workflow inventory, action pins, secrets names, reusable-workflow targets, settings/branch-protection shape, renovate `extends`.
2. Use a repo outside the org only for what the org genuinely lacks (e.g. this org had no npm-package release workflow — the changesets/OIDC release shape legitimately came from the personal plugin repo).
3. Treat these as org-identity markers that must come from the org: renovate preset (`extends: ['github>fro-bot/.github']`), review-bot workflow inputs/secrets/pins, `settings.yml` `_extends` + review requirements, CODEOWNERS, description/naming style.
4. When correcting, ask the operator about genuinely ambiguous choices (secret names actually provisioned, action pin generation, required-context lists) instead of assuming — the answers are cheap and wrong guesses each cost a review round.

## Why This Matters

Convention drift in CI is invisible to every automated gate — YAML lints, actionlint, and even the review bot (which reads the diff, not the org) all pass. The divergence surfaces later as broken automation (wrong preset, wrong secrets) or as org-inconsistency the operator has to hunt down file by file.

## When to Apply

Any new repo joining an existing org or account family with established automation, or any wholesale import of workflow files between repos with different owners.

## Examples

The correction delta for this repo: renovate `extends` swapped to the org preset, review workflow rebuilt on the org's current template (pin, inputs, secrets, prompt sections), `settings.yml` gained the org's `required_pull_request_reviews` block + CODEOWNERS, CI job renamed to the org's convention, descriptions de-prefixed.
