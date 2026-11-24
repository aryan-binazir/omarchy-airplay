#!/bin/sh
# Every PR carries a version bump; after merge, main's version is tagged and released.
#   scripts/release.sh bump [patch|minor|major]   in a PR branch (default patch)
#   scripts/release.sh tag [--dry-run]            on main, after merge
set -eu

manifest=manifest.json

die() { echo "release: $*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

last_tag() {
  git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' origin/main 2>/dev/null ||
    die "no vX.Y.Z tag reachable from origin/main"
}

version_of() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' | head -n 1
}

# Prints the bumped version of $1 for level $2.
next_version() {
  echo "$1" | awk -F. -v level="$2" '{
    if (level == "major") print $1 + 1 ".0.0"
    else if (level == "minor") print $1 "." $2 + 1 ".0"
    else print $1 "." $2 "." $3 + 1
  }'
}

# Succeeds when version $1 is strictly greater than $2.
newer() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$1" ]
}

bump() {
  level=${1:-patch}
  case $level in patch | minor | major) ;; *) die "bump level must be patch, minor or major" ;; esac
  git fetch --quiet --tags origin main
  last=$(last_tag)
  version=$(next_version "${last#v}" "$level")
  sed "s/^\([[:space:]]*\"version\":[[:space:]]*\"\)[^\"]*\"/\1$version\"/" "$manifest" > "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"
  [ "$(version_of < "$manifest")" = "$version" ] || die "could not set version in $manifest"
  echo "$manifest: $last -> v$version ($level)"
}

tag() {
  dry_run=
  case ${1:-} in '') ;; --dry-run) dry_run=1 ;; *) die "usage: release.sh tag [--dry-run]" ;; esac
  git fetch --quiet --tags origin main
  head=$(git rev-parse origin/main)
  existing=$(git tag --points-at "$head" --list 'v[0-9]*' | head -n 1)
  if [ -n "$existing" ]; then
    echo "origin/main ($head) is already tagged $existing"
    exit 0
  fi
  last=$(last_tag)
  version=$(git show "$head:$manifest" | version_of)
  [ -n "$version" ] || die "no version in $manifest on origin/main"
  newer "$version" "${last#v}" || die "$manifest version $version is not greater than $last; run the bump in a PR"
  new=v$version
  if [ -n "$dry_run" ]; then
    echo "would tag $new on origin/main ($head), push it, and release it as Latest with notes since $last"
    return
  fi
  git tag -a "$new" -m "$new" "$head"
  git push origin "refs/tags/$new"
  gh release create "$new" --verify-tag --latest --title "$new" --generate-notes --notes-start-tag "$last"
}

case ${1:-} in
  bump) shift; bump "$@" ;;
  tag) shift; tag "$@" ;;
  *) die "usage: release.sh bump [patch|minor|major] | tag [--dry-run]" ;;
esac
