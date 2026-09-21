## Version 0.7.0

- Automatic repository detection: opening a GitHub checkout offers its
  repository from `.git/config`. Same account + configured repo → set
  as this workspace's active repo automatically; different account or
  unknown repo → one-time confirmation dialog
- Lazy comment loading: comments fetch when a Comments group is
  expanded instead of all up front, and request concurrency is capped
- Rate-limit handling hardened: the limit flag is held at least 60s,
  warnings are logged once per window, and identical concurrent
  requests share one network call
- Fixed: config values resolve with an explicit global fallback and
  are cached, eliminating freezes from config read/write storms
- Fixed: stale workspace repo values no longer show when no
  repositories are configured

## Version 0.6.1

- Workspace settings UI: GitHub Username and Repositories can now be
  set per project under Project Settings → Extensions → GitHub
  (the runtime already supported overrides — the settings UI was
  previously missing)
- Fixed: config values now resolve correctly when only the global
  setting is set (workspace values no longer shadow the global ones)
- Performance: config reads are cached and debounced, fixing a freeze
  when entering the Personal Access Token

## Version 0.6.0

- Per-workspace accounts: override GitHub Username and Repositories in
  Project Settings (e.g. a work organization at work, your personal
  account elsewhere); global settings keep working as a fallback
- Tokens are resolved per username from the Keychain, so multi-account
  setups work automatically

## Version 0.5.0

- Browse and switch between configured GitHub repositories in the sidebar
- Open and closed issues and pull requests with comments, labels, milestones, and status reasons
- Disk caching with ETag revalidation and rate-limit fallbacks
- Token stored securely in the macOS Keychain

### Fixes

- Refresh now revalidates with the API instead of serving a stale in-memory cache
- Config observers use full setting keys so setting changes take effect immediately
- Reduced duplicate API requests by memoizing pull request detail hydration
- Auto-refresh timer is cleared on deactivation
