# Changelog

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
