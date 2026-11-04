# Rules for this private change log

Keep the repository private. Never commit REST keys, tokens, .env files, credentials, donor/member data, raw SQL results, screenshots with personal information, or raw audit/restore snapshots. Store sensitive artifacts in the church's approved private storage and put non-sensitive references in the record.

Inspect git status and pull --ff-only before starting when a remote exists. Stop on conflicts or unexpected changes. Use the operator's actual email as author; it must match ROCK_OPERATOR_EMAIL for the optional bundle gate. Record target environment explicitly. An open bundle is a tracking prerequisite, not permission to modify production.

Before a push, inspect the entire staged diff for secrets and personal data. Stage only the intended record paths, including the deletion when a bundle closes. Never use git add . indiscriminately. Do not force-push or overwrite other operators' records. Preserve failed tests and unresolved verification honestly.
