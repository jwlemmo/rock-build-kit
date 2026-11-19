## Rock 19.8 and the road to v20/v21
- **19.8 REST hardening** — expect 401/403 where 19.4 allowed it: changing blocks, attributes,
  REST security, persisted datasets, workflow triggers, person aliases or entity types over REST
  needs **Administrate**; REST changes to workflow action types are admin-only by default; a
  workflow launched over REST checks the workflow type's permissions; changing a metric's SQL/Lava
  source needs Administrate; binary file endpoints apply file security. (traced from the 19.8
  release notes; not tested live by this kit)
- **19.8 Lava/text changes:** Communication recipient addresses no longer render Lava (except a
  System Communication's To); Entity Property Set, Entity Attribute Set and Redirect to Page
  workflow actions treat attribute values as plain text.
- **v1 REST rejects nested related records** (issue #7144, hotfix in 19.8.1): a POST carrying
  child records, or a PATCH naming a related collection, fails with "save them separately".
  Allow-listed: TransactionDetails, PhoneNumbers, ScheduledTransactionDetails. Since 19.5 (#7083)
  a v1 REST insert needs Edit on the new entity.
- **"Enable Server Model Validation"** (Admin Tools > Settings > Security > Security Settings;
  needs a restart) will block saves that 19.8.1 already logs as
  `AttributeValueValidationException` / `PropertyValidationException`. Any value containing `{{`,
  `{%` or `{[` counts as Lava — even JSON. New builds: put Lava/HTML/JSON only in attribute types
  that allow it (Text with Allow Lava/HTML, Memo, HTML, Code Editor, Lava, Structured Content).
- **Removals coming:** v20 removes the legacy WebForms Workflow Entry block; v21 removes Dynamic
  Data, Page Parameter Filter, Activate Workflow, core FontAwesome support and Lava
  `{% execute %}`. New builds: Obsidian Workflow Entry, no Dynamic Data, no `execute`. Count your
  own uses before an upgrade (details in the kit root's `reference/rock-field-notes.md`).

