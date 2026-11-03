#!/usr/bin/env python3
"""Distill the live Rock v2 OpenAPI spec into a schema crib for the tables we actually use.

Reads reference/rock-v2-openapi.json (downloaded from rock.example.org/api/v2/doc) and
emits, in the same reference/ dir:
  - rock-schema-crib.md   human/LLM-readable per-entity property list (name : type)
  - rock-schema-core.json definitions-only JSON for just the target entities (light, for a resource)
"""
import json, os

REF = os.path.dirname(os.path.abspath(__file__))
spec = json.load(open(os.path.join(REF, "rock-v2-openapi.json")))
defs = spec.get("definitions", {})

# The ~35 entities that dominate our execute_sql usage (from the audit's table-frequency stats).
TARGETS = [
    "Person", "PersonAlias", "PhoneNumber", "Group", "GroupMember", "GroupType",
    "GroupLocation", "Attribute", "AttributeValue", "Metric", "MetricValue",
    "MetricPartition", "MetricValuePartition", "MetricCategory",
    "Workflow", "WorkflowType", "WorkflowActivity", "WorkflowActivityType",
    "WorkflowAction", "WorkflowActionType", "Page", "PageRoute", "Block", "BlockType",
    "HtmlContent", "Auth", "Attendance", "AttendanceOccurrence",
    "FinancialTransaction", "FinancialTransactionDetail", "FinancialAccount",
    "DefinedValue", "DefinedType", "Location", "Schedule", "EntityType",
    "Tag", "TaggedItem", "Campus", "Category", "Report", "DataView",
]

# Entities Rock does NOT expose as Rock.Model.* in the v2 API (not REST-navigable), but that
# we query heavily in raw SQL. Columns pulled live from INFORMATION_SCHEMA.COLUMNS.
SUPPLEMENT = {
    "AttributeValue": {
        "_note": "Not a REST entity (attributes aren't navigable). SQL-only. Columns from INFORMATION_SCHEMA.",
        "columns": [
            ("Id", "int"), ("IsSystem", "bit"), ("AttributeId", "int"), ("EntityId", "int"),
            ("Value", "nvarchar"), ("Guid", "uniqueidentifier"), ("CreatedDateTime", "datetime"),
            ("ModifiedDateTime", "datetime"), ("CreatedByPersonAliasId", "int"),
            ("ModifiedByPersonAliasId", "int"), ("ForeignKey", "nvarchar"),
            ("ValueAsDateTime", "datetime"), ("ForeignGuid", "uniqueidentifier"),
            ("ForeignId", "int"), ("ValueAsNumeric", "decimal"), ("PersistedTextValue", "nvarchar"),
            ("PersistedHtmlValue", "nvarchar"), ("PersistedCondensedTextValue", "nvarchar"),
            ("PersistedCondensedHtmlValue", "nvarchar"), ("IsPersistedValueDirty", "bit"),
            ("ValueChecksum", "int"), ("ValueAsBoolean", "bit"), ("ValueAsPersonId", "int"),
        ],
    },
}

def typestr(p):
    """Render a property's type compactly."""
    if "$ref" in p:
        return p["$ref"].split("/")[-1].replace("Rock.Model.", "").replace("Rock.ViewModels.", "")
    t = p.get("type", "?")
    f = p.get("format")
    if t == "array":
        it = p.get("items", {})
        inner = it.get("$ref", "").split("/")[-1] or it.get("type", "?")
        return f"array<{inner}>"
    return f"{t}({f})" if f else t

lines = []
lines.append("# Rock RMS schema crib — core entities")
lines.append("")
lines.append("Generated from the live OpenAPI v2 spec at `rock.example.org/api/v2/doc` "
             "(Rock **v17.6.1.0**). Refresh by re-downloading that spec and re-running "
             "`build_crib.py` — Rock ships point releases roughly monthly.")
lines.append("")
lines.append("**Read this before writing ad-hoc SQL.** These are the API-layer property names "
             "(camelCase). Rock's raw SQL columns are the PascalCase form of the same names "
             "(`nickName` -> `NickName`, `givingId` -> `GivingId`), so this stops ~90% of "
             "column-name guessing. For the exact raw column list of any table, "
             "`INFORMATION_SCHEMA.COLUMNS` via `execute_sql` remains ground truth.")
lines.append("")
found, missing = [], []
core = {}
for name in TARGETS:
    key = f"Rock.Model.{name}"
    d = defs.get(key)
    if not d or "properties" not in d:
        if name in SUPPLEMENT:
            sup = SUPPLEMENT[name]
            found.append(name)
            lines.append(f"## {name}  ")
            lines.append(f"<sub>{sup['_note']} — {len(sup['columns'])} columns (PascalCase = raw SQL)</sub>")
            lines.append("")
            lines.append("```")
            for cn, ct in sup["columns"]:
                lines.append(f"{cn} : {ct}")
            lines.append("```")
            lines.append("")
        else:
            missing.append(name)
        continue
    found.append(name)
    core[key] = d
    props = d["properties"]
    lines.append(f"## {name}  ")
    lines.append(f"<sub>`{key}` — {len(props)} properties</sub>")
    lines.append("")
    lines.append("```")
    for pname in sorted(props):
        lines.append(f"{pname} : {typestr(props[pname])}")
    lines.append("```")
    lines.append("")

if missing:
    lines.append("## Not found as `Rock.Model.*` in the spec")
    lines.append("(may be named differently, be a view-model, or not be REST-exposed — "
                 "check `INFORMATION_SCHEMA` directly): " + ", ".join(missing))
    lines.append("")

open(os.path.join(REF, "rock-schema-crib.md"), "w").write("\n".join(lines))
json.dump(core, open(os.path.join(REF, "rock-schema-core.json"), "w"), indent=1)

print(f"entities found: {len(found)}/{len(TARGETS)}")
print("missing:", ", ".join(missing) if missing else "(none)")
print("crib:", os.path.join(REF, "rock-schema-crib.md"))
print("core json:", os.path.join(REF, "rock-schema-core.json"),
      f"({os.path.getsize(os.path.join(REF,'rock-schema-core.json'))//1024} KB)")
