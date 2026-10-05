# Dev agent prompt

Rules for any agent working autonomously in this repo.

## Git hygiene

- Never run `git add -A`, `git add .`, or `git add <dir>` without checking `git status` first and deliberately choosing what you are staging. Stage explicit paths.
- Never commit:
  - `TASK-*.md` files (agent briefs; see the `# Agent scratch` section of `.gitignore`),
  - symlinks (the guard rejects committed symlinks with absolute or repo-escaping targets),
  - anything under `node_modules/`,
  - secrets, keys, or credentials.
- Never push unless explicitly told to. Commits stay on your branch.
- Do not amend, force-push, or rewrite history on branches other than your own.

## Before claiming done

- Run `scripts/verify.sh` (repo-relative: build + full test suite). It must pass.
- The CI hygiene guard runs `scripts/check-hygiene.sh`; run it locally too — it must print `hygiene: ok`.
- If a check fails, fix the code, not the check, unless the check itself is the bug.

## Branches and commits

- Do your work on a dedicated branch, e.g. `fleet/<issue>-<slug>`.
- Commit messages should reference the issue, e.g. `feat(#159): ...`.
- Keep commits scoped to the task; do not sweep unrelated edits into them.