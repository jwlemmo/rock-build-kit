## Data hygiene & security
- **Retention ≠ deletion:** `CompletedWorkflowRetentionPeriod` does NOT remove `SignatureDocument`
  rows or their `BinaryFile` bytes — a purge/archive script is the authoritative cleaner. FK-safe
  delete order per workflow: SignatureDocuments (`EntityTypeId=<discover Workflow EntityType ID> AND EntityId=<wf>` — approver
  flows have TWO) → BinaryFiles (file-attr guids + sigdoc binaries, deduped) → AttributeValue rows
  → the Workflow row. **AttributeValue deletes must always be scoped `AttributeId + EntityId`** —
  `EntityId` is NOT unique across entity types.
- **`GetFile.ashx?guid=` serves files with NO authentication** when the BinaryFileType has
  `RequiresViewSecurity=false` — the unguessable GUID is the only secret. For sensitive files set
  it true + grant View (note: flipping it breaks already-emailed links). Since 19.8 the binary
  file REST endpoints also apply file security.
- **The `PersonTokenCreate` and `PersonById` Lava filters have no security check** — never expose
  them to user-controlled input on a public page.
- **Rock keeps every AI agent chat forever** in `AIAgentSession` / `AIAgentSessionHistory`,
  including full tool results; no cleanup setting yet. Treat those tables as sensitive.
- **Plugin REST controllers can arrive with no Auth rows** and inherit the entity-wide
  RestController default. Check a new plugin's controllers after install.
- **Verify a GroupId is actually a security role before granting** — group ids are easy to
  transpose and a family group nearly got used as "staff" in a real build. Cross-check the name
  (`SELECT Name FROM [Group] WHERE Id=…`) against a known-good page's Auth rows.
- **Every WorkflowEntry page view persists a workflow instance** (IsPersisted types) — stray
  Actives are inherent, not a bug; sweep them in the purge job.
- **Ship gate:** before any e-sign/form build goes live, run an adversarial second-model review
  (e.g. `/codex:review`) — on the check-request build it caught 6 real security bugs (unescaped
  AI-output XSS, SQL injection via a client-writable Memo, fail-open secret checks, an Enter-key
  guard bypass). Never trust client-side validation alone: re-validate server-side (RunLava →
  error attr → reactivate-form loop).

