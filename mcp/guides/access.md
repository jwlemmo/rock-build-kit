---
name: rock-grant-access
description: Configure church-specific Rock page, entity, and REST API permissions by resolving real roles/controllers, reviewing intended changes, flushing cache and testing the actual identity.
---
# Grant access
Read SETUP.md and reference/rock-rest-api-security.md. Resolve exact person/REST identity and security role. Check membership, inherited rules and DENY order. Page, entity, classic REST and v2 REST security are separate. Discover actual controller IDs and supported action names; never reuse numbers from another church.

Preview the intended role/membership/Auth changes for the user. Execute only within authorization, using guarded tools for existing records. New Auths and membership tools may write immediately. Bootstrap with a signed-in administrator browser when API permissions do not yet exist. Save and flush cache, then test as the actual target key/user, including a negative permission test against an unrelated resource when safely possible. Do not confuse an admin-browser success with effective key access.

Enabling Sql through Lava is broad database capability. Do not describe a SQL-enabled key as a tightly scoped entity key. Report precisely what was granted and what was verified; never expose the key.
