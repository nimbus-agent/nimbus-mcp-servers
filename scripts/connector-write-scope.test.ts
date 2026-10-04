/**
 * Every write tool's STANDALONE gate, asserted one tool at a time.
 *
 * Outside the gateway the consent kit checks each mutation against
 * `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE` before it asks a human, using the target the tool's own
 * `scopeTargetOf` derives from its arguments. That derivation IS the allow-list: a tool that scoped
 * its writes by the wrong argument would let an operator's `repo:acme/api` authorise a mutation
 * somewhere else. Almost nothing exercised it, because every other tools test runs in gateway
 * mode, where the gateway is the gate and the scope is never read.
 *
 * So for every write tool this asserts, with no request and no subprocess allowed:
 *
 *   - OUT of scope: a scope naming the same kind with a different value refuses, naming exactly the
 *     target, before any prompt;
 *   - IN scope: the exact term clears the scope check — the human is asked, about the tool's own
 *     action type — and a declined prompt still sends nothing.
 *
 * Together those pin both halves of the target, kind and value, and the action type the human is
 * shown. The variable is derived from the connector id, which is what the docs promise; writing the
 * table found two connectors whose writes could not be enabled at all (apple's two registrars that
 * each rejected the other's scope kind, and argocd reading `NIMBUS_MCP_APP_WRITE_SCOPE`).
 *
 * The table is checked against the tree in both directions — the connectors that register a write
 * tool, and each one's write tools as an eliciting client sees them — so a new write tool fails here
 * until its scope target is written down.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppleTools } from "../connectors/apple/src/tools.ts";
import { registerArgocdTools } from "../connectors/argocd/src/server.ts";
import { registerAwsTools } from "../connectors/aws/src/tools.ts";
import { registerAzureTools } from "../connectors/azure/src/tools.ts";
import { registerBigeyeTools } from "../connectors/bigeye/src/server.ts";
import { registerBitbucketTools } from "../connectors/bitbucket/src/tools.ts";
import { registerCircleciTools } from "../connectors/circleci/src/tools.ts";
import { registerConfluenceTools } from "../connectors/confluence/src/tools.ts";
import { registerFastmailTools } from "../connectors/fastmail/src/tools.ts";
import { registerFluxTools } from "../connectors/flux/src/server.ts";
import { registerGcpTools } from "../connectors/gcp/src/tools.ts";
import { registerGithubTools } from "../connectors/github/src/tools.ts";
import { registerGithubActionsTools } from "../connectors/github-actions/src/tools.ts";
import { registerGitlabTools } from "../connectors/gitlab/src/tools.ts";
import { registerGmailTools } from "../connectors/gmail/src/tools.ts";
import { registerGoogleDriveTools } from "../connectors/google-drive/src/tools.ts";
import { registerIacTools } from "../connectors/iac/src/tools.ts";
import { registerImapTools } from "../connectors/imap/src/tools.ts";
import { registerJenkinsTools } from "../connectors/jenkins/src/tools.ts";
import { registerJiraTools } from "../connectors/jira/src/tools.ts";
import { registerKubernetesTools } from "../connectors/kubernetes/src/tools.ts";
import { registerLinearTools } from "../connectors/linear/src/tools.ts";
import { registerLookerTools } from "../connectors/looker/src/server.ts";
import { registerMlflowTools } from "../connectors/mlflow/src/server.ts";
import { registerMonteCarloTools } from "../connectors/monte-carlo/src/server.ts";
import { registerNotionTools } from "../connectors/notion/src/tools.ts";
import { registerObsidianTools } from "../connectors/obsidian/src/tools.ts";
import { registerOnedriveTools } from "../connectors/onedrive/src/tools.ts";
import { registerOutlookTools } from "../connectors/outlook/src/tools.ts";
import { registerPagerdutyTools } from "../connectors/pagerduty/src/tools.ts";
import { registerPowerBiTools } from "../connectors/powerbi/src/server.ts";
import { registerProtonmailTools } from "../connectors/protonmail/src/tools.ts";
import { registerSlackTools } from "../connectors/slack/src/tools.ts";
import { registerSnowflakeTools } from "../connectors/snowflake/src/server.ts";
import { registerTableauTools } from "../connectors/tableau/src/server.ts";
import { registerTeamsTools } from "../connectors/teams/src/tools.ts";
import { resetConnectorModeForTests, setConnectorMode } from "../shared/connector-mode.ts";
import { registersWriteTool } from "../standalone/src/launcher.ts";
import { connectorDirs } from "./check-connector-consent.ts";
import {
  type ConnectorRegistrar,
  captureStandaloneTools,
  type StandaloneCapture,
  stubFetch,
  stubSpawn,
  withEnv,
} from "./connector-tool-harness.ts";
import { fixtureFor, type ParsableSchema } from "./tool-arg-fixture.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/**
 * A collaborator any call to which fails the test: the mail and calendar connectors take their
 * clients injected, and nothing this file does may reach one.
 */
