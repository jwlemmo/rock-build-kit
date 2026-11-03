---
name: rock-test
description: Test a Rock build with offline regressions, read-only connectivity, disposable sandbox records, browser verification and rollback evidence.
---
# Acceptance testing
Run `cd mcp && npm test` for offline kit regressions. Run doctor against the chosen environment. For the requested feature, define expected behavior, role-based positive/negative access, edge cases, and rollback. Use disposable sandbox fixtures with recorded IDs; never edit a real person or gift as a test. Verify browser rendering, forms, cache refresh, and changed workflow outcomes. Record exact evidence and unresolved failures, not only HTTP success. Production tests require the user's authorized scope.
