---
name: rock-query
description: Read Rock RMS people, groups, giving, attendance, workflows and metrics using this church's configured MCP, with schema discovery and bounded queries.
---
# Query Rock
Read AGENTS.md and confirm the target. Use native search/list/get tools first. For SQL call get_schema before unfamiliar tables, use bounded SELECT/TOP or aggregates, and bracket reserved columns. execute_sql is read-only. AttributeValue uses EntityId and AttributeId; discover these IDs. Never match a person based only on a similar name. Confirm cohort, date range, campus and time zone before reporting totals. Distinguish people, families, transactions and transaction detail lines; split transactions can double-count totals. Explain partial/missing data and permission limitations. Minimize returned personal data. No write is necessary to answer a read-only question.
