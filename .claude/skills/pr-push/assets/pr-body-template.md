<!--
PR body template for codex-proxy. The skill fills in the {{placeholders}}
and removes optional sections that don't apply. Default language follows
the repo's dominant language (currently zh-CN for CHANGELOG entries,
en for code/commits). Pick one and stay consistent within a single PR.
-->

## Summary

{{One paragraph: WHAT changed and WHY. Reference the user-visible impact.
If multiple commits, summarize the branch's intent, not each commit.}}

## Changes

{{Bulleted list mirroring the CHANGELOG entry. Group by area when the PR
touches multiple modules. Reference file paths so reviewers can navigate.}}

- {{change 1 — files}}
- {{change 2 — files}}

## Test Plan

{{List the commands actually run locally. Do not invent results.
Mark checked items with [x], unchecked with [ ].}}

- [ ] `npm test`
- [ ] `npm run build`
- [ ] {{any feature-specific manual verification, e.g. "Verified Dashboard 用量页 cache hit card renders with mock data"}}
- [ ] {{`npm run test:real` if the change touches upstream protocol}}

## Notes

{{Optional. Use for any of:
 - Reviewer attention requests ("please double-check the SSE buffer math in src/...")
 - Known follow-ups ("memory entry for new RT format will land in a separate PR")
 - Migration / config impact ("operators must add `update.allow_prerelease` if they want beta")
 - Screenshots for UI changes
Remove this section if there are no notes.}}

## Linked Issues

{{Closes #N / Refs #N — remove if none.}}
