# GitHub for Nova

A native GitHub integration for Nova that brings issues and pull requests into
your sidebar — with full read/write capabilities and smart caching to avoid rate
limits.

> This extension is still in early development.
> Use with caution — although rate limit protection is built in, you may still
> encounter GitHub API limits under heavy usage.

## Features

- **Browse Repositories**
  View and switch between configured GitHub repositories directly from the sidebar.

- **Issues & Pull Requests**
  See open and closed issues and PRs in real time, including:

  - Author, assignees, labels, milestone
  - Comments (up to 25 lines previewed)
  - Special status: duplicate, not planned, completed, merged, etc.
  - Draft status for pull requests

- **Auto-Refresh with Smart Throttling**
  Refreshes automatically at your defined interval — but only if needed.
  Skips API calls if data was recently fetched.

- **Caching & Offline Support**
  Caches everything to disk:

  - Issues and PRs
  - Comments and review comments
  - ETags to minimize bandwidth
    Falls back to cached data when rate-limited or offline.

- **Actions**

  - Create new issue or pull request
  - Close or reopen issues (with reason support)
  - Open any item in the browser
  - Copy URLs for sharing

- **Secure Token Storage**
  Your GitHub token is stored in the macOS Keychain. Never in plaintext.

## Notes

- Pull requests are enhanced with merge and draft info via an extra API call per PR.
- The extension avoids unnecessary requests and skips fetching if the view is unchanged.
- Supports both public and private repositories (as long as the token is valid).

## 🔒 Privacy

All authentication is handled via your own GitHub token. No external servers or tracking.
