#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_svg="$repo_root/resources/icon.svg"
temporary_directory="$(mktemp -d)"

cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

if [[ ! -f "$source_svg" ]]; then
  echo "Missing icon source: $source_svg" >&2
  exit 1
fi

render_directory="$temporary_directory/render"
iconset="$temporary_directory/AgentController.iconset"
mkdir -p "$render_directory" "$iconset" "$repo_root/build" "$repo_root/resources"

qlmanage -t -s 1024 -o "$render_directory" "$source_svg" >/dev/null 2>&1
rendered_png="$render_directory/$(basename "$source_svg").png"

if [[ ! -f "$rendered_png" ]]; then
  echo "macOS could not render $source_svg" >&2
  exit 1
fi

sips -z 512 512 "$rendered_png" --out "$repo_root/build/icon.png" >/dev/null
sips -z 512 512 "$rendered_png" --out "$repo_root/resources/icon.png" >/dev/null

make_icon() {
  local pixels="$1"
  local filename="$2"
  sips -z "$pixels" "$pixels" "$rendered_png" --out "$iconset/$filename" >/dev/null
}

make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
make_icon 1024 icon_512x512@2x.png

iconutil -c icns "$iconset" -o "$repo_root/build/icon.icns"
sips -z 256 256 "$rendered_png" --out "$temporary_directory/icon-256.png" >/dev/null
sips -s format ico "$temporary_directory/icon-256.png" --out "$repo_root/build/icon.ico" >/dev/null

echo "Generated build/icon.icns, build/icon.ico, build/icon.png, and resources/icon.png"
