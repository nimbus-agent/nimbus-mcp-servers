# Jenkins Connector

## What this is

First-party Nimbus MCP connector for Jenkins. Exposes jobs, builds and build console output to the
Nimbus agent (`jenkins_job_list`, `jenkins_job_get`, `jenkins_build_list`, `jenkins_build_get`,
`jenkins_build_log_tail`), plus two owner-approved write tools (`jenkins_build_trigger`,
`jenkins_build_abort`). Useful for incident correlation and for asking why a build failed.

Indexes and provides context from Jenkins to the Nimbus agent.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus connector auth jenkins
nimbus ask "Summarize my recent activity in Jenkins"
```

The gateway injects the credentials as environment variables at spawn time; the connector itself
never touches the vault. They are read on every call.

| Variable | Required | Purpose |
| --- | --- | --- |
| `JENKINS_BASE_URL` | yes | The Jenkins root URL. Trailing slashes are stripped. There is no default. |
| `JENKINS_USERNAME` | yes | The Jenkins user, the username half of the Basic credential. |
| `JENKINS_API_TOKEN` | yes | That user's API token, the password half of the Basic credential. |

Requests go to `${JENKINS_BASE_URL}/...` with an `Authorization: Basic` header. A job is addressed by
its full name (`folder/sub/job`), each segment URL-encoded into `/job/<a>/job/<b>`. A state-changing
POST first asks `/crumbIssuer/api/json` for a CSRF crumb and sends it under the header name Jenkins
gives, provided that name is a legal header field name; the crumb is cached for the life of the
process. If no crumb is available the POST goes out without one.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `jenkins_job_list` | List jobs as flat `fullName` and `url` pairs, descending through folders to a limited depth (the job tree is fetched four levels deep). |
| `jenkins_job_get` | Get a job's metadata by `jobName` (full name, e.g. `folder/sub/job`). |
| `jenkins_build_list` | List a job's recent builds (number, url, result, duration, timestamp, building) by `jobName`; `limit` 1 to 50 (default 20). |
| `jenkins_build_get` | Get one build by `jobName` and `buildNumber`. |
| `jenkins_build_log_tail` | Fetch a build's console text and return the last `maxLines` lines (1 to 5000, default 200) with the total `lineCount`. The whole log is downloaded and trimmed in the connector. |
| `jenkins_build_trigger` (write) | Trigger a new build of `jobName` (`POST <job>/build`). No build parameters are passed. |
| `jenkins_build_abort` (write) | Stop a running build by `jobName` and `buildNumber` (`POST <job>/<n>/stop`). |

### The writes

Both go through the consent registrar and are declared `recoverable: true`. Outside the gateway each
is gated by owner consent, a write-scope allow-list, a mutation budget and an audit record; in the
gateway the executor is the gate. Scope them with `NIMBUS_MCP_JENKINS_WRITE_SCOPE`, a comma-separated
list of `job:<full job name>` terms with exact matching, so `job:folder/deploy` does not authorise
`folder/deploy-prod`. An unset or empty scope refuses every write, and an unknown kind fails at
startup.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
