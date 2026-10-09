#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ASSET_DIR="$ROOT_DIR/assets"
TEMP_DIR=$(mktemp -d)
ICONSET_DIR="$TEMP_DIR/icon.iconset"

trap 'rm -rf "$TEMP_DIR"' EXIT
mkdir -p "$ICONSET_DIR"
qlmanage -t -s 1024 -o "$TEMP_DIR" "$ASSET_DIR/icon.svg" >/dev/null
SOURCE_PNG="$TEMP_DIR/icon.svg.png"

for entry in \
  "icon_16x16.png 16" \
  "icon_16x16@2x.png 32" \
  "icon_32x32.png 32" \
  "icon_32x32@2x.png 64" \
  "icon_128x128.png 128" \
  "icon_128x128@2x.png 256" \
  "icon_256x256.png 256" \
  "icon_256x256@2x.png 512" \
  "icon_512x512.png 512" \
  "icon_512x512@2x.png 1024"
do
  set -- $entry
  sips -z "$2" "$2" "$SOURCE_PNG" --out "$ICONSET_DIR/$1" >/dev/null
done

iconutil -c icns -o "$ASSET_DIR/icon.icns" "$ICONSET_DIR"