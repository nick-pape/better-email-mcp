#!/bin/sh
#
# pape-house fork patch — extends @n24q02m/mcp-core's JWT access-token TTL
# from 1h to 1y so the homelab MCP gateway proxy doesn't need to re-run the
# full PKCE+relay-password+form-fill OAuth dance every hour against
# better-email-mcp (upstream issues only authorization_code grants — no
# refresh-token support).
#
# Runs as `postinstall` hook after `bun install`. Idempotent: re-applies
# cleanly if the file already has the patched value (grep gate).
#
# POSIX sh syntax (no bashisms) — the oven/bun:1-alpine image ships busybox
# sh without bash.
#
# Why patch the compiled JS instead of forking mcp-core upstream:
# - bun's git-URL install treats the workspace root as the package payload,
#   missing the inner packages/core-ts/build/ artifacts
# - bun patch v1.3.14 fails with "error overwriting folder: FileNotFound"
#   for git-installed deps (known bug)
# - This sed is one line of behavior change against a one-line literal in
#   the compiled output — surfaces upstream changes as a grep failure
#
# If this script fails (upstream removed the literal, refactored the
# function, etc.), the install halts here loudly rather than silently
# shipping a 1h-TTL container. Fix by inspecting node_modules/@n24q02m/
# mcp-core/build/oauth/jwt-issuer.js and updating the sed pattern.

set -eu

TARGET='node_modules/@n24q02m/mcp-core/build/oauth/jwt-issuer.js'

if [ ! -f "$TARGET" ]; then
    echo "pape-house postinstall: $TARGET not found — skipping (likely a non-install lifecycle phase)" >&2
    exit 0
fi

UNPATCHED='expiresInSeconds = 3600'
PATCHED='expiresInSeconds = 60 * 60 * 24 * 365'

if grep -qF "$PATCHED" "$TARGET"; then
    echo "pape-house postinstall: TTL patch already applied to $TARGET" >&2
    exit 0
fi

if ! grep -qF "$UNPATCHED" "$TARGET"; then
    echo "pape-house postinstall: ERROR — neither unpatched nor patched literal found in $TARGET" >&2
    echo "pape-house postinstall: upstream may have refactored jwt-issuer.ts; PAPE_HOUSE_PATCHES.md needs update" >&2
    exit 1
fi

sed -i "s|${UNPATCHED}|${PATCHED}|" "$TARGET"

if grep -qF "$PATCHED" "$TARGET"; then
    echo "pape-house postinstall: TTL patch applied to $TARGET (3600s → 1y)" >&2
else
    echo "pape-house postinstall: ERROR — patch substitution did not take effect" >&2
    exit 1
fi
