# Portable plugin workflow

1. Discover Rock version and compile against its supported assemblies/framework. Keep your plugin namespace unique.
2. Build in an isolated SDK environment, add assembly and asset files to a staging directory. Never package connection strings or web.config.
3. `node ops/rock-plugin-deploy/package.mjs /absolute/staging /absolute/output.zip` validates the paths and writes a checksum manifest and ZIP. Requires Python 3 for the standard-library ZIP writer.
4. On the target host, use the church hosting provider's approved deployment path. Record expected host, database and site root. Verify a usable backup/restore point first; stop if any target differs.
5. Stage assets before replacing assemblies, perform a controlled app recycle, inspect plugin migration results and exception logs, test affected routes and authorization, then verify in a browser.
6. Rollback needs the prior binaries/assets plus a database plan. Replacing a DLL does not reverse schema/data migrations. Rehearse before production.

Azure Run Command, SSH, IIS and hosted Rock services all require different installation steps. No host-specific automatic installer is included. Ask the local agent to generate a reviewed deployment script from the discovered target and this plan.
