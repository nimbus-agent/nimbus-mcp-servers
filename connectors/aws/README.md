# Aws Connector

## What this is

Nimbus MCP connector for Aws. Indexes and provides context from Aws to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth aws
nimbus ask "Summarize my recent activity in Aws"
```

## Behaviour notes

- `aws_ec2_instance_get {instanceId}` (one `i-...` id) runs `aws ec2 describe-instances` and returns
  `{instanceId, state, instanceType, launchTime, tags, iamProfileArn}`, the before-state of a start or a
  stop. No instance in the reply, or the `InvalidInstanceID.NotFound` error, is "instance not found".
- `aws_ecs_service_get {cluster, service}` runs `aws ecs describe-services` and returns
  `{serviceName, status, desiredCount, runningCount, taskDefinition, launchType}` (absent fields omitted),
  the before-state of `aws_ecs_service_update`. A service in `failures` (reason MISSING), or no entry in
  `services`, is "service not found". Live check: the `failures` shape for a missing service.

## See also

- [Aws Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
