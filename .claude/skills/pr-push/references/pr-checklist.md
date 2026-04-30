# Pre-PR Self-Check

Walk this list before opening the PR. Anything left unchecked needs a written reason in the PR body.

## Branch & target

- [ ] Current branch is NOT `dev`, `master`, or `main`
- [ ] Branch is rebased on (or fast-forwardable to) `origin/dev`
- [ ] PR target = `dev`

## Commit hygiene

- [ ] Each commit follows `<type>(<scope>): <summary>` with a vocabulary type (see `commit-conventions.md`)
- [ ] No commit was created with `--no-verify`
- [ ] No file added with `git add -f`
- [ ] No accidental staging of `node_modules/`, `dist/`, `*.log`, `.env*`, `data/`, or other gitignored paths
- [ ] No secrets in code or commit messages (API keys, tokens, cookies, oauth_state)

## CHANGELOG

- [ ] If the change touches `src/`, `shared/`, `web/`, `packages/`, `native/`, `config/`, or `.github/workflows/` → `CHANGELOG.md` `[Unreleased]` has a new entry
- [ ] Entry placed in correct subsection (Added / Changed / Fixed)
- [ ] Entry references the issue / PR number when applicable

## Cross-artifact impact

Codex-proxy ships three artifacts: backend (Docker), Electron desktop, web frontend. The pre-push hook will catch most of these, but verify mentally first:

- [ ] If `src/` changed → backend logic still passes `npm test`
- [ ] If `web/` changed → `npm run build` produces a clean Vite bundle
- [ ] If `Dockerfile` / `docker-compose*` changed → image still builds
- [ ] If `packages/electron/**` or `electron-builder.yml` changed → Electron config validates
- [ ] If `native/**` changed → native addon still builds

## Tests

- [ ] New behavior has new tests (TDD: tests written first when feasible)
- [ ] All affected `npm test` suites pass locally
- [ ] No `*.skip` left behind unless explicitly justified in the PR body

## TypeScript

- [ ] No `any`, `as any`, `: any`, or `<any>` in new code (use `unknown`, generics, or specific types)
- [ ] No `@ts-ignore` / `@ts-expect-error` without an inline explanation comment

## Real-upstream changes

- [ ] If the change touches the upstream protocol (translation/, proxy/, auth/), `npm run test:real` was attempted at least once

## Documentation

- [ ] Public-facing config/flag changes are reflected in `config/default.yaml` comments and `CLAUDE.md` if relevant
- [ ] No internal personal notes leaked into committed files

## After push (do NOT do these in this skill)

- [ ] Wait for CI green before requesting review
- [ ] Merge is a separate, explicit decision — never auto-merge from this skill
