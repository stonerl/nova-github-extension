## Version 0.9.3

### Fixes

- Closing or reopening an issue now moves it into the correct section
  immediately: GitHub's list endpoints lag behind the state change, so
  the previous immediate refetch put the item right back until the next
  full cycle. The move is applied optimistically and re-asserted on
  every fetched list until the server reflects it (at most 2 minutes).

## Version 0.9.2

### Fixes

- Forget Detection now cleans up properly: the workspace selection no
  longer keeps pointing at the forgotten repo (its issues and PRs kept
  loading, and the stale value lingered in the config). It is dropped —
  auto-selecting the first remaining repository, or cleared when none
  remain — and the issue/PR views are purged immediately. Repos that are
  also configured manually keep their selection and row.
- The repo-list fallback no longer claims the selection before
  auto-detection applies: a fresh workspace now persists the detected
  repository in its canonical owner/repo form instead of a bare name
  racing the detection flow.

## Version 0.9.1

### Fixes

- The Repositories section now shows in both sidebars: the section was
  declared twice (Issues and PRs) under one id with a single view
  instance, so Nova left one sidebar's section without a provider until
  a restart happened to re-bind it. The PR sidebar's section now has its
  own view driven by the same provider — both render identical data,
  list changes reload both, and selecting a repository in either
  sidebar sets the current repo for both.

## Version 0.9.0

### Features

- Tokens are now stored per authenticated account: a personal login and all
  organizations it can access share one Keychain entry, so rotating the
  Personal Access Token updates every repository at once; existing installs
  are mapped over automatically
- Workspaces can hold their own Personal Access Token next to the workspace
  Username override — a second account is finally a complete per-workspace
  setup
- Repository detection gained controls: a global on/off toggle (on by
  default), and a declined prompt is remembered per workspace (clear the
  workspace setting or run Forget Detected Repository to be asked again)
- The auto-detected repository anchors the Repositories list — always shown
  first, with manually configured repositories alongside; a new workspace
  toggle can additionally include the globally configured repositories (off
  by default, workspace entries win on duplicates)

### Fixes

- A newly confirmed repository no longer sits empty until the next
  auto-refresh: detection- and config-driven refreshes now repaint their
  views
- Freshness is tracked per repository instead of one global timestamp —
  opening a workspace with a stale repo fetches once instead of serving
  another workspace's data, and budget-low or rate-limited cycles no longer
  suppress the retry
- Failed logins (401) no longer trigger a 60-second fetch pause with a
  misleading "rate limit reached" alert; the real token warning shows
  instead
- PR detail requests now respect the budget and rate-limit gates, and PR
  details are cached on disk so unchanged PRs are not refetched after a
  restart
- The "Repository not found" alert no longer contradicts the add-repository
  prompt when a stale selection points at a repo that isn't configured here
- The Repositories section no longer shows a divider under its only repo
- Rate-limit log lines now include the HTTP status, a reset countdown, and
  a message when the limit is released

### Performance

- Opening a workspace costs 2 list requests plus only the PRs that actually
  changed (previously one request per PR on every start)

## Version 0.8.0

### Features

- Detected repositories are now manageable: right-click a detected row in
  the Repositories section and choose **Forget Detection** to remove it;
  detected rows are also clickable like configured ones
- Detection storage moved out of Nova's configuration system into the
  extension's own storage — nothing is written to Nova settings or the
  project's `.nova` folder, and already-detected workspaces no longer
  re-prompt
- Error messages: the extension now shows alerts for 401 (bad token), 403
  (missing scopes), 404 (no access or deleted repo — once per session),
  rate-limit hits, and a low API budget, instead of failing silently with
  an empty sidebar

### Performance

- Halved the number of list requests: issues and pull requests of the same
  state share one request
- Auto-refresh pauses when the API budget is low and serves cached data
  until the limit resets; manual refresh always works
- Comment caches validate against the parent item's timestamp, so comment
  changes refetch even when the count is unchanged
- Disk caches are pruned after successful refreshes (removed items, legacy
  files, orphaned directories)

### Fixes

- No config traffic during activation — with a second extension also
  touching configuration, activation could deadlock Nova
- Repo switching no longer fetches everything twice

## Version 0.7.0

### Features

- Automatic repository detection: opening a GitHub checkout offers its
  repository from `.git/config`. Same account + configured repo → set as
  this workspace's active repo automatically; different account or unknown
  repo → one-time confirmation dialog
- Lazy comment loading: comments fetch when a Comments group is expanded
  instead of all up front, and request concurrency is capped
- Rate-limit handling hardened: the limit flag is held at least 60s,
  warnings are logged once per window, and identical concurrent requests
  share one network call

### Fixes

- Config values resolve with an explicit global fallback and are cached,
  eliminating freezes from config read/write storms
- Stale workspace repo values no longer show when no repositories are
  configured

## Version 0.6.1

### Features

- Workspace settings UI: GitHub Username and Repositories can now be set
  per project under Project Settings → Extensions → GitHub (the runtime
  already supported overrides — the settings UI was previously missing)

### Fixes

- Config values now resolve correctly when only the global setting is set
  (workspace values no longer shadow the global ones)

### Performance

- Config reads are cached and debounced, fixing a freeze when entering the
  Personal Access Token

## Version 0.6.0

### Features

- Per-workspace accounts: override GitHub Username and Repositories in
  Project Settings (e.g. a work organization at work, your personal account
  elsewhere); global settings keep working as a fallback
- Tokens are resolved per username from the Keychain, so multi-account
  setups work automatically

## Version 0.5.0

### Features

- Browse and switch between configured GitHub repositories in the sidebar
- Open and closed issues and pull requests with comments, labels,
  milestones, and status reasons
- Disk caching with ETag revalidation and rate-limit fallbacks
- Token stored securely in the macOS Keychain

### Fixes

- Refresh now revalidates with the API instead of serving a stale
  in-memory cache
- Config observers use full setting keys so setting changes take effect
  immediately
- Reduced duplicate API requests by memoizing pull request detail
  hydration
- Auto-refresh timer is cleared on deactivation
