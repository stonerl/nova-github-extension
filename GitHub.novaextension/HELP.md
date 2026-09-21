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

### Per-Workspace Settings

**GitHub Username** and **Repositories** can be overridden per project:
open the project and go to _Project Settings → Extensions → GitHub_.
The workspace value wins over the global one, so you can use a work
organization in one project and your personal account in another.
Tokens are stored per username in the Keychain — paste the matching
Personal Access Token once per account. The Token field is global-only:
workspace settings are saved to the project's `.nova` folder and tokens
are never written there.

### Automatic Repository Detection

When you open a project that is a GitHub checkout, the extension reads
its `.git/config` and offers the repository it belongs to. If it uses a
different account than the one configured, a dialog asks first; the
detected account and repo are then stored for this workspace only.
