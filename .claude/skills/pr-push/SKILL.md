---
name: pr-push
description: >-
  Package the current working changes into a standards-compliant codex-proxy pull request:
  branch hygiene, commit message linting, CHANGELOG prompt, conventional commit, push, and `gh pr create` against the `dev` branch.
  TRIGGER when: user asks to "push a PR", "open a PR", "create PR", "ship this", "推 PR", "开 PR", "提交 PR".
  DO NOT TRIGGER when: user only wants to commit without pushing; user explicitly wants to push directly to master/main; user wants to merge, rebase, or close an existing PR (use `gh pr merge` / `gh pr close` directly).
allowed-tools:
  - "Bash"
  - "Read"
  - "Edit"
  - "Write"
  - "Grep"
---

# PR Push

Turn the current working tree into a clean PR targeting `dev`. This skill enforces codex-proxy's contribution rules so community maintainers do not have to memorize them.

## Overview

Codex-proxy uses a `dev` → `master` promotion flow with strict commit conventions, CHANGELOG discipline, and a pre-push validation hook. This skill walks the maintainer through an interview, makes the commit, runs the push (letting the hook gate quality), and opens the PR. It explicitly stops before merge — review and merge are separate human decisions.

## When to Use

- A maintainer has finished a unit of work in their working tree and wants it on `dev`.
- A maintainer asks to "open a PR" or equivalent and the working tree has changes (staged, unstaged, or untracked).

## Important Rules

1. **Target branch is always `dev`.** Never open a PR against `master` or `main` unless the user explicitly states "target master" with a written reason. The `master` branch is fast-forwarded by the `promote-dev-to-master.yml` workflow — manual PRs to `master` break that contract.
2. **Never commit on `dev`, `master`, or `main` directly.** If `git branch --show-current` is one of these, stop and ask the user to name a feature branch (`git switch -c <name>`).
3. **Never use `git add -A`, `git add .`, or `git add -f`.** Stage files by explicit path. `-f` overrides `.gitignore` and has been the cause of secret leaks elsewhere.
4. **Never pass `--no-verify` to `git commit` or `git push`.** The hook is the gate. If it fails, fix the underlying issue, do not bypass.
5. **Stop after `gh pr create`.** Do not merge, do not approve, do not enable auto-merge. Pushing a PR and merging a PR are two human decisions.
6. **CHANGELOG gate.** If any file under `src/`, `web/`, `packages/`, `native/`, `config/`, or `.github/workflows/` changed, `CHANGELOG.md`'s `[Unreleased]` section MUST have a new entry covering the change before the commit is created.
7. **Commit message format is fixed:** `<type>(<optional-scope>): <imperative summary>`. The type set is enumerated in `references/commit-conventions.md`.

## Key Workflows

### Phase 1: Discovery (interview, do not touch the repo yet)

**Goal:** Understand what is being shipped before any git operation.

Run these read-only commands in parallel and summarize results back to the user:

```
git branch --show-current
git status --short
git diff --stat
git log --oneline -10
```

Then read the conventions:
```
Read: .claude/skills/pr-push/references/commit-conventions.md
Read: .claude/skills/pr-push/references/changelog-format.md
Read: .claude/skills/pr-push/references/pr-checklist.md
```

Ask the user (in one consolidated message) for any field that cannot be inferred:

- **Commit type** (feat / fix / refactor / docs / test / chore / perf / ci) — propose one based on the diff, ask for confirmation.
- **One-line summary** (imperative, lowercase, no trailing period) — propose one based on the diff.
- **PR target** — default `dev`. Confirm only if the user previously asked to deviate.
- **CHANGELOG entry** — if the gate in Important Rules #6 applies and `CHANGELOG.md` `[Unreleased]` has no matching entry, ask the user to dictate one (or offer to draft one for review). Do not invent silently.
- **Memory / docs touch** — if the change touches public protocol, request flow, auth lifecycle, or release infra, ask whether `CLAUDE.md` needs updating in the same PR.

Do **NOT** proceed to Phase 2 until the user has explicitly confirmed (a) commit type, (b) summary, (c) CHANGELOG status, (d) target = `dev`.

### Phase 2: Branch hygiene

**Goal:** Make sure the commit lands on a feature branch, not on `dev`/`master`.

1. Check `git branch --show-current`.
2. If the current branch is `dev`, `master`, or `main`:
   - Stop. Ask the user to provide a feature branch name (suggest one derived from the commit summary, kebab-case, ≤40 chars).
   - Run `git switch -c <name>`. Do not auto-pick a name without confirmation.
