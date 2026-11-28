# Aws Connector

## What this is

First-party Nimbus MCP connector for AWS, driven through the `aws` CLI. It reads ECS services, Lambda
function configuration and EC2 instance state, and offers four owner-approved write tools: an ECS
service update, a Lambda invoke, and an EC2 instance stop and start. The reads double as the
before-state of the writes (`aws_ecs_service_get` for the update, `aws_ec2_instance_get` for a stop or
a start).

## Install

Bundled with Nimbus — no separate install required. The connector runs the `aws` CLI, which must be
installed and on `PATH`; with it missing, the tools fail with the spawn error.

## Quickstart

```bash
nimbus connector auth aws
nimbus ask "Summarize my recent activity in Aws"
```

The gateway injects credentials as environment variables at spawn time; the connector itself never
touches the vault. It requires none of them by name: the child `aws` process gets the connector's whole
environment, so the CLI finds its credentials, profile and region the way it always does. The
connector re-sets the four below to their trimmed values when they are set and non-empty.

| Variable | Required | Purpose |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | no | Passed through to the `aws` CLI. |
| `AWS_SECRET_ACCESS_KEY` | no | Passed through to the `aws` CLI. |
| `AWS_DEFAULT_REGION` | no | Passed through to the `aws` CLI. |
| `AWS_PROFILE` | no | Passed through to the `aws` CLI. |
| `NIMBUS_MCP_AWS_WRITE_SCOPE` | standalone writes only | The write allow-list; see [The writes](#the-writes). Unset means no write is authorised. |

The reads run `aws <service> <subcommand> ... --output json`. A non-zero exit is reported as
`aws exited <code>:` followed by the first 500 characters of stderr. Every argument value a caller supplies is checked by the
`awsCliArg` schema from `shared/cli-json-kit.ts` before the CLI runs: it refuses an empty value, a
leading `-`, control characters, and a value `aws` would replace by reading a file or fetching a URL
(`file://`, `fileb://`, `http://`, `https://`, or the `@=` shorthand operator). An EC2 instance id (for the get tool) is
further limited to `i-` plus 8 to 17 lowercase hex digits, and a Lambda function to a name, partial ARN
or full ARN with an optional `:<version or alias>`.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `aws_ecs_service_list` | List the services of an ECS cluster (`aws ecs list-services --cluster <cluster>`). |
| `aws_ecs_service_get` | One ECS service (`cluster`, `service`; `aws ecs describe-services`): `serviceName`, `status`, `desiredCount`, `runningCount`, `taskDefinition`, `launchType`, absent fields omitted. A service the API reports under `failures`, or does not return, is `service not found`. |
| `aws_lambda_list` | First page of Lambda functions (`aws lambda list-functions`, no arguments), each through the allow-list below in AWS's own field names, plus `NextMarker` / `NextToken` when present. |
| `aws_lambda_get` | One function's configuration (`functionName`; `aws lambda get-function-configuration`). |
| `aws_ec2_instance_get` | One EC2 instance (`instanceId`; `aws ec2 describe-instances`): `instanceId`, `state`, `instanceType`, `launchTime`, `tags`, `iamProfileArn`. No instance in the reply, or `InvalidInstanceID.NotFound`, is `instance not found`. |
| `aws_ecs_service_update` (write) | Update an ECS service to a task definition (`cluster`, `service`, `taskDefinition`) with `--force-new-deployment`. Returns `{ok: true}`. |
| `aws_lambda_invoke` (write) | Invoke a function (`functionName`, optional `payloadJson`). Returns the function's response when it is JSON, else `{ok: true}`. |
| `aws_ec2_instance_stop` (write) | `aws ec2 stop-instances --instance-ids <instanceIds>`. Returns `{ok: true}`. |
| `aws_ec2_instance_start` (write) | `aws ec2 start-instances --instance-ids <instanceIds>`. Returns `{ok: true}`. |

The Lambda reads are an explicit allow-list: `functionName`, `functionArn`, `runtime`, `handler`, `role`,
`description`, `memorySize`, `timeout`, `codeSize`, `codeSha256`, `version`, `lastModified`,
`revisionId`, `packageType`, `architectures`, `state` and `lastUpdateStatus` (each with its reason and
reason code), `kmsKeyArn`, `tracingMode`, `ephemeralStorageSize`, `layers` (their ARNs) and
`environmentVariableNames` (sorted). Text fields are cut at 500 characters. Environment variable
**values**, `Environment.Error`, `ImageConfigResponse`, the code download URL and any field not listed
never reach the answer, and a reply that is not JSON is refused without being quoted. `aws_lambda_list`
returns the same fields under the AWS names (`FunctionName`, `Runtime`, `Layers: [{Arn}]`,
`EnvironmentVariableNames`, ...), because the gateway's invoke before-state reads them in that spelling.
`aws_lambda_get` uses `get-function-configuration` rather than `get-function` because the latter
carries a presigned URL to the deployment package.

### The writes

All four are registered through `createWriteToolRegistrar` (`shared/consent-kit.ts`). The two EC2 tools
once went through the read registrar, which offered them standalone with no consent prompt, scope check,
budget or audit record; they no longer do. `aws_lambda_invoke` declares `recoverable: false`, since an
invocation's side effects cannot be undone, and records the `functionName` as its audit pre-state; the
other three declare `recoverable: true` and capture none. Standalone, each needs owner consent and a target allowed by
`NIMBUS_MCP_AWS_WRITE_SCOPE`, a comma-separated list of `kind:value` terms matched exactly (no prefix
match; an empty or unset scope allows nothing, and an unknown kind fails at startup). The kinds are
`cluster`, `function` and `instance`.

| Write | Changes | Scope term |
| --- | --- | --- |
| `aws_ecs_service_update` | Points the service at the given task definition and forces a new deployment. | `cluster:<cluster>` |
| `aws_lambda_invoke` | Runs the function. `payloadJson` is written to a private temporary directory and handed to the CLI as a `file://` payload, never as an argument; the directory is removed however the call ends. | `function:<functionName>` |
| `aws_ec2_instance_stop` | Stops the instance(s). | `instance:<instanceIds>` |
| `aws_ec2_instance_start` | Starts the instance(s). | `instance:<instanceIds>` |

The scope value is compared with the argument exactly as given: a function by the same name or ARN
spelling, and `instanceIds` as the one string passed.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
