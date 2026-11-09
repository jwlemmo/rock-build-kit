---
name: rock-test
description: Test a Rock build with offline regressions, read-only connectivity, disposable sandbox records, browser verification and rollback evidence.
---
# Acceptance testing
Run `cd mcp && npm test` for offline kit regressions. Run doctor against the chosen environment. For the requested feature, define expected behavior, role-based positive/negative access, edge cases, and rollback. Use disposable sandbox fixtures with recorded IDs; never edit a real person or gift as a test. Verify browser rendering, forms, cache refresh, and changed workflow outcomes. Record exact evidence and unresolved failures, not only HTTP success. Production tests require the user's authorized scope.

Security changes: test as a normal staff user, not an admin — impersonate a non-admin test staff person on the sandbox, then confirm someone outside the intended group gets nothing. Admins pass every check. Saves of Lava- or HTML-looking text (`{{`, `{%`, `{[`, tags) into attributes or built-in fields: after the test, check the sandbox ExceptionLog for new `AttributeValueValidationException` / `PropertyValidationException` rows; Rock 19.8.1 logs these for saves it will block once "Enable Server Model Validation" is on.
