# Iac Connector

Terraform, CloudFormation and Pulumi helpers. The connector opens no sockets itself; the CLIs it
spawns (`terraform`, `aws`, `pulumi`) are bounded by the sandbox the gateway puts them in.

## Tools

| Tool | Kind | What it does |
| --- | --- | --- |
| `iac_terraform_plan` | prepare | `terraform plan -out=<file>` in a directory; saves the plan and returns `{planId, planFile, planSha256, hasChanges}` |
| `iac_terraform_destroy_plan` | prepare | the same with `-destroy` |
| `iac_terraform_plan_refresh_only` | prepare | `terraform plan -refresh-only -out=<file>`; saves `refresh.tfplan` and returns `{planId, planFile, planSha256, hasChanges}` (`hasChanges` means the state would change) |
| `iac_terraform_show_json` | prepare | `terraform show -json <planFile>`; returns `{planJson, planSha256}` (at most 4 MiB, must parse; the hash of the bytes it rendered) |
| `iac_terraform_apply` | write | applies a saved plan file whose SHA-256 equals `planSha256` |
| `iac_terraform_destroy` | write | the same tool body for a plan made by `iac_terraform_destroy_plan` |
| `iac_terraform_apply_refresh_only` | write | applies a saved `refresh.tfplan` whose SHA-256 equals `planSha256`: accepts drift into the state. It first renders the file with `terraform show -json` and refuses unless every resource change is a no-op (a data source may be read) and the plan saves no provider action (`action_invocations`), so a plan that would change infrastructure is never applied under this tool |
| `iac_terraform_init` | write | `terraform -chdir=<dir> init -input=false -no-color`, nothing else: the caller chooses only the directory (the same `workingDirectory` and `dir:` scope as `iac_terraform_plan`), so no `-upgrade`, `-reconfigure`, `-migrate-state`, `-backend-config` or any other flag. Writes `.terraform/` and `.terraform.lock.hcl` and fetches the providers and modules the configuration names. Answers `{ok, status:"initialized"}`; a failure is terraform's exit code and at most 500 characters of its stderr |
| `iac_cloudformation_changeset_create` | prepare | creates a change set for a template and lists its changes |
| `iac_cloudformation_changeset_discard` | write | deletes a change set this connector made, and the empty stack shell it left |
| `iac_cloudformation_deploy` | write | executes a reviewed change set; answers `execution started`, never "deployed" |
| `iac_cloudformation_stack_get` | read | `{exists:false}` or `{exists:true, status, statusReason, lastUpdatedTime}` |
| `iac_cloudformation_changesets_list` | read | `aws cloudformation list-change-sets --stack-name <s> --no-paginate`: one page, at most 100, as `{stackName, changeSets:[{changeSetName, changeSetId, status, executionStatus, statusReason, creationTime}], more}` (`more` when AWS has another page or the page was cut; a reason is capped at 500 characters) |
| `iac_cloudformation_changeset_get` | read | `aws cloudformation describe-change-set --stack-name <s> --change-set-name <name or ARN>`, every page of changes followed (the same 500-change and 256 KiB bounds as `changeset_create`): `{changeSetName, changeSetId, stackName, status, executionStatus, statusReason, creationTime, capabilities, parameterKeys, changes}`. Parameter **values** are never returned, only their keys. A `ChangeSetNotFound` is "change set not found". A change set named by ARN identifies its own stack, and AWS may then ignore `--stack-name`, so a reply whose `StackName` (or `StackId`) is not the requested stack is refused: "change set belongs to a different stack" |
| `iac_pulumi_preview` | read | `pulumi preview` |
| `iac_pulumi_up` | write | **always refused** (see below) |

A prepare tool is called by the gateway before an approval prompt, to read the state the write is
bound to. It spends no write budget and never prompts.

### The writes

Seven tools are registered through the consent registrar. Outside the gateway each is gated by
owner consent, a write-scope allow-list, a mutation budget and an audit record; in the gateway the
executor is the gate. Scope them with `NIMBUS_MCP_IAC_WRITE_SCOPE`, a comma-separated list of
`kind:value` terms matched exactly. Two kinds exist: `dir:<workingDirectory>`, matched against the
`workingDirectory` argument as given, and `stack:<stackName>`, matched against `stackName`. An
unknown kind fails at startup, and an unset or empty scope refuses every write.

