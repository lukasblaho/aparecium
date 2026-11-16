#!/usr/bin/env bash
# Builds dist/aparecium-<version>.zip from the tracked extension files.
# Usage: scripts/release.sh [--tag]   (--tag also creates and pushes a v<version> git tag)
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
[ -n "$version" ] || { echo "Could not read version from manifest.json" >&2; exit 1; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Uncommitted changes to tracked files; commit them first." >&2
  exit 1
fi

out="dist/aparecium-$version.zip"
mkdir -p dist
rm -f "$out"
git ls-files | grep -v -e '^README.md$' -e '^\.gitignore$' -e '^scripts/' | zip -q -X "$out" -@
echo "Built $out ($(unzip -Z1 "$out" | wc -l | tr -d ' ') files)"

if [ "${1:-}" = "--tag" ]; then
  git tag "v$version"
  git push origin "v$version"
  echo "Tagged and pushed v$version"
fi