const UNREACHABLE: never = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("a write reached its client before consent");
    },
  },
) as never;

/** One write tool, the arguments it is called with, and the scope term they must name. */
type WriteCase = readonly [
  tool: string,
  mutates: string,
  args: Record<string, unknown>,
  target: string,
];

const MAIL_TO = { to: "ada@example.com" };
const GITHUB_REPO = { owner: "acme", repo: "api" };

/**
 * Every connector that registers a write tool, with each write tool's expected scope target.
 *
 * Arguments name only what the target is derived from; `fixtureFor` supplies the rest. A tool
 * whose target falls back to a default when an argument is omitted is listed twice, with and
 * without it.
 */
const WRITES: Readonly<
  Record<string, { readonly register: ConnectorRegistrar; readonly cases: readonly WriteCase[] }>
> = {
  apple: {
    register: (server: never) =>
      registerAppleTools(server, {
        client: UNREACHABLE,
        mailer: UNREACHABLE,
        draftAppender: UNREACHABLE,
        calendar: UNREACHABLE,
        now: () => "20260101T000000Z",
      }),
    cases: [
      ["apple_mail_send", "apple.mail.send", MAIL_TO, "recipient:ada@example.com"],
      ["apple_mail_draft_create", "apple.mail.draft.create", MAIL_TO, "recipient:ada@example.com"],
      [
        "apple_calendar_event_create",
        "apple.calendar.event.create",
        { calendar: "Work" },
        "calendar:Work",
      ],
      ["apple_calendar_event_create", "apple.calendar.event.create", {}, "calendar:default"],
      [
        "apple_calendar_event_delete",
        "apple.calendar.event.delete",
        { href: "/calendars/work/evt-1.ics" },
        "calendar:/calendars/work/evt-1.ics",
      ],
    ],
  },
  argocd: {
    register: registerArgocdTools,
    cases: [
      ["argocd_app_sync", "argocd.app.sync", { name: "web" }, "app:web"],
      ["argocd_app_rollback", "argocd.app.rollback", { name: "web" }, "app:web"],
    ],
  },
  aws: {
    register: registerAwsTools,
    cases: [
      [
        "aws_ec2_instance_start",
        "aws.ec2.instance.start",
        { instanceIds: "i-0abc" },
        "instance:i-0abc",
      ],
      [
        "aws_ec2_instance_stop",
        "aws.ec2.instance.stop",
        { instanceIds: "i-0abc" },
        "instance:i-0abc",
      ],
      ["aws_ecs_service_update", "aws.ecs.service.update", { cluster: "prod" }, "cluster:prod"],
      ["aws_lambda_invoke", "aws.lambda.invoke", { functionName: "resize" }, "function:resize"],
    ],
  },
  azure: {
    register: registerAzureTools,
    cases: [
      [
        "azure_aks_node_pool_scale",
        "azure.aks.node_pool.scale",
        { resourceGroup: "rg-prod" },
        "resource_group:rg-prod",
      ],
      [
        "azure_app_service_restart",
        "azure.app_service.restart",
        { resourceGroup: "rg-prod" },
        "resource_group:rg-prod",
      ],
    ],
  },
  bigeye: {
    register: registerBigeyeTools,
    cases: [
      ["bigeye_issue_acknowledge", "bigeye.issue.acknowledge", { issueId: "41" }, "issue:41"],
      ["bigeye_issue_resolve", "bigeye.issue.resolve", { issueId: "41" }, "issue:41"],
    ],
  },
  bitbucket: {
    register: registerBitbucketTools,
    cases: [
      ["bitbucket_pr_merge", "bitbucket.pr.merge", { repoFull: "acme/api" }, "repo:acme/api"],
    ],
  },
  circleci: {
    register: registerCircleciTools,
    cases: [
      [
        "circleci_pipeline_trigger",
        "circleci.pipeline.trigger",
        { projectSlug: "gh/acme/api" },
        "project:gh/acme/api",
      ],
      [
        "circleci_job_cancel",
        "circleci.job.cancel",
        { projectSlug: "gh/acme/api" },
        "project:gh/acme/api",
      ],
    ],
  },
  confluence: {
    register: registerConfluenceTools,
    cases: [
      ["confluence_page_create", "confluence.page.create", { spaceKey: "ENG" }, "space:ENG"],
      ["confluence_kb_append", "confluence.knowledge.write", { spaceKey: "ENG" }, "space:ENG"],
      ["confluence_page_update", "confluence.page.update", { pageId: "1234" }, "page:1234"],
      ["confluence_comment_add", "confluence.comment.add", { pageId: "1234" }, "page:1234"],
    ],
  },
  fastmail: {
    register: (server: never) => registerFastmailTools(server, UNREACHABLE),
    cases: [["fastmail_mail_send", "fastmail.mail.send", MAIL_TO, "recipient:ada@example.com"]],
  },
  flux: {
    register: registerFluxTools,
    cases: [
      [
        "flux_kustomization_reconcile",
        "flux.kustomization.reconcile",
        { namespace: "apps" },
        "namespace:apps",
      ],
      [
        "flux_helmrelease_reconcile",
        "flux.helmrelease.reconcile",
        { namespace: "apps" },
        "namespace:apps",
      ],
    ],
  },
  gcp: {
    register: registerGcpTools,
    cases: [
      [
        "gcp_cloud_run_deploy",
        "gcp.cloud_run.deploy",
        { projectId: "acme-prod" },
        "project:acme-prod",
      ],
      [
        "gcp_gke_workload_restart",
        "gcp.gke.workload.restart",
        { projectId: "acme-prod" },
        "project:acme-prod",
      ],
    ],
  },
  github: {
    register: registerGithubTools,
    cases: [
      ["github_issue_create", "github.issue.create", GITHUB_REPO, "repo:acme/api"],
      ["github_pr_merge", "github.pr.merge", GITHUB_REPO, "repo:acme/api"],
      ["github_pr_close", "github.pr.close", GITHUB_REPO, "repo:acme/api"],
      ["github_branch_delete", "github.branch.delete", GITHUB_REPO, "repo:acme/api"],
      ["github_tag_create", "github.tag.create", GITHUB_REPO, "repo:acme/api"],
    ],
  },
  "github-actions": {
    register: registerGithubActionsTools,
    cases: [
      ["gha_run_trigger", "github_actions.run.trigger", GITHUB_REPO, "repo:acme/api"],
      ["gha_run_cancel", "github_actions.run.cancel", GITHUB_REPO, "repo:acme/api"],
    ],
  },
  gitlab: {
    register: registerGitlabTools,
    cases: [
      ["gitlab_mr_merge", "gitlab.mr.merge", { projectPath: "group/repo" }, "repo:group/repo"],
      [
        "gitlab_pipeline_retry",
        "gitlab.pipeline.retry",
        { projectPath: "group/repo" },
        "repo:group/repo",
      ],
      [
        "gitlab_pipeline_cancel",
        "gitlab.pipeline.cancel",
        { projectPath: "group/repo" },
        "repo:group/repo",
      ],
    ],
  },
  gmail: {
    register: registerGmailTools,
    cases: [
      ["gmail_message_send", "gmail.message.send", MAIL_TO, "recipient:ada@example.com"],
      ["gmail_draft_create", "gmail.draft.create", MAIL_TO, "recipient:ada@example.com"],
      ["gmail_draft_send", "gmail.draft.send", { draftId: "r-123" }, "draft:r-123"],
    ],
  },
  "google-drive": {
    register: registerGoogleDriveTools,
    cases: [
      [
        "gdrive_file_create",
        "google_drive.file.create",
        { parentId: "folder-1" },
        "folder:folder-1",
      ],
      ["gdrive_file_create", "google_drive.file.create", {}, "folder:root"],
      ["gdrive_file_move", "google_drive.file.move", { fileId: "file-1" }, "file:file-1"],
      ["gdrive_file_rename", "google_drive.file.rename", { fileId: "file-1" }, "file:file-1"],
    ],
  },
  iac: {
    register: registerIacTools,
    cases: [
      [
        "iac_terraform_apply",
        "iac.terraform.apply",
        { workingDirectory: "infra/prod" },
        "dir:infra/prod",
      ],
      [
        "iac_terraform_destroy",
        "iac.terraform.destroy",
        { workingDirectory: "infra/prod" },
        "dir:infra/prod",
      ],
      ["iac_pulumi_up", "iac.pulumi.up", { workingDirectory: "infra/prod" }, "dir:infra/prod"],
      [
        "iac_cloudformation_deploy",
        "iac.cloudformation.deploy",
        { stackName: "web-stack" },
        "stack:web-stack",
      ],
    ],
  },
  imap: {
    register: (server: never) => registerImapTools(server, UNREACHABLE, UNREACHABLE),
    cases: [["imap_mail_send", "imap.mail.send", MAIL_TO, "recipient:ada@example.com"]],
  },
  jenkins: {
    register: registerJenkinsTools,
    cases: [
      [
        "jenkins_build_trigger",
        "jenkins.build.trigger",
        { jobName: "web/deploy" },
        "job:web/deploy",
      ],
      ["jenkins_build_abort", "jenkins.build.abort", { jobName: "web/deploy" }, "job:web/deploy"],
    ],
  },
  jira: {
    register: registerJiraTools,
    cases: [
      ["jira_issue_create", "jira.issue.create", { projectKey: "ENG" }, "project:ENG"],
      ["jira_issue_update", "jira.issue.update", { issueKey: "ENG-7" }, "issue:ENG-7"],
      ["jira_comment_add", "jira.comment.add", { issueKey: "ENG-7" }, "issue:ENG-7"],
    ],
  },
  kubernetes: {
    register: registerKubernetesTools,
    cases: [
      [
        "k8s_deployment_scale",
        "kubernetes.deployment.scale",
        { namespace: "web" },
        "namespace:web",
      ],
      ["k8s_deployment_scale", "kubernetes.deployment.scale", {}, "namespace:default"],
      ["k8s_pod_delete", "kubernetes.pod.delete", { namespace: "web" }, "namespace:web"],
      ["k8s_pod_delete", "kubernetes.pod.delete", {}, "namespace:default"],
      ["k8s_rollout_restart", "kubernetes.rollout.restart", { namespace: "web" }, "namespace:web"],
      ["k8s_rollout_restart", "kubernetes.rollout.restart", {}, "namespace:default"],
    ],
  },
  linear: {
    register: registerLinearTools,
    cases: [
      ["linear_issue_create", "linear.issue.create", { teamId: "team-eng" }, "team:team-eng"],
      ["linear_issue_update", "linear.issue.update", { issueId: "ENG-7" }, "issue:ENG-7"],
      ["linear_comment_create", "linear.comment.create", { issueId: "ENG-7" }, "issue:ENG-7"],
    ],
  },
  looker: {
    register: registerLookerTools,
    cases: [
      [
        "looker_datagroup_trigger",
        "looker.datagroup.trigger",
        { datagroupId: "dg-1" },
        "resource:dg-1",
      ],
      [
        "looker_schedule_run_once",
        "looker.schedule.run_once",
        { scheduledPlanId: "sp-1" },
        "resource:sp-1",
      ],
    ],
  },
  mlflow: {
    register: registerMlflowTools,
    cases: [
      ["mlflow_model_promote", "mlflow.model.promote", { name: "churn" }, "model:churn"],
      [
        "mlflow_model_transition_stage",
        "mlflow.model.transition_stage",
        { name: "churn" },
        "model:churn",
      ],
    ],
  },
  "monte-carlo": {
    register: registerMonteCarloTools,
    cases: [
      [
        "montecarlo_incident_acknowledge",
        "montecarlo.incident.acknowledge",
        { incidentId: "inc-1" },
        "incident:inc-1",
      ],
      [
        "montecarlo_incident_resolve",
        "montecarlo.incident.resolve",
        { incidentId: "inc-1" },
        "incident:inc-1",
      ],
    ],
  },
  notion: {
    register: registerNotionTools,
    cases: [
      ["notion_page_create", "notion.page.create", { parentPageId: "page-1" }, "page:page-1"],
      ["notion_kb_append", "notion.knowledge.write", { databaseId: "db-1" }, "database:db-1"],
      ["notion_page_update", "notion.page.update", { pageId: "page-2" }, "page:page-2"],
      ["notion_block_append", "notion.block.append", { parentBlockId: "block-1" }, "block:block-1"],
      ["notion_comment_create", "notion.comment.create", { pageId: "page-2" }, "page:page-2"],
    ],
  },
  obsidian: {
    register: registerObsidianTools,
    cases: [
      ["obsidian_append_to_daily_note", "obsidian.note.append", { vault_id: "work" }, "vault:work"],
    ],
  },
  onedrive: {
    register: registerOnedriveTools,
    cases: [
      ["onedrive_item_move", "onedrive.item.move", { itemId: "item-1" }, "item:item-1"],
      ["onedrive_item_delete", "onedrive.item.delete", { itemId: "item-1" }, "item:item-1"],
    ],
  },
  outlook: {
    register: registerOutlookTools,
    cases: [
      ["outlook_mail_send", "outlook.mail.send", MAIL_TO, "recipient:ada@example.com"],
      // Pinned as they are: a calendar event is scoped by its subject on create and by its
      // event id on delete, both under the `calendar` kind.
      [
        "outlook_calendar_create",
        "outlook.calendar.create",
        { subject: "Standup" },
        "calendar:Standup",
      ],
      [
        "outlook_calendar_delete",
        "outlook.calendar.delete",
        { eventId: "evt-1" },
        "calendar:evt-1",
      ],
    ],
  },
  pagerduty: {
    register: registerPagerdutyTools,
    cases: [
      [
        "pd_incident_acknowledge",
        "pagerduty.incident.acknowledge",
        { incidentId: "P1" },
        "incident:P1",
      ],
      ["pd_incident_resolve", "pagerduty.incident.resolve", { incidentId: "P1" }, "incident:P1"],
      ["pd_incident_escalate", "pagerduty.incident.escalate", { incidentId: "P1" }, "incident:P1"],
    ],
  },
  powerbi: {
    register: registerPowerBiTools,
    cases: [
      ["powerbi_dataset_refresh", "powerbi.dataset.refresh", { groupId: "ws-1" }, "workspace:ws-1"],
      ["powerbi_dataset_refresh", "powerbi.dataset.refresh", {}, "workspace:my-workspace"],
      [
        "powerbi_dataflow_refresh",
        "powerbi.dataflow.refresh",
        { groupId: "ws-1" },
        "workspace:ws-1",
      ],
    ],
  },
  protonmail: {
    register: (server: never) => registerProtonmailTools(server, UNREACHABLE, UNREACHABLE),
    cases: [["protonmail_mail_send", "protonmail.mail.send", MAIL_TO, "recipient:ada@example.com"]],
  },
  slack: {
    register: registerSlackTools,
    cases: [
      ["slack_chat_post", "slack.chat.post", { channel: "C123" }, "channel:C123"],
      ["slack_message_post", "slack.message.post", { channel: "C123" }, "channel:C123"],
      ["slack_message_post_dm", "slack.message.post", { user_ids: "U123" }, "user:U123"],
    ],
  },
  snowflake: {
    register: registerSnowflakeTools,
    cases: [
      [
        "snowflake_comment_set",
        "snowflake.comment.set",
        { object: "ANALYTICS.PUBLIC.ORDERS" },
        "object:ANALYTICS.PUBLIC.ORDERS",
      ],
      [
        "snowflake_tag_set",
        "snowflake.tag.set",
        { object: "ANALYTICS.PUBLIC.ORDERS" },
        "object:ANALYTICS.PUBLIC.ORDERS",
      ],
    ],
  },
  tableau: {
    register: registerTableauTools,
    cases: [
      ["tableau_workbook_refresh", "tableau.workbook.refresh", { id: "wb-1" }, "resource:wb-1"],
      ["tableau_datasource_refresh", "tableau.datasource.refresh", { id: "ds-1" }, "resource:ds-1"],
    ],
  },
  teams: {
    register: registerTeamsTools,
    cases: [
      [
        "teams_message_post",
        "teams.message.post",
        { teamId: "T1", channelId: "C1" },
        "channel:T1/C1",
      ],
      ["teams_chat_post", "teams.chat.post", { conversationId: "conv-1" }, "chat:conv-1"],
      ["teams_message_post_chat", "teams.message.postChat", { chatId: "chat-1" }, "chat:chat-1"],
    ],
  },
};

