# Commit Message Conventions

Codex-proxy uses Conventional Commits with a fixed type vocabulary. Several CI workflows pattern-match on the type prefix, so unknown types break automation.

## Format

```
<type>(<optional scope>): <imperative summary>

<optional body — wrap at ~72 cols, explain WHY>

<optional footer — Closes #N, Refs #N, BREAKING CHANGE: ...>
```

- Subject is **imperative mood**, lowercase first letter, no trailing period.
- Subject ≤ 72 chars hard cap.
- Body explains *why* the change was made, not *what* (the diff shows what).

## Type Vocabulary

| Type | Use for | Triggers beta release? |
|---|---|---|
| `feat` | New user-visible feature | yes |
| `fix` | Bug fix | yes |
| `perf` | Performance improvement with no behavior change | yes |
| `refactor` | Code restructuring with no behavior change | no |
| `docs` | Documentation only | no |
| `test` | Test-only changes | no |
| `chore` | Tooling, dependencies, repo housekeeping | no |
| `ci` | CI/CD configuration | no |
| `style` | Formatting, whitespace, no logic change | no |

The "Triggers beta release?" column is determined by `bump-electron-beta.yml`'s skip filter: `^(chore|docs|ci|test|refactor|style)`. Note that `fix(ci):` still triggers a beta release because the prefix is `fix`.

## Scope

Optional, but encouraged for clarity. Use the top-level module name:

- `feat(auth): ...`
- `fix(translation): ...`
- `refactor(routes): ...`
- `chore(deps): ...`
- `ci(release): ...`

Skip the scope when the change spans multiple modules or is genuinely repo-wide.

## Examples

Good:

```
feat(auth): persist account-pool RT-only imports across restarts
```

```
fix(translation): recover from previous_response_not_found instead of passing it through
```

```
refactor(routes): extract shared proxy-handler from openai/anthropic/gemini handlers
```

Bad — and why:

| Message | Why it fails |
|---|---|
| `Update auth.ts` | No type, describes WHAT not WHY |
| `feat: Added new feature.` | Past tense + capitalized + trailing period |
| `feature(auth): persist RT` | `feature` is not in the vocabulary, use `feat` |
| `fix: stuff` | Subject is meaningless |
| `wip` | No type, no information |

## Multi-line body

Use a HEREDOC to preserve formatting:

```bash
git commit -m "$(cat <<'EOF'
fix(quota): ignore stale x-codex-* headers after token refresh

The previous behavior overwrote fresh quota state with cached headers
from the old token, causing accounts to appear over-quota for ~30s
after refresh. Now we drop quota updates whose token id does not match
the current session.

Closes #418
EOF
)"
```
