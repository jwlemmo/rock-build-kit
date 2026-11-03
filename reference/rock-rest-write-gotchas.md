> Portability: observed behavior, not a version guarantee. Discover all IDs locally; examples are not production configuration.

# Rock REST write gotchas — editor desyncs, HtmlContent approval, PersonPreferences (7/2026)

Traps hit when Rock's own editors silently fail to save, and when writing content via raw
REST. Complements `rock-lava-reference.md` (Lava/cache) and the cache-flush rules in
`/rock-build`.

## Obsidian attribute editors silently drop qualifier values

The blueboxmoon **Project Type Detail → Project Attributes** editor (Obsidian/Vue) saves a new
Single-Select attribute but persists an **empty `values` qualifier** (and omits `fieldtype` /
`repeatColumns`) even though the typed values show in the field — synthetic/scripted typing
doesn't commit to the Vue v-model. Expect the same class of bug in other Obsidian editors.

**Fix via REST** (browser fetch, cookie-authed):
- `PUT /api/AttributeQualifiers/{id}` to fill the existing empty `values` row (GET it, set
  `.Value`, PUT → 204).
- `POST /api/AttributeQualifiers` `{AttributeId, Key:'fieldtype', Value:'ddl'}` and
  `{…, Key:'repeatColumns', Value:''}` for the missing rows — mirror a working single-select's
  qualifier set (`fieldtype=ddl`, `repeatColumns=''`, `values='a,b,c'`).

## Legacy workflow editor — SetEntityAttribute config doesn't persist

- The component shows as **"Entity Attribute Set"** (category **Entity**) in the Action Type
  tree = `Rock.Workflow.Action.SetEntityAttribute`. Its config lives as AttributeValues with
  `EntityId = WorkflowActionType.Id` (on this instance: AttributeKey attr **<discover ID>**,
  AttributeValue attr **<discover ID>**).
- In the WebForms editor, the **Attribute Key** text box and **Attribute Value Attribute**
  picker can be silently lost when a reorder **drag** re-renders the panel before the values
  post. Fix via REST: `POST /api/AttributeValues`
  `{AttributeId:3388, EntityId:<actionTypeId>, Value:'<key>'}` and
  `{AttributeId:3389, EntityId:<actionTypeId>, Value:'<sourceWorkflowAttrGuid>'}`.
- After REST-editing workflow action config, **flush WorkflowTypeCache** or the engine won't
  see it: `GET /api/WorkflowTypes/{id}`, then `PUT` it back unchanged (→ 204) triggers the
  flush. (A UI Save also flushes, but re-serializing can re-drop the flaky fields.)

## HtmlContent PUT resets approval → block renders EMPTY

Every `PUT /api/HtmlContents/{id}` resets `IsApproved` to `false`, and the HTML Content block
only displays approved content — so a "successful" PUT blanks the page. Always include
`IsApproved: true` (+ `ApprovedDateTime`) in the PUT body:

```js
const rec = await (await fetch('/api/HtmlContents/{id}')).json();
rec.Content = newContent;
rec.IsApproved = true;
rec.ApprovedDateTime = new Date().toISOString();
await fetch('/api/HtmlContents/{id}', { method: 'PUT',
  headers: {'Content-Type':'application/json'}, body: JSON.stringify(rec) });
```

(The `edit_block_content` MCP tool handles this for you — this trap is for raw REST writes.)

## PersonPreferences v2 API — the URL that actually works

`POST /api/v2/Utilities/PersonPreferences/{entityTypeKey}/{entityKey}`

- `{entityTypeKey}` = the Block entity-type IdKey (`vaqyQd03Re`, constant for all blocks);
  `{entityKey}` = the **block's own IdKey** — NOT the person-alias IdKey. The person comes
  from the session cookie.
- Keys in the POST body are written **without** the `block-{id}-` prefix — the endpoint scopes
  them automatically.
- Using `{{ CurrentPerson.PrimaryAlias.IdKey }}` as the second param fails silently: it writes
  to a `block-{personAliasId}-*` namespace the block never reads.

## Misc

- `atob()` decodes base64 as **Latin-1**, not UTF-8 — multi-byte characters (emoji etc.) come
  out garbled. Keep JS string literals ASCII-only when round-tripping through base64 in the
  browser.
- Deleting a blueboxmoon Project via the UI removes the Project + assignee + board-card rows
  but leaves an **orphaned AttributeValue**; clean up with `DELETE /api/AttributeValues/{id}`.
- Rock's `{% sql %}` (via RenderTemplate) chokes on leading `--` comments and some table
  aliases ("Cannot find table 0") — keep queries single-statement and alias-light.
