# TASK-103b (fix): per-commit secret scan — merge-resolution & root-commit bypass

## Context
A prior attempt (PR #154, branch `fleet/103b-percommit-scan`) added
`countSecretLinesInCommits` to `src/syncpolicy.ts` and wired it into
`applyPolicy` in `src/provision.ts` to scan `base..tip` commit-by-commit for
secrets. An independent adversarial review then found a REAL BYPASS:

`secretsInCommits` (via `git rev-list --no-merges base..tip` + `git diff <c>^!`)
misses two cases:
1. **Merge-resolution secret**: a secret introduced ONLY by a merge commit's
   resolution (neither parent had it). `--no-merges` excludes the merge; the net
   diff `base..tip` shows no secret. => escapes both scans and is pushed.
2. **Root-commit secret**: the range's root (parentless) commit; `commit^!`
   fails and the failure is swallowed by `.catch(() => "")`.

The in-code comment claiming "the per-parent scan of the others still covers
added lines" is FALSE for a merge resolution that adds lines neither parent had.

## Required change
Fix the per-commit scan so BOTH cases are covered:
- Do NOT swallow diff failures. For merge commits, scan against EACH parent
  (`git diff <merge>^1 <merge>`, `<merge>^2`, ...) or use
  `--diff-merges=first-parent`; ensure lines added by a merge resolution are
  scanned.
- Handle the parentless root commit by diffing against the empty tree
  (`git diff <root>^ <root>` won't work; use the empty-tree object
  `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, or `git show` appropriate form).
- Keep the linear-history add-then-remove fix that PR #154 got right (it IS
  correct and closed). Do not regress it.
- Keep the existing sensitive-paths `names`+net-`diff` path in `provision.ts`
  EXACTLY as is (do not change `evaluateChange`'s signature; issue33 tests must
  pass unchanged).

## Files
- `src/syncpolicy.ts` — the scan helper(s).
- `src/provision.ts` — wiring in `applyPolicy`.
- `src/issue103b.test.ts` — extend the REQUIRED regression tests.

## REQUIRED regression tests (add to src/issue103b.test.ts)
1. (keep) linear add-then-remove: helper returns 1; net diff returns 0.
2. (keep) negative: removed-only credential-shaped line => 0.
3. (keep) near-miss ordinary added lines => 0.
4. **NEW** merge-resolution case: build real history
   `base -> main,side -> MERGE(resolution adds secret.txt) -> tip` and prove the
   scan REFUSES (or the helper counts it). This is the exact bypass case; it MUST
   be caught after your fix and was NOT caught before.
5. **NEW** root-commit case: a secret in the range's parentless root commit is
   caught.

Model the real-git tests on `src/issue33.test.ts`'s harness (worker branch +
bundle base64 + `syncFromNode`/`applyPolicy`), expecting `refused`,
`commit: "policy-refused"`, unchanged origin ref, and that the secret never
appears in `JSON.stringify(result)`.

## House rules
- Edit IN PLACE. Do not reformat unrelated code.
- Do NOT weaken or alter unrelated tests. `src/issue33.test.ts` must pass
  unchanged.
- Commit when green; run the FULL suite (`npm test`).
- Never push. Commit locally on branch `fleet/dev2-103b-merge-scan` only.

## Acceptance
- Build exits 0.
- `src/issue103b.test.ts` fails on the pre-fix base (for the merge-resolution and
  root-commit cases) and passes post-fix.
- Full suite green.
