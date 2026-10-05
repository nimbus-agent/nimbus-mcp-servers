# Changelog

## [0.2.3](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.2.2...connectors-v0.2.3) (2026-10-05)


### Bug Fixes

* **connectors:** check every argument kubernetes, gcp, azure, aws and iac pass to a CLI, so a pod, deployment, service or cluster name can no longer reach kubectl or gcloud as a flag such as --kubeconfig ([849f0c0](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/849f0c04bbee1f811319b7e792bb2ec356b9062b))
* **connectors:** refuse aws argument values starting with file://, fileb://, http:// or https:// or holding @=, and az values starting with @ or holding =@, which the CLI would replace by a local file's contents ([849f0c0](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/849f0c04bbee1f811319b7e792bb2ec356b9062b))
* **shared:** on Windows, refuse an argument holding a cmd.exe metacharacter when the CLI found first on PATH is a batch file such as az.cmd or gcloud.cmd, whose arguments cmd.exe parses a second time and could run a second command from ([849f0c0](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/849f0c04bbee1f811319b7e792bb2ec356b9062b))
* **shared:** refuse a write budget that is not plain digits instead of running uncapped ([cf7f0ed](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/cf7f0ed0bd73db19f7dd67cc0690e99c82bf6795))
* **shared:** report an audit-log line that parses as JSON but has no string prev or hash link as the place the chain breaks, where verification used to throw a TypeError ([f1ce53a](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/f1ce53a213abadf4cae8208351b51cc78329ab8b))
* **shared:** serialise audit-log appends within a connector and, through a lock file beside the log, across connector processes sharing one NIMBUS_MCP_AUDIT_LOG, so parallel writes no longer break the hash chain ([f1ce53a](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/f1ce53a213abadf4cae8208351b51cc78329ab8b))
* **shared:** stop a connector with write tools at startup on an empty write budget, or one with a sign, decimal point, exponent or hex prefix such as -1, +5, 10.0 or 1e3, all of which used to be read as some number ([cf7f0ed](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/cf7f0ed0bd73db19f7dd67cc0690e99c82bf6795))
* **shared:** stop parallel write calls from overrunning the budget ([cf7f0ed](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/cf7f0ed0bd73db19f7dd67cc0690e99c82bf6795))
* **shared:** when a write tool ran but recording it failed, say the tool ran instead of recording the write as failed, and when both the tool and its failure record fail, report the tool's own error first ([f1ce53a](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/f1ce53a213abadf4cae8208351b51cc78329ab8b))

## [0.2.2](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.2.1...connectors-v0.2.2) (2026-10-04)


### Bug Fixes

* **apple:** let one write scope enable both the mail and the calendar writes ([9082176](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9082176abfdb990121b6fdd3232f967bfbbfbe31))
* **argocd:** read the documented NIMBUS_MCP_ARGOCD_WRITE_SCOPE ([9082176](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9082176abfdb990121b6fdd3232f967bfbbfbe31))
* **aws:** remove the aws_lambda_invoke temp directory however the call ends ([9082176](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9082176abfdb990121b6fdd3232f967bfbbfbe31))
* **bitbucket:** refuse a next-page URL on another host instead of sending it the credentials ([9082176](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9082176abfdb990121b6fdd3232f967bfbbfbe31))
* **connectors:** register four mutating tools through the consent kit ([9082176](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9082176abfdb990121b6fdd3232f967bfbbfbe31))
* **connectors:** request six list and search tools relative to their API base ([9082176](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9082176abfdb990121b6fdd3232f967bfbbfbe31))
* **deps:** update the MCP SDK, zod, imapflow, nodemailer, tsdav and hyparquet to their latest releases ([9082176](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9082176abfdb990121b6fdd3232f967bfbbfbe31))
* **kubernetes:** record the namespace a pod delete defaulted to ([9082176](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9082176abfdb990121b6fdd3232f967bfbbfbe31))
* **shared:** hash an audit entry exactly as it is written ([9082176](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9082176abfdb990121b6fdd3232f967bfbbfbe31))

## [0.2.1](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.2.0...connectors-v0.2.1) (2026-08-27)


### Bug Fixes

* green the Sonar gate by fixing the code, not by excluding it ([#18](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/18)) ([9823f33](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/9823f33da4eb9c538ef9fe51161d3a7898dff6b9))

## [0.2.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.1.1...connectors-v0.2.0) (2026-08-27)


### Features

* port the connector entrypoint and dependency gates from the monorepo ([#5](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/5)) ([1be32e6](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/1be32e63e39651d8a1a698673dd9304a8e352bb9))
* port the sandbox contract runner from the monorepo ([#6](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/6)) ([04c0392](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/04c039293c5427de608dff75ccd1bbce149da650))


### Bug Fixes

* ship the types consumers need, and export ./package.json (0.1.2) ([#7](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/7)) ([be6780d](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/be6780d6a1c9bff8e78e8b3e447e10aeac03fda8))
