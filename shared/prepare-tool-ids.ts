/**
 * The prepare class: tools the gateway calls BEFORE a write's approval prompt to read the state the
 * write is bound to (the branch head a commit was prepared against).
 *
 * This is ONE literal list on purpose. The gateway reads it as text, the way it scans the write
 * manifest, and `createPrepareToolRegistrar` (consent-kit.ts) registers a tool only when its name
 * is here. A naming convention would not do: a suffix rule passes `*_files_get`-style names that
 * the gateway treats as plain reads, and ids of the same class do not share a suffix.
 *
 * Grows per release: 0.8.0 listed the two commit tools; the next release adds the Terraform plan,
 * destroy-plan and show-json tools, the CloudFormation change-set create and the Kubernetes
 * manifest plan. `prepare-tool-ids.test.ts` requires every id here to be registered exactly once,
 * through `createPrepareToolRegistrar` and nothing else.
 */
export const PREPARE_TOOL_IDS = [
  "github_commit_prepare",
  "gitlab_commit_prepare",
  "iac_terraform_plan",
  "iac_terraform_destroy_plan",
  "iac_terraform_show_json",
  "iac_cloudformation_changeset_create",
  "k8s_manifest_plan",
] as const;

export type PrepareToolId = (typeof PREPARE_TOOL_IDS)[number];

/** Whether `name` is a listed prepare tool id. */
export function isPrepareToolId(name: string): name is PrepareToolId {
  return (PREPARE_TOOL_IDS as readonly string[]).includes(name);
}