/** The variable docs/configuration.md names for a connector: `NIMBUS_MCP_<SERVICE>_WRITE_SCOPE`. */
function scopeEnvOf(id: string): string {
  return `NIMBUS_MCP_${id.toUpperCase().replaceAll("-", "_")}_WRITE_SCOPE`;
}

/** Whether any of a connector's source files registers a write tool — the consent audit's scan. */
function registersWrites(id: string): boolean {
  const src = join(ROOT, "connectors", id, "src");
  return readdirSync(src)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .some((f) => registersWriteTool(readFileSync(join(src, f), "utf8")));
}

/** Obsidian resolves its vaults while registering, so it cannot register without the variable. */
const REGISTRATION_ENV = {
  OBSIDIAN_VAULT_PATHS_JSON: JSON.stringify([join(tmpdir(), "nimbus-write-scope-no-vault")]),
};

/** Register `id` in standalone mode under `scope`, for a client that does or does not elicit. */
async function standalone(
  id: string,
  scope: string,
  elicitation: boolean,
): Promise<StandaloneCapture> {
  const connector = WRITES[id];
  if (connector === undefined) throw new Error(`no write table for ${id}`);
  let capture: StandaloneCapture | undefined;
  await withEnv(
    {
      ...REGISTRATION_ENV,
      [scopeEnvOf(id)]: scope,
      NIMBUS_MCP_AUDIT_LOG: undefined,
      NIMBUS_MCP_WRITE_BUDGET: undefined,
    },
    () => {
      capture = captureStandaloneTools(connector.register, {
        elicitation,
        answer: { action: "decline" },
      });
    },
  );
  if (capture === undefined) throw new Error(`${id} did not register`);
  return capture;
}

