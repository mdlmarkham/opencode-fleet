#!/bin/sh
# Hygiene guard (issue #159): refuses an index that tracks
#   1. symlinks with absolute targets or targets escaping the repo root,
#   2. any path under node_modules/, or
#   3. TASK-*.md agent briefs, including the dot-prefixed convention fleet_sync's auto-commit uses
#      (e.g. .fleet-TASK-39.md; issue #205). Matching is by basename, so the tracked project
#      record under .fleet/ (charter.md, decisions/, rules.yml) is never caught.
# Usage: scripts/check-hygiene.sh [repo-dir]   (default: this repo's root)
# Read-only: uses `git ls-files -s`, never touches the worktree.
set -u
set -f

repo=${1:-"$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"}
tab=$(printf '\t')
violations=0
tmp="${TMPDIR:-/tmp}/check-hygiene.$$.list"
trap 'rm -f "$tmp"' EXIT

fail() {
  printf '%s\n' "$1" >&2
  violations=$((violations + 1))
}

# escapes DIR TARGET -> exit 1 iff TARGET resolves above the repo root when
# taken from DIR (both repo-relative). Purely lexical: no filesystem access.
escapes() {
  oldifs=$IFS
  p="$1/$2"
  out=""
  IFS=/
  set -- $p # single expansion, so it splits fully on '/'
  IFS=$oldifs
  for seg in "$@"; do
    case $seg in
      ""|".") continue ;;
      "..")
        case $out in
          "") return 1 ;;
          */*) out=${out%/*} ;;
          *) out="" ;;
        esac
        ;;
      *) out=${out:+$out/}$seg ;;
    esac
  done
  return 0
}

git -C "$repo" ls-files -s > "$tmp"

while IFS= read -r line; do
  [ -n "$line" ] || continue
  head=${line%%"$tab"*}
  mode=${head%% *}
  sha=${head#* }
  sha=${sha%% *}
  path=${line#*"$tab"}

  case $mode in
    120000)
      target=$(git -C "$repo" cat-file blob "$sha")
      case $target in
        /*) fail "hygiene: violation: absolute symlink '$path' -> '$target'" ;;
        *)
          case $path in
            */*) dir=${path%/*} ;;
            *) dir=. ;;
          esac
          if ! escapes "$dir" "$target"; then
            fail "hygiene: violation: escaping symlink '$path' -> '$target' (resolves outside the repo)"
          fi
          ;;
      esac
      ;;
  esac

  case $path in
    node_modules|node_modules/*)
      fail "hygiene: violation: path under node_modules/ is tracked: '$path'" ;;
  esac

  name=${path##*/}
  case $name in
    TASK-*.md|.*TASK-*.md) fail "hygiene: violation: TASK-*.md agent brief is tracked: '$path'" ;;
  esac
done < "$tmp"

if [ "$violations" -gt 0 ]; then
  printf 'hygiene: %d violation(s), refusing\n' "$violations" >&2
  exit 1
fi
printf 'hygiene: ok\n'