| Tool | Changes | Recoverable | Scope target |
| --- | --- | --- | --- |
| `iac_terraform_apply` | Applies a saved `plan.tfplan` whose SHA-256 matches. | `false`; `capturePreState` records `{workingDirectory, planFile, planSha256}`, the plan's identity. | `dir:<workingDirectory>` |
| `iac_terraform_destroy` | Applies a saved `destroy.tfplan` whose SHA-256 matches. | `false`; the same pre-state. | `dir:<workingDirectory>` |
| `iac_terraform_apply_refresh_only` | Applies a saved `refresh.tfplan`, accepting drift into the state. | `false`; the same pre-state. | `dir:<workingDirectory>` |
| `iac_terraform_init` | Runs `terraform init`, writing `.terraform/` and `.terraform.lock.hcl` and fetching providers and modules. | `false`; `capturePreState` records `{workingDirectory}`. | `dir:<workingDirectory>` |
| `iac_cloudformation_changeset_discard` | Deletes a change set this connector made, and the empty stack shell it left. | `false`; `capturePreState` records whether the change set exists and, if so, its `status` and `executionStatus`. | `stack:<stackName>` |
| `iac_cloudformation_deploy` | Executes a reviewed change set. | `false`; `capturePreState` records whether the stack exists, its `stackStatus` and `lastUpdatedTime`. | `stack:<stackName>` |
| `iac_pulumi_up` | Nothing: it is always refused before the scope check, and spawns no process. | `false`; `capturePreState` records `{workingDirectory}`, though the refusal means it never runs. | `dir:<workingDirectory>` |

The prepare tools are checked against the same scope and are audited as `prepared`, though they are
not writes and spend no budget: `iac_terraform_plan`, `iac_terraform_destroy_plan`,
`iac_terraform_plan_refresh_only` and `iac_terraform_show_json` use `dir:<workingDirectory>`, and
`iac_cloudformation_changeset_create` uses `stack:<stackName>`.

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `NIMBUS_IAC_PLAN_DIR` | every terraform tool but `iac_terraform_init` (which saves no plan): the plan tools, `show_json`, apply and destroy | Absolute path of an existing real directory (not a link). Each plan is saved in a fresh 0700 directory `<dir>/<planId>/plan.tfplan` (`destroy.tfplan` for a destroy plan); apply, destroy and `show_json` take only a plan file inside it. Missing or invalid: the tool fails before running anything. |
| `NIMBUS_CONNECTOR_SCRATCH_DIR` | `iac_cloudformation_changeset_create` | Absolute directory for the template file (a 0700 directory per call, removed afterwards). Unset: the OS temp directory, except on Windows under the gateway, where the tool refuses. |
| `NIMBUS_MCP_IAC_WRITE_SCOPE` | standalone mode | `dir:<path>` and `stack:<name>` terms. Since this release the five prepare tools (`iac_terraform_plan`, `iac_terraform_destroy_plan`, `iac_terraform_plan_refresh_only`, `iac_terraform_show_json`, `iac_cloudformation_changeset_create`) are scope-checked too. |

Every terraform child runs with `TF_IN_AUTOMATION=1` and `TF_INPUT=0`.

## Breaking changes (for standalone users)

- `iac_terraform_apply` / `iac_terraform_destroy` no longer take only a directory and no longer
  pass `-auto-approve`. They need a `planFile` and `planSha256` from `iac_terraform_plan` /
  `iac_terraform_destroy_plan`, and apply exactly that plan. A different file is refused with no
  process started.
- `iac_cloudformation_deploy` no longer runs `aws cloudformation deploy`. It needs a `changeSetId`
  from `iac_cloudformation_changeset_create` made for exactly this template (the change set name is
  `nimbus-<sha256 of the template>-<12 hex>`), and `CAPABILITY_IAM` is no longer assumed: pass
  `capabilities` (at most `CAPABILITY_IAM`, `CAPABILITY_NAMED_IAM`, `CAPABILITY_AUTO_EXPAND`, none
  repeated), which must equal what the change set was made with.
- `iac_pulumi_up` is refused on every door and starts nothing. Pulumi's saved update plans are
  documented as experimental, so there is no plan-bound apply to approve (OR-W34-2).
- `iac_terraform_plan` is no longer a plain read: it saves a plan file and is scope-checked in
  standalone mode, so it needs `NIMBUS_MCP_IAC_WRITE_SCOPE` to name the directory.

## Stated bounds

