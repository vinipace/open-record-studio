#!/bin/sh
set -eu

# Homebrew links this script into its bin directory. Resolve those links before
# locating the runtime, including installations in paths containing spaces.
launcher=$0
case "$launcher" in
  /*) ;;
  *) launcher="$PWD/$launcher" ;;
esac
links=0
while [ -L "$launcher" ]; do
  links=$((links + 1))
  if [ "$links" -gt 40 ]; then
    echo "Could not resolve the Open Record Studio MCP launcher" >&2
    exit 1
  fi
  parent=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$launcher")" && pwd -P)
  target=$(/usr/bin/readlink "$launcher")
  case "$target" in
    /*) launcher=$target ;;
    *) launcher="$parent/$target" ;;
  esac
done
bindir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$launcher")" && pwd -P)
resources=$(CDPATH= cd -- "$bindir/.." && pwd -P)
export OPEN_RECORD_STUDIO_MCP_LAUNCHER="$bindir/open-record-studio-mcp"
export ELECTRON_RUN_AS_NODE=1
# Do not load a client's global Node preload scripts or external packages.
unset NODE_OPTIONS NODE_PATH ELECTRON_ENABLE_LOGGING
exec "$resources/../MacOS/Electron" "$resources/mcp-runtime/mcp/cli.mjs" "$@"
