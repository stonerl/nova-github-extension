## Configuration

In Nova's Extension Settings:

### Required

- **GitHub Username** – Your GitHub username or organization name.
- **Personal Access Token** – A GitHub token with appropriate scopes; stored securely in the Keychain.
- **Repositories** – A list of repositories in `repo` format.

### Token

Paste your _GitHub Personal Access Token_ into the Token field.
It will be securely stored using the system Keychain and no longer visible after saving.

### Optional

- **Refresh Interval** – How often to auto-refresh data (in minutes).
- **Items per Page** – The GitHub API pagination size.
- **Max Recent Items** – Maximum number of issues and PRs to fetch.