3. If the current branch is a feature branch but is not based on up-to-date `origin/dev`:
   - Run `git fetch origin dev`.
   - If `git merge-base --is-ancestor origin/dev HEAD` is false (branch is behind), warn the user and ask whether to `git rebase origin/dev` before continuing. Do not rebase silently.

### Phase 3: Stage + commit

**Goal:** Produce one well-formed commit.

1. List the files the user wants in this commit. If they didn't say, propose the list from `git status --short` and confirm.
2. Run `git add <file1> <file2> ...` with explicit paths. Never `-A`, `.`, or `-f`.
3. If CHANGELOG was updated as part of Phase 1, include `CHANGELOG.md` in the staged set.
4. Build the commit message:
   - First line: `<type>(<scope>): <summary>` — scope is optional, omit parentheses if no scope.
   - Body (optional): wrap at ~72 cols, explain *why*, reference issues with `Closes #N` / `Refs #N` if applicable.
5. Commit with a HEREDOC (preserves formatting):
   ```bash
   git commit -m "$(cat <<'EOF'
   <type>(<scope>): <summary>

   <optional body>
   EOF
   )"
   ```
6. If the commit fails because of a pre-commit hook, fix the reported issue and create a NEW commit (do not `--amend`). Re-run the same command after fixes.

### Phase 4: Push

**Goal:** Get the branch to `origin` so a PR can be opened.

1. Confirm the user wants to push (a single short "ready to push?" — they may have wanted to inspect the commit first).
2. **Hook presence check.** The repo's pre-push gate lives at `.claude/hooks/pre-push-validate.sh`, which is gitignored — fresh clones do **not** have it. Run `test -x .claude/hooks/pre-push-validate.sh`:
   - **Hook present** → push normally; the hook will run.
   - **Hook missing** → warn the user that no pre-push gate is installed, then run the equivalent checks inline based on what the diff touched, before pushing:
     | Diff touches | Run |
     |---|---|
     | `src/**` or `tests/**` | `npm test` and `npx tsc --noEmit` |
     | `web/**` | `npm run build` |
     | `Dockerfile`, `docker-compose*` | `docker build .` (or note user must verify) |
     | `packages/electron/**`, `electron-builder.yml` | `npm run -w packages/electron build` |
     | `native/**` | `npm run -w native build` |
     Any failure aborts the push — fix and re-run.
3. Run `git push -u origin HEAD`.
4. If the push is blocked by the hook:
   - Read the hook output verbatim back to the user.
   - The hook validates the build targets affected by the diff (test, tsc, web build, Dockerfile lint, Electron config, native addon). Identify which target failed and propose a fix.
   - **Never retry with `--no-verify`.** Re-run the offending check locally, fix the root cause, amend the commit only if the user authorizes it, otherwise add a fix-up commit.

### Phase 5: Open the PR

**Goal:** Create a PR against `dev` with a body that future reviewers can read cold.

1. Read the PR body template:
   ```
   Read: .claude/skills/pr-push/assets/pr-body-template.md
   ```
2. Determine PR title:
   - If the branch has a single commit, reuse the commit subject.
   - If multiple commits, propose a title that summarizes the branch's intent and confirm with user.
   - Title MUST start with a conventional type, MUST be ≤72 chars.
3. Fill the body sections (Summary / Test Plan / Notes). Source content from:
   - `git log <base>..HEAD` for the change list.
   - The CHANGELOG entry the user wrote.
   - Test commands actually run locally (do not invent test results).
4. Show the rendered title + body to the user. **Wait for explicit "looks good" before invoking `gh`.**
5. Create the PR:
   ```bash
   gh pr create --base dev --title "<title>" --body "$(cat <<'EOF'
   <body>
   EOF
   )"
   ```
6. Print the PR URL.
7. **STOP.** Do not run `gh pr merge`, `gh pr review --approve`, `gh pr edit --add-label`, or `--auto-merge` unless the user issues a separate, explicit command.

## Common Pitfalls

- Do not assume the user wants every modified file in the PR — ask.
- Do not auto-write the CHANGELOG entry without showing it for approval first.
- Do not retry a failing pre-push hook with `--no-verify`.
- Do not open the PR against `master` even if the user is on a branch named `master-fix-X` — branch name does not imply target.
- Do not silently rebase. If the branch needs rebase against `origin/dev`, ask first.
- Do not chain `gh pr create` with `gh pr merge`. Two separate decisions.
