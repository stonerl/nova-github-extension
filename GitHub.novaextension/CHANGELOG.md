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
