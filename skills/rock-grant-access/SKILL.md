---
name: rock-grant-access
description: Configure church-specific Rock page, entity, and REST API permissions by resolving real roles/controllers, reviewing intended changes, flushing cache and testing the actual identity.
---
# Grant access
Read SETUP.md and reference/rock-rest-api-security.md. Resolve exact person/REST identity and security role. Check membership, inherited rules and DENY order. Page, entity, classic REST and v2 REST security are separate. Discover actual controller IDs and supported action names; never reuse numbers from another church.

Preview the intended role/membership/Auth changes for the user. Execute only within authorization, using guarded tools for existing records. New Auths and membership tools may write immediately. Bootstrap with a signed-in administrator browser when API permissions do not yet exist. Save and flush cache, then test as the actual target key/user, including a negative permission test against an unrelated resource when safely possible. Do not confuse an admin-browser success with effective key access.

Enabling Sql through Lava is broad database capability. Do not describe a SQL-enabled key as a tightly scoped entity key. Report precisely what was granted and what was verified; never expose the key.

## Auth rules that bite
From Spark's security notes in the Rock repository, plus Rock 19.8 behavior.
- **Per-person Auth rules need a low or negative `Order`.** First match wins, so a stock role's Allow at a lower Order beats your person rule. Deny All Users goes last.
- **Record-level grant inserts: guard with `NOT EXISTS` on ANY existing row for that EntityTypeId + EntityId + Action.** Once a record has its own row, Rock stops inheriting for that action, so a blind insert can silently change who else has access.
- **An Auth row with `EntityId = 0` changes the default for the whole entity type** (every page, every REST controller). Never write one for a single-record grant.
- **Core has no self-lockout protection.** A Deny can lock out administrators, including the key you are using. Snapshot the rows first and keep a second admin path. The kit's SQL lockout guard is a safety net, not a substitute.
- Defaults: View and Tag are allowed by default; Edit and Administrate are denied. Group-type role grants (CanView / CanEdit / CanManageMembers) override Auth Deny rules on groups.
- **Locking a page or block to a short list: lock View, Edit AND Administrate.** Rock shows a block to anyone who can view OR edit it, and Edit is inherited from parent pages. On each action: allow the list, allow RSR - Rock Administration (an explicit Deny All Users locks admins out too), then Deny All Users. Read the rows back, then impersonate someone from a group that holds Edit higher up the page chain and confirm they see nothing (rock-build has the page-chain query).
- **Test as a normal staff user.** Administrators pass every check, so an admin test proves the page works, not who can see it. Verify with a limited staff login or impersonation of a non-admin test person on the sandbox, and confirm someone outside the group gets nothing.
- **Role membership:** v1 REST refuses to add security-role members (403, observed on Rock 19.8.1). A raw SQL insert is invisible to Rock's role cache until a cache clear and writes no History; Rock's own save path (UI, or `{% modifygroupmember %}` in a locked admin block) takes effect at once with History. With the kit's role-member endpoint installed (`ops/rock-role-member-endpoint/`, `ROCK_ROLE_MEMBER_ENDPOINT` set), `add_group_member` uses that path for any security role and needs no cache clear; never hand-write a GroupMember INSERT for a role.
- **19.8 REST hardening:** changing REST security, blocks, attributes, persisted datasets, workflow triggers, person aliases or entity types over REST needs **Administrate**; workflow launch over REST checks workflow-type permissions; binary file endpoints apply file security. A key that worked on 19.4 may 401/403 on 19.8.
- Plugin REST controllers can arrive with no Auth rows and inherit the entity-wide default; some plugins add their own registration check. Review new plugins' controllers after install.
- Every write needs a `reason`; edits to existing Auth rows preview first.
