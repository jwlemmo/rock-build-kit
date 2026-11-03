---
name: rock-plugin-deploy
description: Plan, build and package a Rock plugin for a church-specific host with backup, rollback, assembly compatibility and deployment verification.
---
# Plugin deployment
Read README.md here. Discover hosting type, deployed Rock version, target .NET Framework compatibility, assembly references, app pool, site root, backup restore procedure and deployment access. Use the administrator's actual hosting process; do not assume Azure, a server path, or a .NET version from another church. Version plugin assemblies, keep assets namespaced, and test migrations on an isolated sandbox. Show package manifest, SHA256, backup evidence and rollback plan for the exact host before production deployment. C# REST endpoints are built and deployed code; do not synthesize controllers by database rows.
