# Issue Labels (codex-proxy)

The complete catalog of labels currently defined on the repo. Apply only labels from this list — do not invent new ones. To propose a new label, file a `chore:` issue separately.

| Label | Color | Use for |
|---|---|---|
| `bug` | #d73a4a | Something isn't working as documented or intended |
| `enhancement` | #a2eeef | New feature or extension of an existing feature |
| `documentation` | #0075ca | Improvements or additions to documentation |
| `question` | #d876e3 | Further information is requested; not yet known to be a bug |
| `help wanted` | #008672 | Maintainers welcome contributors to take this on |
| `good first issue` | #7057ff | Small scope, low context required, friendly to newcomers |
| `duplicate` | #cfd3d7 | Already filed elsewhere — set after triage, not on creation |
| `invalid` | #e4e669 | Not actionable or out of scope — set after triage |
| `wontfix` | #ffffff | Acknowledged but will not be addressed — set after triage |
| `sync-conflict` | #d73a4a | `master → electron` auto-sync merge conflict — used by automation, not for human-filed issues |

## Application rules for the skill

1. **One type label minimum**: bug / enhancement / documentation / question (pick exactly one based on the issue type).
2. **`good first issue`**: only when the user explicitly confirms the scope is small AND the fix is local (single file or single module).
3. **`help wanted`**: when the reporter has no plan to send a PR themselves.
4. **`documentation`** can be combined with `bug` or `enhancement` if the change requires both code and doc updates.
5. **Never apply on creation**: `duplicate`, `invalid`, `wontfix`, `sync-conflict`. These are triage / automation labels.

## CLI form

```bash
gh issue create --label "bug,help wanted" ...
```

Multiple labels are comma-separated (no space after the comma).
