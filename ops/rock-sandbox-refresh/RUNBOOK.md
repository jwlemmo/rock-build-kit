# Sandbox refresh procedure

Inventory actual source/target hosts and database names, backup/restore capability, retention and encryption. Save sandbox-only work and record a rollback point. Never assume keys should be shared across environments.

Before restoring production data, block sandbox outbound email, SMS, payment processing, webhooks, scheduled jobs, cloud storage writes, identity sync and other integrations at the infrastructure/network layer. Restore into the isolated target using the provider's approved tools. Inspect every configured provider, job, webhook, financial gateway and hostname before enabling the app; a generic UPDATE script cannot know the plugins installed.

Use development credentials/endpoints or disable each integration; sanitize/anonymize private records if full production data is unnecessary. Rotate copied REST/login/integration secrets. Verify with a test mail sink, harmless webhook target, job review and outbound network logs. Update sandbox base URL and storage references without touching production. Clear caches, verify sign-in and read-only MCP, then document the refresh and explicitly re-enable only intended sandbox features. Fail closed if isolation cannot be demonstrated.
