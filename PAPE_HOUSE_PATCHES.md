# pape-house fork patches

This fork carries minimal-surface deltas to make `better-email-mcp` usable
behind the `mcp.pape.house` homelab MCP gateway. Two repos, three files,
~17 LoC total (mostly explanatory comments). Pin downstream consumers by
tag — `main` here tracks upstream's `main`.

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

## Patch 1 — `nick-pape/mcp-core` @ `1.14.0-pape.1`

**Branch:** `pape-house/long-jwt-ttl` (off upstream `main`)
**File:** `packages/core-ts/src/oauth/jwt-issuer.ts`
**Change:** Default `expiresInSeconds` argument of `issueAccessToken()` from `3600` to `60 * 60 * 24 * 365` (1 year).
**Why:** No refresh-token support → without this, every hour the proxy would need to re-run the full PKCE + relay-password + form-fill flow against email-mcp, which has no headless path. JWT signing keys already persist at `~/.mcp-core/jwt-keys/<serverName>_{private,public}.pem` so a long-lived bearer survives container restarts.
**Risk:** Explicit callers passing their own `expiresInSeconds` (e.g.
`local-server.ts:266` issuing 1-year `proxyToken`) are unaffected — this
is a default-value change only.

## Patch 2 — `nick-pape/better-email-mcp` @ `1.29.0-pape.1`

**Branch:** `pape-house/forked` (off upstream `main`)
**Files:**
- `src/transports/http.ts` (1 line + comment): `accountsForThisRequest` fallback
- `package.json` (1 line): pin `@n24q02m/mcp-core` to the forked git tag

### `http.ts` patch

Upstream's `serverFactory()` resolves per-request mailbox accounts as
`scope?.accounts ?? currentAccounts`. The `??` operator falls through
only on `null`/`undefined`. But `authScope` middleware always sets
`scope` (with `accounts: []` when `credStore.load(sub)` returns null),
so an empty array wins over `currentAccounts`. After an email-mcp
container restart wipes `InMemoryCredStore`, every previously-issued
JWT sees an empty mailbox list even though disk-persisted accounts exist
under the encrypted config.

Fix: length-check fallback. `accountsForThisRequest = scope?.accounts?.length ? scope.accounts : currentAccounts`.

### `package.json` patch

Pin to the forked `mcp-core` git tag. `bun.lock` regenerated.

## Multi-tenancy implication

The `http.ts` patch makes any sub's accounts default to the disk-loaded
account list. This collapses per-sub multi-tenancy: a request with a JWT
for sub A and a request with a JWT for sub B both see the same accounts
(whatever's on disk). For our single-user, single-Outlook-account homelab
deployment this is desired — we have one mailbox and want every issued
bearer to access it. For multi-tenant deployments this would be wrong
and the upstream behavior is correct. Mark the deployment context
explicitly if reusing this fork elsewhere.

## Rebase recipe

When upstream cuts a new release worth taking:

```bash
# In nick-pape/mcp-core
git fetch upstream
git rebase upstream/main pape-house/long-jwt-ttl
# Resolve conflicts in packages/core-ts/src/oauth/jwt-issuer.ts (only the default value line)
git push --force-with-lease origin pape-house/long-jwt-ttl
git tag -a 1.14.<X>-pape.1 -m "rebased onto upstream"
git push origin 1.14.<X>-pape.1

# In nick-pape/better-email-mcp
git fetch upstream
git rebase upstream/main pape-house/forked
# Resolve conflicts in src/transports/http.ts (only the accountsForThisRequest line)
# Update package.json to point to the new mcp-core tag
# Regenerate bun.lock — locally `bun install` or via:
#   ssh root@proxmox.service.pape.house pct exec 120 -- \
#     docker run --rm -v /tmp/work:/app -w /app oven/bun:1-alpine bun install
git push --force-with-lease origin pape-house/forked
git tag -a 1.<X>.<Y>-pape.1 -m "rebased onto upstream"
git push origin 1.<X>.<Y>-pape.1
```

Estimated cadence: quarterly, ~15 min each. Upstream Jules-agent churn
is concentrated in the credential-form UI ("Palette", "Sentinel" PRs),
not in `jwt-issuer.ts` or `transports/http.ts` `serverFactory` — both of
which have been stable for months. Conflicts in our two patched files
are unlikely.

## Image build (downstream consumer)

```bash
# On any docker host that can pull from oven/bun and node:24-alpine
docker build -t registry.pape.house/local/email-mcp:1.29.0-pape.1 \
             --target http \
             -f Dockerfile .
docker push registry.pape.house/local/email-mcp:1.29.0-pape.1
```

Pin downstream consumers by `sha256:<digest>`, not by tag — Zot tag
mutability isn't enforced.