- **The plan file is handed to terraform by path, not copied.** The hash is taken from, and
  `terraform apply` is given, the same path, and the connector reads it once. A process that can
  write that file between the hash and the apply could still swap it. Making the plan file's
  directory read-only (or otherwise unwritable by anything but the gateway) after approval is the
  gateway's job; this connector cannot close that window.
- Plan files are refused unless they are absolute, a regular file (not a link) and at most 64 MiB.
  `planFile` is an argument-checked path of at most 1024 characters.
- A change-set reply is capped at 500 changes and 256 KiB; a larger one deletes the change set and
  fails. Polling gives up after 120 s and deletes the change set.
- Cleanup deletes a stack only when it is `REVIEW_IN_PROGRESS` and holds no change set at all.
- A template is limited to 51,200 bytes as UTF-8 (it is sent as `--template-body file://...`, with
  no S3 bucket).

### Unconfirmed against live tools (checked only against fakes)

- **U: stale plan.** The text terraform prints when `apply <file>` is given a stale plan is shown as
  the CLI's stderr; the connector does not interpret it.
- **U: `apply <file> -input=false`.** That `terraform apply -input=false -no-color <file>` takes a
  saved plan without a prompt and without `-auto-approve` (documented for saved plans; not run live).
- **U: `show -json` without `init`.** `terraform show -json <plan>` may need an initialised working
  directory; a failure is returned as the CLI's stderr.
- **U: `--next-token`.** `describe-change-set --next-token <tok>` is followed by hand. AWS CLI v2
  may paginate by itself and print no token; then the single reply is used.
- **U: no-changes change set.** A template with no changes is expected to end `FAILED` with a
  `StatusReason` saying so; that reason is returned as the error (after the change set is deleted).
- **U: describe-stacks wording.** A missing stack is recognised by "does not exist" in stderr, and a
  missing change set by `ChangeSetNotFound` or "does not exist".

## Further bounds (security review)

- **Plan confinement.** `iac_terraform_apply`, `iac_terraform_destroy` and `iac_terraform_show_json`
  all need `NIMBUS_IAC_PLAN_DIR`. The plan file's real path (symlinks resolved) must lie strictly
  inside the real plan directory, and that real path is what is hashed and given to terraform.
  Device and network forms (`\\?\`, `\\.\`, UNC) are refused. The gateway must place the plan inside
  the plan directory it grants that spawn.
- **Plan kind is its file name.** `iac_terraform_plan` writes `plan.tfplan`,
  `iac_terraform_destroy_plan` writes `destroy.tfplan`, `iac_terraform_plan_refresh_only` writes
  `refresh.tfplan`; apply takes only the first, destroy only the second, the refresh-only apply only
  the third, `show_json` any of them. `show_json` also returns the SHA-256 of the bytes it read just before
  rendering them.
- A successfully applied plan file is deleted, best effort (a directory the gateway made read-only
  keeps it).
- **Discard.** When the change set is not found, nothing else is done. The empty stack shell is
  deleted only after this call itself deleted a change set of the named stack. There remains a race
  between `list-change-sets` and `delete-stack`: a change set added in between is lost with the
  empty stack.
- **`workingDirectory` is not bound to the plan in standalone mode.** Terraform takes the backend
  from the saved plan; the human sees both values in the prompt. Under the gateway both come from
  one prepare.
- **Template content is bound only by the change-set name** (the SHA-256 of the template in
  `nimbus-<sha>-<12 hex>`). A `get-template` comparison was dropped because CloudFormation
  re-serialises templates.
- No spawn timeout (repo-wide, pre-existing). Stderr echoed in errors is capped at 500 characters.
- **`iac_terraform_show_json` returns the plan JSON as Terraform renders it**, sensitive values
  included (Terraform marks them with `*_sensitive` but prints them). It is a prepare tool: under
  the gateway its reply is for the gateway's own preview render, never handed to the model as is;
  a standalone client should treat it as secret.
- **A standalone approval shows a hash, not the plan.** The apply prompt names `planFile`,
  `planSha256` and `workingDirectory`; run `iac_terraform_show_json` on the same file first to see
  what that hash stands for.
- Discard deletes only a change set whose name has this connector's exact shape,
  `nimbus-<template sha256>-<12 hex>`; a person's own `nimbus-…` change set is refused.

## Quickstart

```bash
nimbus connector auth iac --enable
nimbus ask "Plan the terraform in infra/prod"
```

## See also

- [Iac Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
