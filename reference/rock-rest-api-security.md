# REST security at a new church

Use SETUP.md's browser bootstrap and endpoint matrix. Discover the REST identity, role membership, controller IDs and actions, and entity permissions on this installation. Do not copy an original church's grants. Classic REST View/Edit does not imply v2 Execute* permissions. Page permissions do not imply API permissions. Read effective ordered rules and inheritance. A 401 can be authentication or authorization failure. Re-test using the actual integration key after cache refresh.

Full builder functions use POST /api/Lava/RenderTemplate and Sql in the global enabled-command setting. This grants privileged database access through Lava; validators are not a least-privilege boundary. Never expose a custom unauthenticated SQL endpoint. Use a separate key per operator/environment, store it locally, and do not assume sandbox refreshes preserve/revoke secrets as intended.

[Rock Admin Hero Guide](https://www.rockrms.com/documentation/bookcontent/9)
