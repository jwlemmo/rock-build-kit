# Set up your church's private GitHub Rock change log

Give your local agent this instruction:

> Read CHANGELOG-SETUP.md and walk me through creating our own private GitHub Rock change log. Use our GitHub account or organization and our own operator identity. Create the repository, verify it is private, connect it to the Rock environments we actually have, and verify a harmless tracking-only bundle. Do not change any Rock records for this setup. Keep credentials and member data out of Git.

## 1. Choose the owner and sign in

Use Git and GitHub CLI (`git --version`, `gh --version`). If missing, have your local agent install them through your OS's supported package manager. Run `gh auth login` and complete sign-in yourself; do not paste a token in chat. Run `gh auth status` and `gh api user --jq .login` to verify which account is active. Set your own Git commit name/email if Git asks. Choose your account or an organization where you can create **private** repositories, and a new name such as `rock-changelog`. Confirm the owner with the user before creating it. Existing repositories should be inspected and cloned separately, never overwritten by this helper.

## 2. Create the repository

From the kit folder, replace OWNER and the destination with your own values:

```sh
node scripts/setup-changelog.mjs --dir "/absolute/path/to/rock-changelog" --repo OWNER/rock-changelog --publish
```

The helper creates a fresh folder with instructions, open/ and changes/ folders, initializes Git, commits only known template files, creates a **private** GitHub repository and pushes it. It then verifies GitHub reports it private. Without `--publish`, it only prepares a local repository. If publishing fails, preserve the folder, inspect `git status`, `git remote -v` and `gh repo view OWNER/rock-changelog --json isPrivate,url`; resolve the actual error without deleting history or silently changing the owner/visibility. A successful remote creation followed by failed push should be recovered by pushing the existing origin, not creating a second repository.

Verify `gh repo view OWNER/rock-changelog --json isPrivate,url` and `git -C "/absolute/path/to/rock-changelog" status --short`. Invite only the staff who need access through GitHub's repository access settings. A private repository still must not contain credentials or member data.

## 3. Connect the Rock Build Kit

Edit each applicable **ignored** `mcp/.env.dev` or `mcp/.env` file in the kit. Preserve existing connection settings. Add the same absolute local path on that host:

```dotenv
ROCK_CHANGELOG_DIR=/absolute/path/to/rock-changelog
```

For each operator, `ROCK_OPERATOR_EMAIL` must match the author on their change records. Each host clones the private repository into its own permanent path and configures that path locally. Do not copy credentials between operators.

If the church wants the optional sandbox prerequisite, add these only to the dev configuration after the tracking check below:

```dotenv
ROCK_REQUIRE_CHANGE_BUNDLE=1
ROCK_DEV_HOST=rock-dev.your-church.example
```

Replace ROCK_DEV_HOST with the actual sandbox hostname, without scheme or path. This existing gate checks selected sandbox builds for an open JSON bundle matching the operator; it is not a blanket guard for all tools and does not enforce GitHub review or protect every production write. Do not set it to a production hostname or claim production is gated. Restart the MCP client/server or tunnel service to load changed environment settings.

## 4. Verify without writing to Rock

From the kit folder set the variable for this terminal, then create a tracking-only record (PowerShell: `$env:ROCK_CHANGELOG_DIR='C:\path\to\rock-changelog'`):

```sh
export ROCK_CHANGELOG_DIR="/absolute/path/to/rock-changelog"
node ops/rock-change-management/change.mjs open setup-verification "Change log setup verification only" operator@example.org
```

Replace the email. Inspect open/setup-verification.json: author must match your configured operator, status must be open. Add a note under verification that no Rock changes were made. Then close it as abandoned tracking-only work:

```sh
node ops/rock-change-management/change.mjs cancel setup-verification
```

Review changes/setup-verification.json and confirm the open file is gone. From the new repository, stage only that record, inspect the diff, commit and push:

```sh
git add changes/setup-verification.json
git diff --cached
git commit -m "Verify change tracking setup without Rock changes"
git push -u origin main
```

Verify the commit appears on GitHub and the repository remains private. This verifies tracking and GitHub publishing only; testing enforcement requires a separately approved sandbox build. Do not report the gate as tested merely because the files exist.

## 5. Daily workflow and Chat/Work access

Pull --ff-only before starting. Open a unique bundle for the actual operator. Record scope, target, IDs, before-state summary, rollback and intended verification. Inspect and push the record for review. After authorized work, record actual verification, then close with pushed only after production verification (or cancel if abandoned). Commit the closed record and deletion of its open record together. Keep the MCP audit/restore artifacts locally in approved storage; this GitHub log is the shared review trail.

Claude/Codex/local Work can run these commands with folder access. In web Chat or web Work, connect GitHub separately and grant access to this private repository if that client supports repository writes; otherwise have the local execution host manage it. The Rock MCP itself does not expose Git/GitHub write tools. For a private tunnel, the folder and configuration live on its host. Never claim the chat can push merely because the Rock connection works.

GitHub CLI references: [create a private repository](https://cli.github.com/manual/gh_repo_create), [verify repository metadata](https://cli.github.com/manual/gh_repo_view).
