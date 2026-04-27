---
name: issue-create
description: >-
  Interview the user to gather all required context, then open a high-quality GitHub issue (`gh issue create`) on the codex-proxy repo with the right template, labels, and structured body.
  TRIGGER when: user says "open an issue", "file an issue", "create issue", "report a bug", "feature request", "提个 issue", "报 bug", "提需求".
  DO NOT TRIGGER when: user wants to view, search, comment on, or close existing issues (use `gh issue list/view/comment/close` directly); user is writing a PR description (use `pr-push`).
allowed-tools:
  - "Bash"
  - "Read"
  - "Write"
---

# Issue Create

Gather complete context through a structured interview, then file a well-formed issue. The interview is a hard gate — vague issues waste maintainer time.

## Overview

Most "I have a bug" or "I want a feature" reports are missing the information a maintainer needs to act. This skill runs a four-phase interview, fills the appropriate template, applies the right labels, and only then calls `gh issue create`. The user sees and approves the rendered body before submission.

## When to Use

- A user wants to file a new issue on the codex-proxy repository.
- A user describes a bug or feature in conversation and asks "should we file an issue?"

## Important Rules

1. **The interview is not optional.** Do NOT call `gh issue create` until all required fields for the chosen type are collected and the user has explicitly approved the rendered body.
2. **Never invent reproduction steps, version numbers, log output, or behavior.** If the user did not provide it, ask. If they cannot provide it, write "not provided" in the field, do not fabricate.
3. **Show the full body before submitting.** The user must explicitly say "submit" / "looks good" / equivalent. "Yes" without seeing the body is not enough — show it first.
4. **Apply only labels from the project's existing label set.** Read `references/labels.md` for the catalog. Do not invent new labels.
5. **Strip secrets.** If the user pastes logs, headers, or config that contain tokens, cookies, OAuth state, API keys, or account IDs, redact them before they enter the issue body. Replace with `<redacted>`.
6. **One issue per scope.** If the user describes two unrelated problems, file two issues. Ask before splitting.

## Key Workflows

### Phase 1: Type classification

**Goal:** Pick the right template and label.

Ask the user (one consolidated question):

> What type of issue is this?
>   1. **Bug** — something is broken or behaves incorrectly
>   2. **Feature request** — propose new functionality
>   3. **Question** — usage / configuration / "is this expected?"
>   4. **Performance** — measurable regression or slowness
>   5. **Documentation** — docs are wrong, missing, or unclear

Read the type spec:
```
Read: .claude/skills/issue-create/references/issue-types.md
```

Map answer to template path:

| Type | Template asset | Default label |
|---|---|---|
| Bug | `assets/bug-report.md` | `bug` |
| Feature request | `assets/feature-request.md` | `enhancement` |
| Question | `assets/question.md` | `question` |
| Performance | `assets/perf-report.md` | `bug` |
| Documentation | `assets/feature-request.md` (with docs framing) | `documentation` |

Do **NOT** proceed to Phase 2 until the type is confirmed.

### Phase 2: Required-field interview

**Goal:** Collect every field the chosen template requires.

Read `references/issue-types.md` to see the required-field table for the chosen type. Ask for missing fields in **one consolidated message**, not one at a time. Group related fields together.

**For bugs**, the required fields are:
- One-line summary
- Expected behavior
- Actual behavior
- Reproduction steps (numbered)
- Codex-proxy version (`npm pkg get version` or app About dialog)
- Deployment mode (Electron app / Docker / `npm start` / dev)
- Relevant log lines (redact secrets)
- Frequency (always / intermittent / once)

**For feature requests**, the required fields are:
- Problem the feature solves (user-facing motivation, not the proposed solution)
- Proposed solution (high level)
- Alternatives considered
- Who benefits (single user / all users / specific deployment mode)

**For questions**:
- What you tried
- What you expected
- What happened
- Relevant config (redact secrets)

**For performance**:
- All bug fields, plus:
- Measured baseline vs current (timings, memory, request count — be specific)
- Reproduction harness (script, steps, or `tests/bench/`)

**For documentation**:
- Which doc page / file
- What is wrong or missing
- Suggested fix (if any)

If a field cannot be answered, the user must explicitly say "not applicable" or "unknown" — record that verbatim. Do not silently skip.

Do **NOT** proceed to Phase 3 until every required field has either an answer or an explicit "not applicable".

### Phase 3: Code & related-context grounding

**Goal:** Help maintainers find the relevant code fast.

Ask the user for:
- File paths or `file:line` references they suspect are involved (optional but encouraged).
- Related issues / PRs to link (`Refs #N`, `Related to #N`).
- Whether they tried searching existing issues (`gh issue list --search "<keywords>"`). If they have not and the report sounds like something that might exist, run the search and show top 3 matches before continuing.

If the user provides no code locations and the bug is concrete, optionally offer:
> "Want me to grep for the relevant code so we can include file:line in the issue?"

Do not grep silently — ask first, and only do it once.

### Phase 4: Render, confirm, submit

**Goal:** Show the final body, get explicit approval, file the issue.

1. Read the chosen template:
   ```
   Read: .claude/skills/issue-create/assets/<template>.md
   ```
2. Read the labels catalog:
   ```
   Read: .claude/skills/issue-create/references/labels.md
   ```
3. Fill the template with the collected fields. Strip secrets per Important Rule #5.
4. Pick labels:
   - Always include the type label (Phase 1 mapping).
   - Add `good first issue` only if the user explicitly says it qualifies (small scope, low context required).
   - Add `help wanted` if the user has no plan to fix it themselves.
   - Add `documentation` in addition to the type label if docs need updating.
5. Show the user the complete rendered output:
   ```
   Title: <title>
   Labels: <label1>, <label2>
   Body:
   <full body>
   ```
6. Ask: "Ready to submit, or want to adjust anything?"
7. Wait for an explicit affirmative. "Yes", "submit", "go", "looks good", "提交" all qualify. Silence or hedging does not.
8. Submit:
   ```bash
   gh issue create \
     --title "<title>" \
     --label "<label1>,<label2>" \
     --body "$(cat <<'EOF'
   <body>
   EOF
   )"
   ```
9. Print the issue URL.
10. **STOP.** Do not assign, do not comment, do not link to projects unless the user issues a separate, explicit command.

## Common Pitfalls

- Do not call `gh issue create` before showing the body for approval.
- Do not invent reproduction steps when the user gave a vague report — ask.
- Do not paste raw logs that contain tokens / cookies / OAuth state / account IDs.
- Do not apply labels outside the existing catalog.
- Do not file two issues from one report without confirming the split with the user.
- Do not grep / search the codebase silently to "fill in" missing fields — ask first.
