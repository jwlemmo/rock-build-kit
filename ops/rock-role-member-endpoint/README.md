# Security-role adds through Rock's own save logic

Rock's v1 REST refuses to add someone to a security role (403). A raw SQL `GroupMember` row works, but Rock's role cache does not see it until a cache clear, and it leaves no History and no created-by. `{% modifygroupmember %}` does all of that correctly, but Lava entity commands only run in a block or Lava Application endpoint with `RockEntityModify` enabled (`/api/Lava/RenderTemplate` refuses them).

This folder holds a small admin-only Lava Application endpoint that adds or reactivates one person in one security role. When `ROCK_ROLE_MEMBER_ENDPOINT` is set, the MCP's `add_group_member` calls it for any security-role group. Without it, `add_group_member` refuses security roles instead of falling back to SQL.

Observed on Rock 19.8.1, 2026-11-08/09 (one installation): the membership takes effect at once with no cache clear, Rock stamps created/modified-by with the calling key's person, fills `GroupTypeId` and `DateTimeAdded` in Rock's local time, writes History, saves the reason in the member Note, and reactivates an inactive membership instead of adding a second row.

## Install (sandbox first, through your change process)

1. Admin Tools > CMS Configuration > Lava Applications: create an application (for example **MCP Tools**, slug `mcp-tools`).
2. Add an endpoint (for example slug `role-member`), method **POST**, enabled Lava commands **RockEntityModify** and **Sql**, and paste `role-member.lava` as its code.
3. Security on the endpoint: **Execute** allowed for RSR - Rock Administration (or the role that holds your MCP key's person), then **Execute** denied for All Users. The REST key's person must be in the allowed role. If your Rock version shows a security-mode setting on the application or endpoint, pick the one that checks the endpoint's own Execute permission, so the rows above are what Rock enforces. Then call it with a key whose person is not in the allowed role and confirm it is refused.
4. Save the application and the endpoint at least once in the UI. Observed on 19.8.1: an application or endpoint whose settings JSON is still NULL (for example one created by SQL) answers 404 as if it did not exist.
5. Clear Rock's cache, then set `ROCK_ROLE_MEMBER_ENDPOINT=mcp-tools/role-member` (your own slugs) in the MCP's `.env` and restart the MCP.

The endpoint answers at `POST /api/v2/lava-app/1/<app>/<endpoint>` with header `X-Helix-CSRF-Protection: true` and body `{"personId":…,"groupId":…,"reason":"…"}`. Without the header, or without a key that holds Execute, Rock answers 401.

## Answers

- `{"ok":false,"result":"not valid",…}` for a missing reason, a reason containing `[[` or `]]` (it would be parsed as entity-command markup), a person who doesn't exist or is deceased, or a group that isn't an active security role. Missing and not-allowed get the same answer.
- `{"ok":true,"result":"already a member",…}`: nothing written.
- `{"ok":true,"result":"added"|"reactivated","groupMemberId":…}`: done.
- `{"ok":false,"result":"not saved",…}`: Rock did not save it. Check `GroupMember` before trying again.

`rock_restore` undoes an `added` row by deleting it. A reactivation has no new row to delete; set the member inactive again by hand if needed.
