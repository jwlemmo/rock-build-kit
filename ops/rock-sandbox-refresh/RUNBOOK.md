# Sandbox refresh procedure

Inventory actual source/target hosts and database names, backup/restore capability, retention and encryption. Save sandbox-only work and record a rollback point. Never assume keys should be shared across environments.

Before restoring production data, block sandbox outbound email, SMS, payment processing, webhooks, scheduled jobs, cloud storage writes, identity sync and other integrations at the infrastructure/network layer. Restore into the isolated target using the provider's approved tools. Inspect every configured provider, job, webhook, financial gateway and hostname before enabling the app; a generic UPDATE script cannot know the plugins installed.

Use development credentials/endpoints or disable each integration; sanitize/anonymize private records if full production data is unnecessary. Rotate copied REST/login/integration secrets. Verify with a test mail sink, harmless webhook target, job review and outbound network logs. Update sandbox base URL and storage references without touching production. Clear caches, verify sign-in and read-only MCP, then document the refresh and explicitly re-enable only intended sandbox features. Fail closed if isolation cannot be demonstrated.

## Lessons from real refreshes

Collected from one installation's refreshes (Aug–Nov 2026, Rock 18–19.8.1). They describe what went wrong there; confirm each against your own hosting and plugins.

**How the assistant guides**
- The assistant is a guide only. The operator runs every step that creates, changes or deletes anything: cloud commands, SQL, file moves. The assistant may run read-only checks (SELECT queries, list/show commands) to confirm a gate. An assistant that "saved time" by submitting a database copy mid-refresh is why this rule exists.
- One step per message, then wait for the operator to report back. Name the machine in every instruction ("on the sandbox server…", "on the production server…"); doing the right step on the wrong box is the costliest mistake in the procedure. Say what should appear after each click, and gloss any cloud term the first time it comes up.

**Before the refresh**
- Open change bundles are sandbox builds that have not reached production. The refresh destroys them. List them and have each owner promote, abandon or accept losing them first.
- Read the sandbox's real data age (for example `SELECT MAX(TransactionDateTime) FROM FinancialTransaction`). A reused database name can say one month while the data runs to another.
- Compare Rock versions on both servers (`GET /api/Utility/GetRockSemanticVersionNumber`). If the sandbox is ahead, the refresh rolls it back and that upgrade has to be redone.

**During the copy and file move**
- A database copy can be invisible to list/show commands while it seeds. An early "not found" is not a failure; poll until the database reports Online. Judging too early led to a second copy against the same name and both attempts failed.
- Read the web root's folder list back before renaming anything. Leftover backup folders mean a previous refresh's cleanup never finished; fold them into this run's cleanup.
- Cloud storage list commands can silently cap their results (one capped at 5,000), so a blob count gate needs the "no limit" option or it passes on a plausible number.
- Rock's connection string uses `Data Source=`, not `Server=`; a check that looks only for `Server=` comes back empty and reads like a failed edit. Verify it without printing the password.
- A sanitize script without a guard is not safe to run twice: a second run mangles already-rewritten email addresses. Add a guard that stops on an already-sanitized database, and restore a fresh copy instead of re-running in place.

**Before anyone uses the sandbox**
- Until the Site domain records are changed to the sandbox's own hostnames, the restored database still holds production's domains, so requests to the sandbox hostnames can redirect toward production. Make the first requests from the sandbox server itself (localhost). Afterward, verify from outside that each sandbox hostname redirects to itself, never to a production name.
- Hunt absolute production URLs stored in settings, for example a Redirect block with a hard-coded `https://…` target: `SELECT a.[Key], av.EntityId, av.Value FROM AttributeValue av JOIN Attribute a ON a.Id = av.AttributeId WHERE av.Value LIKE '%<your production domain>%'`. Rock's Redirect block does not redirect users with Administrate rights; it shows the target instead, so an admin can open the page to fix it.
- A certificate plugin's copied settings name production's domains. Re-point them to the sandbox domains even when no renewal is due; a setting like "remove old certificate" plus an unattended renewal for production names can strip the sandbox's working certificate. Edit, don't trigger a live renewal by accident.
- Update the public and internal application root global attributes to the sandbox hostnames and read them back.
- **Communications are a safety step.** A sanitize script that rewrites email addresses may not touch phone numbers: after a passing sanitize, SMS (with its transport) and push notifications were still active, so the "sanitized" sandbox could text and push real people. Turn both mediums off and confirm in the database:
  `SELECT e.FriendlyName, av.Value FROM Attribute a JOIN EntityType e ON e.Id = a.EntityTypeId LEFT JOIN AttributeValue av ON av.AttributeId = a.Id WHERE a.[Key] = 'Active' AND e.Name LIKE 'Rock.Communication.Medium.%'`
- **Jobs don't stay off on their own.** Verify by name, not count: `SELECT Name, Class FROM ServiceJob WHERE IsActive = 1`. Plugin jobs copied from production came back on (a cloud database scaling job, jobs that call outside services), and a job created on the sandbox is active by default. A job switched by SQL needs one Save in the UI before the scheduler notices. Re-run this check after any upgrade or plugin update on the sandbox, not only on refresh day.
- **Giving gateway is a safety step.** The refresh copies production's financial gateway in live mode with production's keys. Until it is changed, a test gift on a sandbox giving form could charge a real card, and refunding a gift or cancelling a recurring gift in the sandbox admin pages could act on a real person's gift, because the sandbox holds copies of real gifts and schedules. Turning jobs off does not cover this: these are actions a person takes. Set each active gateway to its test/sandbox mode (or make it inactive if nobody needs giving on the sandbox) and read the setting back before anyone tests.
