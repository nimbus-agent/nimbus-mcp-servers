# Changelog

## [0.13.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.12.0...connectors-v0.13.0) (2026-11-11)


### Features

* **google-calendar:** read-only Google Calendar connector (calendar list, event list, event get) ([#83](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/83)) ([1dcf7bc](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/1dcf7bc9cb8a1839fd8e5a467d4007bff954fe62))

## [0.12.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.11.0...connectors-v0.12.0) (2026-11-10)


### Features

* **gmail:** archive a thread (gmail_thread_archive), registered only with gmail.modify ([#81](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/81)) ([39525a9](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/39525a92174e91ba4e4c85e736608210fdc5bbf1))

## [0.11.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.10.0...connectors-v0.11.0) (2026-11-10)


### ⚠ BREAKING CHANGES

* **connectors:** kubernetes built-in diff, re-diff on apply, required context and namespace, and TestFlight public-link guard ([#79](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/79))

### Features

* **connectors:** kubernetes built-in diff, re-diff on apply, required context and namespace, and TestFlight public-link guard ([#79](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/79)) ([2ca5209](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/2ca5209639b06f19f91875d54d73ad2d8d32f112))

## [0.10.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.9.0...connectors-v0.10.0) (2026-11-09)


### Features

* **connectors:** vercel, netlify, bitrise, codemagic, testflight and firebase distribution writes ([#77](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/77)) ([7d7797c](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/7d7797cd47667cb1fa1bd10e8f71cd6d4788c015))

## [0.9.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.8.0...connectors-v0.9.0) (2026-11-08)


### ⚠ BREAKING CHANGES

* **connectors:** plan-bound terraform and cloudformation, kubernetes manifest apply, pulumi up refused ([#75](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/75))

### Features

* **connectors:** plan-bound terraform and cloudformation, kubernetes manifest apply, pulumi up refused ([#75](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/75)) ([32934d5](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/32934d5560994c3c96ecd36a0dd865cfe77f99b9))

## [0.8.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.7.0...connectors-v0.8.0) (2026-11-07)


### Features

* **connectors:** Wave 4 reads, commit tools and the prepare-tool kit ([#73](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/73)) ([3b56b31](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/3b56b3146f11f728237a216f766012a66cb7ce4d))

## [0.7.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.6.0...connectors-v0.7.0) (2026-11-07)


### Features

* **connectors:** slack blocks and views.open, teams adaptive-card attachments for ChatOps typed confirmation ([#71](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/71)) ([357e8fd](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/357e8fd38ca036283d1bb6c5301a6817bb4e7831))

## [0.6.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.5.0...connectors-v0.6.0) (2026-11-06)


### Features

* **connectors:** Wave 3 write tools for GitHub, GitLab, LaunchDarkly, Flagsmith and JSM Operations ([#69](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/69)) ([79f558a](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/79f558aa742373d08e4af80a493342fc827aec92))

## [0.5.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.4.0...connectors-v0.5.0) (2026-11-05)


### Features

* **connectors:** confluence page ancestors, an obsidian daily-note read, stricter icloud events ([#66](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/66)) ([864574a](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/864574a29491af0d474fe79151a34aa35a213446))

## [0.4.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.3.0...connectors-v0.4.0) (2026-11-05)


### Features

* **connectors:** Wave-2 write tools for GitHub, GitLab, Jira, Outlook, Discord and Confluence ([#64](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/64)) ([c7c35e6](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/c7c35e6b6e82b0aa1fffcfc7c0a69d3673e3cd72))

## [0.3.0](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.2.4...connectors-v0.3.0) (2026-10-20)


### Features

* **readwise:** self-contained extension package with sync ([#59](https://github.com/nimbus-agent/nimbus-mcp-servers/issues/59)) ([fcbc6a5](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/fcbc6a5d6bf9f4590cd39a4350d183b72506ebd1))

## [0.2.4](https://github.com/nimbus-agent/nimbus-mcp-servers/compare/connectors-v0.2.3...connectors-v0.2.4) (2026-10-05)


### Bug Fixes

* **connectors:** declare the MCP logging capability on every connector with write tools, so the consent kit's notifications reach the client, and append each audit entry before notifying ([e11b689](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/e11b6897528ba2a1c721dc7a53de8def7e3c18eb))
* **connectors:** deploy a CloudFormation template from a file with --template-file, which aws cloudformation deploy requires, read as UTF-8 by AWS CLI v1 and v2; every call failed before, and a template over 51,200 bytes is now refused before consent ([e11b689](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/e11b6897528ba2a1c721dc7a53de8def7e3c18eb))
* **connectors:** run iac_terraform_plan, apply and destroy with -chdir=DIR, which terraform requires; given -chdir DIR, every call failed ([e11b689](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/e11b6897528ba2a1c721dc7a53de8def7e3c18eb))
* **shared:** start a bare az or gcloud on Windows when the environment spells the search path Path, as a process started from PowerShell does, where both failed with ENOENT ([e11b689](https://github.com/nimbus-agent/nimbus-mcp-servers/commit/e11b6897528ba2a1c721dc7a53de8def7e3c18eb))

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
