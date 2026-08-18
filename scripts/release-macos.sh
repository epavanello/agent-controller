#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

publish=false
notes_file=""

usage() {
  echo "Usage: npm run release:mac -- [--publish] [--notes path/to/notes.md]"
  echo
  echo "Builds, notarizes, verifies, and checksums the current package version."
  echo "With --publish, it also tags the current main commit and creates the GitHub Release."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish)
      publish=true
      shift
      ;;
    --notes)
      [[ $# -ge 2 ]] || { echo "--notes requires a file path" >&2; exit 2; }
      notes_file="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command in node npm swift xcrun codesign spctl shasum gh git; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done

version="$(node -p "require('./package.json').version")"
tag="v$version"
profile="${APPLE_KEYCHAIN_PROFILE:-agent-controller}"
app_path="dist/mac-arm64/Agent Controller.app"
dmg_path="dist/Agent Controller-$version-arm64.dmg"
zip_path="dist/Agent Controller-$version-arm64-mac.zip"
checksums_path="dist/SHA256SUMS.txt"

if [[ -n "$notes_file" && ! -f "$notes_file" ]]; then
  echo "Release notes not found: $notes_file" >&2
  exit 1
fi

if [[ "$publish" == true ]]; then
  [[ -z "$(git status --porcelain)" ]] || {
    echo "Publishing requires a clean worktree. Commit the release changes first." >&2
    exit 1
  }
  [[ "$(git branch --show-current)" == "main" ]] || {
    echo "Publishing requires the main branch." >&2
    exit 1
  }
  gh auth status >/dev/null
  git fetch origin main --tags
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || {
    echo "Local main must exactly match origin/main before publishing." >&2
    exit 1
  }
fi

echo "Preparing Agent Controller $version with keychain profile '$profile'"
xcrun notarytool history --keychain-profile "$profile" >/dev/null

npm run icons:build
if [[ "$publish" == true ]] && ! git diff --quiet -- \
  build/icon.icns build/icon.ico build/icon.png resources/icon.png; then
  echo "Generated icons differ from the committed assets. Commit them before publishing." >&2
  exit 1
fi
npm run lint
npm run typecheck
swift build --package-path native
npm run native:build:release

rm -rf "$repo_root/dist"
APPLE_KEYCHAIN_PROFILE="$profile" npm run build:mac

for artifact in "$app_path" "$dmg_path" "$zip_path"; do
  [[ -e "$artifact" ]] || { echo "Expected artifact was not created: $artifact" >&2; exit 1; }
done

codesign --verify --deep --strict --verbose=2 "$app_path"
spctl -a -vvv -t exec "$app_path"
xcrun stapler validate "$dmg_path"
shasum -a 256 "$dmg_path" "$zip_path" > "$checksums_path"

echo "Verified artifacts:"
ls -lh "$dmg_path" "$zip_path" "$checksums_path"

if [[ "$publish" != true ]]; then
  echo "Build complete. Re-run with --publish after committing it on main."
  exit 0
fi

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  [[ "$(git rev-list -n 1 "$tag")" == "$(git rev-parse HEAD)" ]] || {
    echo "Tag $tag already exists on a different commit." >&2
    exit 1
  }
else
  git tag -a "$tag" -m "Agent Controller $version"
fi

git push origin "$tag"

release_args=(
  "$tag"
  "$dmg_path"
  "$zip_path"
  "$checksums_path"
  --verify-tag
  --title "Agent Controller $version"
)

if [[ -n "$notes_file" ]]; then
  release_args+=(--notes-file "$notes_file")
else
  release_args+=(--generate-notes)
fi

gh release create "${release_args[@]}"
echo "Published: $(gh release view "$tag" --json url --jq .url)"