/**
 * Call one write tool with every request and subprocess refused, and return its JSON answer
 * alongside how many it attempted.
 */
async function callUnplugged(
  capture: StandaloneCapture,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ answer: unknown; requests: number }> {
  const http = stubFetch(() => undefined);
  const spawn = stubSpawn();
  try {
    const answer = await capture.tools.callJson(tool, args);
    return { answer, requests: http.calls.length + spawn.calls.length };
  } finally {
    spawn.restore();
    http.restore();
  }
}

/** `args` completed by `fixtureFor` into arguments the tool's own schema accepts. */
function completeArgs(
  capture: StandaloneCapture,
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const full = fixtureFor(capture.tools.get(tool).schema as ParsableSchema, args);
  if (full === undefined)
    throw new Error(`no arguments satisfy ${tool}'s schema from ${JSON.stringify(args)}`);
  return full;
}

beforeEach(() => {
  resetConnectorModeForTests();
  setConnectorMode("standalone");
});

afterEach(() => {
  resetConnectorModeForTests();
});

describe("standalone write scope", () => {
  it("lists exactly the connectors that register a write tool", () => {
    const fromTree = connectorDirs(ROOT).filter(registersWrites);
    // A guard against a vacuous pass: the scan must find the write-capable connectors at all.
    expect(fromTree.length).toBeGreaterThan(30);
    expect(Object.keys(WRITES).sort((a, b) => a.localeCompare(b))).toEqual(fromTree);
  });

  for (const [id, { cases }] of Object.entries(WRITES)) {
    const env = scopeEnvOf(id);
    const firstTarget = cases[0]?.[3] ?? "";

    describe(id, () => {
      it("offers its write tools only to a client that can ask a human", async () => {
        const reads = (await standalone(id, firstTarget, false)).tools.names();
        const all = (await standalone(id, firstTarget, true)).tools.names();
        const writes = all.filter((name) => !reads.includes(name));
        expect(writes).toEqual(
          [...new Set(cases.map(([tool]) => tool))].sort((a, b) => a.localeCompare(b)),
        );
      });

      for (const [tool, mutates, given, target] of cases) {
        describe(`${tool} ${JSON.stringify(given)}`, () => {
          it(`refuses outside ${target}, before asking or sending anything`, async () => {
            const kind = target.slice(0, target.indexOf(":"));
            const capture = await standalone(
              id,
              `${kind}:not-${target.slice(kind.length + 1)}`,
              true,
            );
            const { answer, requests } = await callUnplugged(
              capture,
              tool,
              completeArgs(capture, tool, given),
            );
            expect(answer).toEqual({
              ok: false,
              error: `out of scope: ${target} is not in ${env}`,
            });
            expect(capture.prompts).toEqual([]);
            expect(requests).toBe(0);
          });

          it(`asks a human about ${mutates} inside ${target}, and a refusal sends nothing`, async () => {
            const capture = await standalone(id, target, true);
            const { answer, requests } = await callUnplugged(
              capture,
              tool,
              completeArgs(capture, tool, given),
            );
            expect(answer).toEqual({
              ok: false,
              error: "not approved: the operation was declined, cancelled, or timed out",
            });
            expect(capture.prompts.map((p) => p.split("\n")[0])).toEqual([
              `Nimbus is about to perform ${mutates} with:`,
            ]);
            expect(requests).toBe(0);
          });
        });
      }
    });
  }
});
