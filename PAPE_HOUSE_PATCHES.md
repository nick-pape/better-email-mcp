# pape-house fork patches

This fork carries minimal-surface deltas to make `better-email-mcp` usable
behind the `mcp.pape.house` homelab MCP gateway. One repo, three files,
~80 LoC total (mostly comments). Pin downstream consumers by tag — `main`
here tracks upstream's `main`.

## Why this fork exists

Upstream's HTTP mode is itself an OAuth 2.1 authorization server with
1-hour access tokens and no refresh-token support. The hub's HTTP-fanout
auth strategies (`bao_backed_bearer` / `jwt_passthrough` / `fanout_jwt`)
can't speak the OAuth-2.1 client dance — and even if they could, an MCP
gateway re-running PKCE + relay-password + form-fill every hour against
each backend is not viable.

The minimal-surface fix is to (a) extend access-token TTL to 1 year so
the bootstrap dance only runs annually, and (b) make the per-sub
in-memory `InMemoryCredStore` fall back to disk-persisted accounts when
the sub has no in-memory record. Without (b), every container restart
wipes accounts even though disk-encrypted config persists.

## Patch 1 — JWT access-token TTL (1h → 1y)

**Mechanism**: post-`bun install` sed against the compiled
`node_modules/@n24q02m/mcp-core/build/oauth/jwt-issuer.js`.
**Files:**
- `scripts/pape-house-patch-mcp-core.sh` — POSIX-sh script that runs
  `sed -i 's|expiresInSeconds = 3600|expiresInSeconds = 60 * 60 * 24 *
  365|'`. Idempotent (skips if already patched). Halts loud if neither
  pattern matches (signal that upstream refactored the line — surfaces as
  install failure, not silent prod bug).
- `package.json` (1 line addition): `"postinstall": "sh
  scripts/pape-house-patch-mcp-core.sh"`.

**Why postinstall sed and not a real source fork of mcp-core:**
- bun's git-URL install for a workspace-rooted package mounts the
  workspace ROOT into `node_modules/@n24q02m/mcp-core/`, missing the
  inner `packages/core-ts/build/` artifacts; TypeScript can't resolve
  imports.
- `bun patch` v1.3.14 fails with `error overwriting folder in
  node_modules: FileNotFound` for git-installed deps (verified, known
  bug).
- A flat-publish branch of the mcp-core fork would work but doubles the
  maintenance surface — two repos to rebase against upstream churn.
- The sed targets a single literal in a compiled file; if upstream
  refactors that line, the script's grep gate halts the build with a
  clear error pointing here. Effectively the same drift-detection
  property as a real source fork, with less infrastructure.

A reference branch `pape-house/long-jwt-ttl` exists on
[`nick-pape/mcp-core`](https://github.com/nick-pape/mcp-core/tree/pape-house/long-jwt-ttl)
tagged `1.14.0-pape.1` documenting the human-readable source diff; that
fork is NOT used at build time. Keep updated when rebasing for the audit
trail.

## Patch 2 — `accountsForThisRequest` fallback

**Mechanism**: source-level edit in our fork.
**File:** `src/transports/http.ts` (1 line + ~15 lines of explanatory comments)

Upstream's `serverFactory()` resolves per-request mailbox accounts as
`scope?.accounts ?? currentAccounts`. The `??` operator falls through
only on `null`/`undefined`. But `authScope` middleware always sets
`scope` (with `accounts: []` when `credStore.load(sub)` returns null),
so an empty array wins over `currentAccounts`. After an email-mcp
container restart wipes `InMemoryCredStore`, every previously-issued
JWT sees an empty mailbox list even though disk-persisted accounts exist
under the encrypted config.

Fix: length-check fallback. `accountsForThisRequest = scope?.accounts?.length ? scope.accounts : currentAccounts`.

## Multi-tenancy implication

Patch 2 makes any sub's accounts default to the disk-loaded account
list. This collapses per-sub multi-tenancy: a request with a JWT for
sub A and a request with a JWT for sub B both see the same accounts
(whatever's on disk). For our single-user, single-Outlook-account
homelab deployment this is desired — we have one mailbox and want every
issued bearer to access it. For multi-tenant deployments this would be
wrong and the upstream behavior is correct. Mark the deployment context
explicitly if reusing this fork elsewhere.

## Rebase recipe

Run quarterly (or when upstream cuts a release worth taking):

```bash
cd nick-pape/better-email-mcp
git fetch upstream
git rebase upstream/main pape-house/forked

# Verify Patch 2 still applies cleanly:
git diff upstream/main pape-house/forked -- src/transports/http.ts
# Should show ONLY the accountsForThisRequest length-check line + comment

# Verify Patch 1's sed pattern still matches the compiled output:
bun install   # runs the postinstall — should print "TTL patch applied"
grep -n expiresInSeconds node_modules/@n24q02m/mcp-core/build/oauth/jwt-issuer.js
# Expected: "expiresInSeconds = 60 * 60 * 24 * 365"

# Tag + push
git push --force-with-lease origin pape-house/forked
git tag -a 1.<NEW-VERSION>-pape.1 -m "rebased onto upstream <commit>"
git push origin 1.<NEW-VERSION>-pape.1
```

If the sed gate fails (`ERROR — neither unpatched nor patched literal
found`), upstream refactored `jwt-issuer.ts`. Re-investigate the new
shape, update `scripts/pape-house-patch-mcp-core.sh` to match, then
re-bun-install.

Estimated cadence: quarterly, ~15 min each. Upstream Jules-agent churn
is concentrated in the credential-form UI ("Palette", "Sentinel" PRs),
not in `jwt-issuer.ts` or `transports/http.ts` `serverFactory` — both of
which have been stable for months. Conflicts in our patched files are
unlikely.

## Image build (downstream consumer)

```bash
docker build -t registry.pape.house/local/email-mcp:1.29.0-pape.2 \
             --target http \
             -f Dockerfile .
docker push registry.pape.house/local/email-mcp:1.29.0-pape.2
```

Pin downstream consumers by `sha256:<digest>`, not by tag — Zot tag
mutability isn't enforced.
