import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { awsCliArg, cliArg } from "../../../shared/cli-json-kit.ts";
import type { ConsentServer } from "../../../shared/consent-kit.ts";
import {
  createPrepareToolRegistrar,
  createWriteToolRegistrar,
} from "../../../shared/consent-kit.ts";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../../shared/mcp-tool-kit.ts";
import { scratchDirBase, withScratchDir } from "../../../shared/private-scratch.ts";
import { runCliCode, runCliOkThrowing } from "../../../shared/run-cli-json.ts";

/**
 * The most a template may be when it is handed to `create-change-set` as `--template-body`, which
 * is how this connector hands one over (no S3 bucket): CloudFormation refuses a larger one itself.
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateChangeSet.html
 */
const TEMPLATE_MAX_BYTES = 51_200;

/** A saved plan file is read whole (to hash it), so it is bounded. */
const PLAN_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** `terraform show -json` output is returned whole, so it is bounded. */
const PLAN_JSON_MAX_BYTES = 4 * 1024 * 1024;
/** Most resource changes one change-set reply carries. */
const CHANGES_MAX = 500;
/** Most bytes of one change-set reply (the prepare tool's whole answer). */
const CHANGESET_REPLY_MAX_BYTES = 256 * 1024;
/** Longest the change set is polled for, and how often. */
const CHANGESET_POLL_DEADLINE_MS = 120_000;
const CHANGESET_POLL_INTERVAL_MS = 2000;
/** Page guard for `NextToken` following, so a misbehaving CLI cannot loop forever. */
const CHANGESET_PAGES_MAX = 100;

/**
 * Time seams for the change-set poll, exported so a test never waits two real seconds per poll.
 * Production never replaces them.
 */
export const iacTimeHooks: {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
} = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * A CloudFormation template. It reaches the AWS CLI as a file, never as an argument (see
 * `withScratchDir` below), so none of the argument rules apply to it: a YAML template may well
 * start with `---`. The schema carries only the character bound a client is shown; the UTF-8 byte
 * bound is {@link templateProblem}, run by the handlers and by `refuseBefore` (a `.refine()` on the
 * registered schema would lose its `.shape`).
 */
const templateDocument = z.string().min(1).max(TEMPLATE_MAX_BYTES);

/** Why `template` may not be sent, or `undefined`. A fixed message, before any spawn. */
export function templateProblem(template: string): string | undefined {
  if (new TextEncoder().encode(template).length > TEMPLATE_MAX_BYTES) {
    return `templateBody must be at most ${String(TEMPLATE_MAX_BYTES)} bytes as UTF-8, the most create-change-set takes without an S3 bucket`;
  }
  return undefined;
}

const CAPABILITY_VALUES = [
  "CAPABILITY_IAM",
  "CAPABILITY_NAMED_IAM",
  "CAPABILITY_AUTO_EXPAND",
] as const;
const capabilitiesSchema = z.array(z.enum(CAPABILITY_VALUES)).max(3).optional();

/** Why `capabilities` may not be sent (a duplicate), or `undefined`. */
function capabilitiesProblem(capabilities: readonly string[] | undefined): string | undefined {
  if (capabilities !== undefined && new Set(capabilities).size !== capabilities.length) {
    return "capabilities must not repeat a value";
  }
  return undefined;
}

/**
 * A change set's ARN. The CLI's `--change-set-name` takes a name or an ARN; the ARN alone names
 * one change set of one stack unambiguously, and starts with `arn:` so it can never read as a flag
 * or a `file://` load.
 */
const changeSetArn = z
  .string()
  .regex(
    /^arn:aws[a-z-]*:cloudformation:[a-z0-9-]+:\d{12}:changeSet\/[A-Za-z][-A-Za-z0-9]{0,127}\/[0-9a-f-]{36}$/,
    "must be a CloudFormation change set ARN",
  );

/** The change set name inside an ARN that already matched {@link changeSetArn}. */
function changeSetNameOf(arn: string): string {
  return arn.split("/")[1] ?? "";
}

/**
 * A saved plan file path. `cliArg` refuses a leading `-` and control characters, and caps the
 * length at 1024 characters (the repo-wide CLI argument bound, which `cli-argument-guards.test.ts`
 * pins), a little under the 4096 the plan first named: a plan path under NIMBUS_IAC_PLAN_DIR is
 * far shorter.
 */
const planFileArg = cliArg;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be a lower-case SHA-256 hex digest");

function sha256Of(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The file names a plan is saved under: the KIND of plan is its name (apply vs destroy). */
const PLAN_NAME = "plan.tfplan";
const DESTROY_PLAN_NAME = "destroy.tfplan";
const REFRESH_PLAN_NAME = "refresh.tfplan";

/**
 * Why a plan file path is refused before the disk is touched (shared with refuseBefore): not
 * absolute, a Windows device or UNC form (a leading backslash, which covers the
 * long-path, device and host forms; on win32 also two forward slashes), or not one of the file
 * names allowed (apply takes only plan.tfplan, destroy only destroy.tfplan).
 */
function planFilePathProblem(planFile: string, names: readonly string[]): string | undefined {
  if (planFile.startsWith("\\") || (process.platform === "win32" && planFile.startsWith("//"))) {
    return "planFile must not be a device or network path";
  }
  if (!isAbsolute(planFile)) return "planFile must be an absolute path";
  if (!names.includes(basename(planFile))) {
    return `planFile must be named ${names.join(" or ")}`;
  }
  return undefined;
}

/**
 * Check a plan file and return its REAL path, which is what is hashed and handed to terraform.
 *
 * It must be a regular, non-linked file of a sane size that lies strictly inside the real
 * NIMBUS_IAC_PLAN_DIR (a symlinked parent directory, or a sibling whose name merely starts with
 * the plan dir's, is outside). NO copy is made. Making that directory read-only to everyone but the
 * gateway between approval and apply is the gateway's job; this connector can only narrow the
 * window, not close it (README: stated bound).
 */
async function resolvePlanFile(planFile: string, names: readonly string[]): Promise<string> {
  const problem = planFilePathProblem(planFile, names);
  if (problem !== undefined) throw new Error(problem);
  const base = await planDirBase();
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(planFile);
  } catch {
    throw new Error("planFile does not exist");
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error("planFile must be a regular file, not a link");
  }
  if (st.size > PLAN_FILE_MAX_BYTES) {
    throw new Error("planFile is too large");
  }
  const realBase = await realpath(base);
  const real = await realpath(planFile);
  const rel = relative(realBase, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`planFile must be inside ${IAC_PLAN_DIR_ENV}`);
  }
  return real;
}

/** Environment of every terraform child: automation mode, and never an interactive prompt. */
function terraformEnv(): Record<string, string | undefined> {
  return { ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0" };
}

/** The directory plan files live under: absolute, an existing real directory. */
export const IAC_PLAN_DIR_ENV = "NIMBUS_IAC_PLAN_DIR";

async function planDirBase(): Promise<string> {
  const configured = process.env[IAC_PLAN_DIR_ENV]?.trim();
  if (configured === undefined || configured === "") {
    throw new Error(`${IAC_PLAN_DIR_ENV} is not set: a plan needs a directory to be saved in`);
  }
  if (!isAbsolute(configured)) {
    throw new Error(`${IAC_PLAN_DIR_ENV} must be an absolute path`);
  }
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(configured);
  } catch {
    throw new Error(`${IAC_PLAN_DIR_ENV} does not name an existing directory`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${IAC_PLAN_DIR_ENV} must be a real directory, not a link`);
  }
  return configured;
}

const PLAN_FILE_OF_MODE = {
  apply: PLAN_NAME,
  destroy: DESTROY_PLAN_NAME,
  "refresh-only": REFRESH_PLAN_NAME,
} as const;
const PLAN_FLAGS_OF_MODE = {
  apply: [],
  destroy: ["-destroy"],
  "refresh-only": ["-refresh-only"],
} as const;

/** `terraform plan` / `plan -destroy` / `plan -refresh-only`, saved under a fresh per-plan directory. */
async function terraformPlan(
  workingDirectory: string,
  mode: "apply" | "destroy" | "refresh-only",
): Promise<ReturnType<typeof jsonResult>> {
  const base = await planDirBase();
  const planId = randomBytes(16).toString("hex");
  const planDir = join(base, planId);
  // Non-recursive: an existing directory of that name is an error, never silently reused.
  await mkdir(planDir, { mode: 0o700 });
  const planFile = join(planDir, PLAN_FILE_OF_MODE[mode]);
  try {
    const r = await runCliCode(
      [
        "terraform",
        `-chdir=${workingDirectory}`,
        "plan",
        ...PLAN_FLAGS_OF_MODE[mode],
        "-input=false",
        "-no-color",
        "-detailed-exitcode",
        "-lock-timeout=30s",
        `-out=${planFile}`,
      ],
      terraformEnv(),
    );
    // -detailed-exitcode: 0 = empty diff, 1 = error, 2 = changes present.
    // https://developer.hashicorp.com/terraform/cli/commands/plan
    if (r.code !== 0 && r.code !== 2) {
      throw new Error(`terraform exited ${String(r.code)}: ${r.stderr.slice(0, 500)}`);
    }
    try {
      await chmod(planFile, 0o600);
    } catch {
      // Best effort: Windows has no POSIX modes; the directory is already 0700 where it matters.
    }
    const planSha256 = sha256Of(await readFile(planFile));
    return jsonResult({ planId, planFile, planSha256, hasChanges: r.code === 2 });
  } catch (e) {
    await rm(planDir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * `terraform init`, with nothing the caller chooses but the directory: no `-upgrade`,
 * `-reconfigure`, `-migrate-state` or `-backend-config`, so a lock file's pinned versions and the
 * configured backend stay as they are, and a backend change fails rather than migrating state.
 * https://developer.hashicorp.com/terraform/cli/commands/init
 */
async function terraformInit(workingDirectory: string): Promise<ReturnType<typeof jsonResult>> {
  const r = await runCliCode(
    ["terraform", `-chdir=${workingDirectory}`, "init", "-input=false", "-no-color"],
    terraformEnv(),
  );
  if (r.code !== 0) {
    throw new Error(`terraform exited ${String(r.code)}: ${r.stderr.slice(0, 500)}`);
  }
  return jsonResult({ ok: true, status: "initialized" });
}

/**
 * Why a plan JSON is not a refresh-only plan, or `undefined`. A refresh-only plan may change the
 * state and the outputs, never infrastructure: every resource change must be a no-op (a data
 * source may be read). Anything else is refused, because the check is about what the file would
 * do, not what it is named.
 */
function refreshOnlyProblem(planJson: string): string | undefined {
  const doc: unknown = JSON.parse(planJson);
  const fields = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>) : {};
  // Two checks, in this order: provider actions, then every resource change.
  return providerActionsProblem(fields) ?? resourceChangesProblem(fields);
}

/**
 * Terraform 1.14 stores provider actions apart from resource changes, and applying the file runs
 * them: any `action_invocations` value that is not an empty list is refused, whatever else the
 * plan says.
 */
function providerActionsProblem(fields: Record<string, unknown>): string | undefined {
  const invocations = fields["action_invocations"];
  if (invocations !== undefined && (!Array.isArray(invocations) || invocations.length > 0)) {
    return "the plan runs provider actions, so it is not a refresh-only plan";
  }
  return undefined;
}

/** Every resource change must be a single `no-op`, or a single `read` of a data source. */
function resourceChangesProblem(fields: Record<string, unknown>): string | undefined {
  const changes = fields["resource_changes"];
  // Terraform omits the key when a plan has no resource changes at all.
  if (changes === undefined) return undefined;
  if (!Array.isArray(changes)) return "the plan's resource_changes is not a list";
  if (!changes.every(isRefreshOnlyChange)) {
    return "the plan changes infrastructure, so it is not a refresh-only plan";
  }
  return undefined;
}

/** True when one `resource_changes[]` entry's actions are exactly `["no-op"]`, or `["read"]` of a data source. */
function isRefreshOnlyChange(c: unknown): boolean {
  const row = typeof c === "object" && c !== null ? (c as Record<string, unknown>) : {};
  const change = row["change"];
  const actions =
    typeof change === "object" && change !== null
      ? (change as Record<string, unknown>)["actions"]
      : undefined;
  const only = Array.isArray(actions) && actions.length === 1 ? actions[0] : undefined;
  return only === "no-op" || (only === "read" && row["mode"] === "data");
}

/** `terraform apply <planFile>` after the file's hash is proven to be the approved one. */
async function terraformApplyPlan(
  p: { workingDirectory: string; planFile: string; planSha256: string },
  name: string,
): Promise<ReturnType<typeof jsonResult>> {
  const planFile = await resolvePlanFile(p.planFile, [name]);
  // Read ONCE; the hash is of exactly these bytes.
  const actual = Buffer.from(sha256Of(await readFile(planFile)), "hex");
  const approved = Buffer.from(p.planSha256, "hex");
  if (actual.length !== approved.length || !timingSafeEqual(actual, approved)) {
    throw new Error("plan file does not match the approved hash");
  }
  if (name === REFRESH_PLAN_NAME) {
    // The file name says what the plan was made as; this proves what it does, so a plan file that
    // would change infrastructure can never be applied under the accept-drift tool.
    const shown = await runCliCode(
      ["terraform", `-chdir=${p.workingDirectory}`, "show", "-json", "-no-color", planFile],
      terraformEnv(),
    );
    if (shown.code !== 0) {
      throw new Error(`terraform exited ${String(shown.code)}: ${shown.stderr.slice(0, 500)}`);
    }
    if (Buffer.byteLength(shown.stdout, "utf8") > PLAN_JSON_MAX_BYTES) {
      throw new Error("plan JSON too large");
    }
    let problem: string | undefined;
    try {
      problem = refreshOnlyProblem(shown.stdout);
    } catch {
      problem = "terraform show -json did not print JSON";
    }
    if (problem !== undefined) throw new Error(problem);
  }
  // No -auto-approve and no -destroy: a saved plan applies as it was planned, and `apply <file>`
  // runs without a prompt. https://developer.hashicorp.com/terraform/cli/commands/apply
  const r = await runCliCode(
    ["terraform", `-chdir=${p.workingDirectory}`, "apply", "-input=false", "-no-color", planFile],
    terraformEnv(),
  );
  if (r.code !== 0) {
    throw new Error(`terraform exited ${String(r.code)}: ${r.stderr.slice(0, 500)}`);
  }
  // A plan carries secrets and is stale once applied. Best effort: a directory the gateway made
  // read-only makes this fail, which is ignored.
  try {
    await rm(planFile, { force: true });
  } catch {
    // ignored, see above
  }
  return jsonResult({ ok: true, status: "applied" });
}

// ---------------------------------------------------------------------------
// CloudFormation

/** The aws CLI's environment: the operator's, plus UTF-8 for the template file it reads. */
function awsEnv(): Record<string, string | undefined> {
  // The file is UTF-8. Left to itself the CLI reads it in the locale's encoding, and on a
  // Windows machine using cp1252 a template holding "Á" fails to decode while one holding
  // "é" deploys as "Ã©". AWS CLI v2 reads AWS_CLI_FILE_ENCODING and ignores PYTHONUTF8; v1,
  // plain Python, reads PYTHONUTF8 and ignores the other. Both are set.
  return { ...process.env, AWS_CLI_FILE_ENCODING: "UTF-8", PYTHONUTF8: "1" };
}

/** Run an aws command; any non-zero exit throws the one failure message. Resolves to stdout. */
async function awsOk(argv: readonly string[]): Promise<string> {
  const r = await runCliCode(["aws", ...argv], awsEnv());
  if (r.code !== 0) {
    throw new Error(`aws exited ${String(r.code)}: ${r.stderr.slice(0, 500)}`);
  }
  return r.stdout;
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from aws ${what}`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`unexpected reply from aws ${what}`);
  }
  return v as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

type StackState =
  | { exists: false }
  | { exists: true; status: string; statusReason?: string; lastUpdatedTime?: string };

async function describeStack(stackName: string): Promise<StackState> {
  const r = await runCliCode(
    ["aws", "cloudformation", "describe-stacks", "--stack-name", stackName, "--output", "json"],
    awsEnv(),
  );
  if (r.code !== 0) {
    // A missing stack is an ordinary answer (a first deploy), reported on stderr as
    // "Stack with id X does not exist".
    if (/does not exist/.test(r.stderr)) return { exists: false };
    throw new Error(`aws exited ${String(r.code)}: ${r.stderr.slice(0, 500)}`);
  }
  const stacks = parseObject(r.stdout, "describe-stacks")["Stacks"];
  const first: unknown = Array.isArray(stacks) ? stacks[0] : undefined;
  if (typeof first !== "object" || first === null) return { exists: false };
  const s = first as Record<string, unknown>;
  const status = str(s["StackStatus"]);
  if (status === undefined) throw new Error("unexpected reply from aws describe-stacks");
  const out: StackState = { exists: true, status };
  const reason = str(s["StackStatusReason"]);
  if (reason !== undefined) out.statusReason = reason;
  const updated = str(s["LastUpdatedTime"]) ?? str(s["CreationTime"]);
  if (updated !== undefined) out.lastUpdatedTime = updated;
  return out;
}

/**
 * Remove a change set, and the empty stack shell a CREATE-type change set leaves behind.
 *
 * A first-time deploy's change set puts the stack in REVIEW_IN_PROGRESS, a shell with no resources
 * that lingers. It is deleted only when it is in that status AND holds no change set at all; a
 * stack in any other status is never deleted here.
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html
 */
async function cleanupChangeSet(
  stackName: string,
  changeSet: string,
  skipChangeSetDelete: boolean,
): Promise<{ changeSetDeleted: boolean; stackDeleted: boolean }> {
  if (!skipChangeSetDelete) {
    await awsOk(["cloudformation", "delete-change-set", "--change-set-name", changeSet]);
  }
  let stackDeleted = false;
  const stack = await describeStack(stackName);
  if (stack.exists && stack.status === "REVIEW_IN_PROGRESS") {
    const listed = await awsOk([
      "cloudformation",
      "list-change-sets",
      "--stack-name",
      stackName,
      "--output",
      "json",
    ]);
    const summaries = parseObject(listed, "list-change-sets")["Summaries"];
    if (!Array.isArray(summaries) || summaries.length === 0) {
      await awsOk(["cloudformation", "delete-stack", "--stack-name", stackName]);
      stackDeleted = true;
    }
  }
  return { changeSetDeleted: !skipChangeSetDelete, stackDeleted };
}

type ChangeRow = {
  action: string;
  logicalId: string;
  physicalId?: string;
  resourceType: string;
  replacement: string;
  scope: string[];
};

function changeRowOf(raw: unknown): ChangeRow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rc = (raw as Record<string, unknown>)["ResourceChange"];
  if (typeof rc !== "object" || rc === null) return undefined;
  const c = rc as Record<string, unknown>;
  const row: ChangeRow = {
    action: str(c["Action"]) ?? "unknown",
    logicalId: str(c["LogicalResourceId"]) ?? "",
    resourceType: str(c["ResourceType"]) ?? "",
    replacement: str(c["Replacement"]) ?? "unknown",
    scope: stringList(c["Scope"]),
  };
  const physical = str(c["PhysicalResourceId"]);
  if (physical !== undefined) row.physicalId = physical;
  return row;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function setEqual(a: readonly string[], b: readonly string[]): boolean {
  return new Set(a).size === a.length && a.length === b.length && a.every((x) => b.includes(x));
}

/** The name every change set of this connector carries: bound to the exact template it is for. */
function changeSetNameFor(templateSha256: string): string {
  return `nimbus-${templateSha256}-${randomBytes(6).toString("hex")}`;
}

/** Sync refusals shared by the execute handler and `refuseBefore`. */
function deployProblem(p: {
  templateBody: string;
  capabilities?: readonly string[] | undefined;
  changeSetId: string;
}): string | undefined {
  const t = templateProblem(p.templateBody) ?? capabilitiesProblem(p.capabilities);
  if (t !== undefined) return t;
  const expected = new RegExp(`^nimbus-${sha256Of(p.templateBody)}-[0-9a-f]{12}$`);
  if (!expected.test(changeSetNameOf(p.changeSetId))) {
    return "the change set was not made for this template";
  }
  return undefined;
}

/** Poll the change set until it is CREATE_COMPLETE; returns that reply. Throws otherwise. */
async function awaitChangeSet(
  describe: (nextToken?: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const deadline = iacTimeHooks.now() + CHANGESET_POLL_DEADLINE_MS;
  for (;;) {
    const d = parseObject(await describe(), "describe-change-set");
    const status = str(d["Status"]);
    if (status === "CREATE_COMPLETE") return d;
    if (status !== "CREATE_PENDING" && status !== "CREATE_IN_PROGRESS") {
      // FAILED (a template with no changes lands here too: its StatusReason says so) or any
      // other terminal status.
      // Capped like every stderr echo here: the reason is AWS's text and may quote the template.
      throw new Error(
        `change set ${status ?? "unknown"}: ${(str(d["StatusReason"]) ?? "no reason given").slice(0, 500)}`,
      );
    }
    if (iacTimeHooks.now() >= deadline) {
      throw new Error("change set was not ready within 120 seconds");
    }
    await iacTimeHooks.sleep(CHANGESET_POLL_INTERVAL_MS); // NOSONAR S9382: a poll; each wait follows the previous status read.
  }
}

/** Every resource change, following `NextToken` by hand. */
async function collectChanges(
  first: Record<string, unknown>,
  describe: (nextToken?: string) => Promise<string>,
): Promise<ChangeRow[]> {
  const changes: ChangeRow[] = [];
  let page = first;
  for (let pages = 1; ; pages += 1) {
    const raw = page["Changes"];
    for (const item of Array.isArray(raw) ? raw : []) {
      const row = changeRowOf(item);
      if (row !== undefined) changes.push(row);
    }
    if (changes.length > CHANGES_MAX) throw new Error("change set too large");
    const token = str(page["NextToken"]);
    if (token === undefined || token === "") return changes;
    if (pages >= CHANGESET_PAGES_MAX) throw new Error("change set too large");
    // U: whether the CLI paginates describe-change-set itself is unconfirmed; see the README.
    page = parseObject(await describe(token), "describe-change-set"); // NOSONAR S9382: each page needs the previous page's NextToken.
  }
}

async function changeSetCreate(p: {
  stackName: string;
  templateBody: string;
  capabilities?: readonly string[] | undefined;
}): Promise<ReturnType<typeof jsonResult>> {
  const bad = templateProblem(p.templateBody) ?? capabilitiesProblem(p.capabilities);
  if (bad !== undefined) throw new Error(bad);
  const capabilities = p.capabilities ?? [];
  const templateSha256 = sha256Of(p.templateBody);
  // Refuse a missing scratch grant (Windows under the gateway) before the first aws call, as the
  // kubernetes plan does: the template file is written under it below.
  scratchDirBase();

  const stack = await describeStack(p.stackName);
  // REVIEW_IN_PROGRESS: a shell left by an earlier CREATE change set, which only a CREATE change
  // set may be added to. DELETE_COMPLETE: a deleted stack can be created again under its name.
  const changeSetType =
    !stack.exists || stack.status === "REVIEW_IN_PROGRESS" || stack.status === "DELETE_COMPLETE"
      ? "CREATE"
      : "UPDATE";
  const name = changeSetNameFor(templateSha256);

  return withScratchDir("nimbus-cfn-", async (dir) => {
    const templatePath = join(dir, "template");
    await writeFile(templatePath, p.templateBody, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const created = parseObject(
      await awsOk([
        "cloudformation",
        "create-change-set",
        "--stack-name",
        p.stackName,
        "--change-set-name",
        name,
        "--change-set-type",
        changeSetType,
        "--template-body",
        `file://${templatePath}`,
        ...(capabilities.length > 0 ? ["--capabilities", ...capabilities] : []),
        "--output",
        "json",
      ]),
      "create-change-set",
    );
    const changeSetId = str(created["Id"]);
    if (changeSetId === undefined) {
      // The call succeeded, so a change set (and, for CREATE, a REVIEW_IN_PROGRESS stack) may
      // exist: delete it by name, best effort, rather than leave it behind with no Id to report.
      await runCliCode(
        [
          "aws",
          "cloudformation",
          "delete-change-set",
          "--change-set-name",
          name,
          "--stack-name",
          p.stackName,
        ],
        awsEnv(),
      );
      throw new Error("unexpected reply from aws create-change-set");
    }
    const stackId = str(created["StackId"]) ?? "";

    const describe = (nextToken?: string): Promise<string> =>
      awsOk([
        "cloudformation",
        "describe-change-set",
        "--change-set-name",
        changeSetId,
        ...(nextToken === undefined ? [] : ["--next-token", nextToken]),
        "--output",
        "json",
      ]);

    try {
      const changes = await collectChanges(await awaitChangeSet(describe), describe);
      const reply = {
        changeSetId,
        changeSetName: name,
        stackId,
        stackName: p.stackName,
        changeSetType,
        templateSha256,
        capabilities,
        changes,
      };
      if (Buffer.byteLength(JSON.stringify(reply), "utf8") > CHANGESET_REPLY_MAX_BYTES) {
        throw new Error("change set too large");
      }
      return jsonResult(reply);
    } catch (e) {
      try {
        await cleanupChangeSet(p.stackName, changeSetId, false);
      } catch {
        // Best effort: the failure being reported is the original one.
      }
      throw e;
    }
  });
}

async function changeSetExecute(p: {
  stackName: string;
  templateBody: string;
  capabilities?: readonly string[] | undefined;
  changeSetId: string;
}): Promise<ReturnType<typeof jsonResult>> {
  const bad = deployProblem(p);
  if (bad !== undefined) throw new Error(bad);
  const d = parseObject(
    await awsOk([
      "cloudformation",
      "describe-change-set",
      "--change-set-name",
      p.changeSetId,
      "--output",
      "json",
    ]),
    "describe-change-set",
  );
  if (str(d["Status"]) !== "CREATE_COMPLETE") {
    throw new Error(`change set is ${str(d["Status"]) ?? "unknown"}, not CREATE_COMPLETE`);
  }
  if (str(d["ExecutionStatus"]) !== "AVAILABLE") {
    throw new Error(`change set cannot be executed: ${str(d["ExecutionStatus"]) ?? "unknown"}`);
  }
  if (str(d["StackName"]) !== p.stackName) {
    throw new Error("change set belongs to a different stack");
  }
  if (!setEqual(stringList(d["Capabilities"]), p.capabilities ?? [])) {
    throw new Error("change set capabilities do not match the approved capabilities");
  }
  await awsOk(["cloudformation", "execute-change-set", "--change-set-name", p.changeSetId]);
  return jsonResult({
    ok: true,
    status: "execution started",
    changeSetId: p.changeSetId,
    stackId: str(d["StackId"]) ?? "",
  });
}

/**
 * The exact shape of a change set name this connector makes (`nimbus-<template sha256>-<12 hex>`).
 * Discard requires all of it, not a `nimbus-` prefix: a person's own `nimbus-prod-hotfix` change
 * set must not be deletable through a tool that says it deletes only its own.
 */
const NIMBUS_CHANGE_SET_NAME = /^nimbus-[0-9a-f]{64}-[0-9a-f]{12}$/;

function discardProblem(changeSetId: string): string | undefined {
  return NIMBUS_CHANGE_SET_NAME.test(changeSetNameOf(changeSetId))
    ? undefined
    : "only a change set this connector made (nimbus-<template sha256>-<12 hex>) can be discarded";
}

async function describeChangeSetOrMissing(
  changeSetId: string,
): Promise<Record<string, unknown> | undefined> {
  const r = await runCliCode(
    [
      "aws",
      "cloudformation",
      "describe-change-set",
      "--change-set-name",
      changeSetId,
      "--output",
      "json",
    ],
    awsEnv(),
  );
  if (r.code !== 0) {
    if (/ChangeSetNotFound|does not exist/.test(r.stderr)) return undefined;
    throw new Error(`aws exited ${String(r.code)}: ${r.stderr.slice(0, 500)}`);
  }
  return parseObject(r.stdout, "describe-change-set");
}

async function changeSetDiscard(p: {
  stackName: string;
  changeSetId: string;
}): Promise<ReturnType<typeof jsonResult>> {
  const bad = discardProblem(p.changeSetId);
  if (bad !== undefined) throw new Error(bad);
  const d = await describeChangeSetOrMissing(p.changeSetId);
  if (d !== undefined && str(d["StackName"]) !== p.stackName) {
    throw new Error("change set belongs to a different stack");
  }
  // Not found: nothing of ours to remove, so the empty-shell deletion is NOT attempted either. It
  // runs only after THIS call deleted a change set that belongs to the stack. (Bound: between
  // list-change-sets and delete-stack another change set could be added; README.)
  if (d === undefined)
    return jsonResult({ ok: true, changeSetDeleted: false, stackDeleted: false });
  const done = await cleanupChangeSet(p.stackName, p.changeSetId, false);
  return jsonResult({ ok: true, ...done });
}

/** Longest status reason a change-set read carries: AWS's text, which may quote the template. */
const STATUS_REASON_MAX = 500;
/** Most change sets one list answer carries. */
const CHANGESETS_LIST_MAX = 100;

function reasonOf(v: unknown): string | null {
  const s = str(v);
  return s === undefined ? null : s.slice(0, STATUS_REASON_MAX);
}

/**
 * One page of `aws cloudformation list-change-sets --stack-name <s>`
 * (https://docs.aws.amazon.com/cli/latest/reference/cloudformation/list-change-sets.html):
 * `--no-paginate` so the CLI returns the first API page and not every page, at most 100 entries of
 * it, and `more` when AWS had another page or this one was cut. Each summary is its name, ARN,
 * status, execution status, capped status reason and creation time.
 */
async function changeSetsList(stackName: string): Promise<ReturnType<typeof jsonResult>> {
  const d = parseObject(
    await awsOk([
      "cloudformation",
      "list-change-sets",
      "--stack-name",
      stackName,
      "--no-paginate",
      "--output",
      "json",
    ]),
    "list-change-sets",
  );
  const summaries = Array.isArray(d["Summaries"]) ? d["Summaries"] : [];
  const changeSets = summaries
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .slice(0, CHANGESETS_LIST_MAX)
    .map((s) => ({
      changeSetName: str(s["ChangeSetName"]) ?? null,
      changeSetId: str(s["ChangeSetId"]) ?? null,
      status: str(s["Status"]) ?? null,
      executionStatus: str(s["ExecutionStatus"]) ?? null,
      statusReason: reasonOf(s["StatusReason"]),
      creationTime: str(s["CreationTime"]) ?? null,
    }));
  const token = str(d["NextToken"]);
  const more = (token !== undefined && token !== "") || summaries.length > CHANGESETS_LIST_MAX;
  return jsonResult({ stackName, changeSets, more });
}

/**
 * `aws cloudformation describe-change-set --stack-name <s> --change-set-name <name or ARN>`
 * (https://docs.aws.amazon.com/cli/latest/reference/cloudformation/describe-change-set.html), every
 * page of changes followed as the prepare tool follows them, with its bounds. `Parameters` are
 * reduced to their keys: a value can be a secret (a NoEcho parameter is masked by AWS, but a
 * parameter that should have been NoEcho is not).
 */
async function changeSetGet(p: {
  stackName: string;
  changeSetName: string;
}): Promise<ReturnType<typeof jsonResult>> {
  const describe = async (nextToken?: string): Promise<string> => {
    const r = await runCliCode(
      [
        "aws",
        "cloudformation",
        "describe-change-set",
        "--stack-name",
        p.stackName,
        "--change-set-name",
        p.changeSetName,
        ...(nextToken === undefined ? [] : ["--next-token", nextToken]),
        "--output",
        "json",
      ],
      awsEnv(),
    );
    if (r.code !== 0) {
      if (/ChangeSetNotFound/.test(r.stderr)) throw new Error("change set not found");
      throw new Error(`aws exited ${String(r.code)}: ${r.stderr.slice(0, 500)}`);
    }
    return r.stdout;
  };
  const d = parseObject(await describe(), "describe-change-set");
  // A change set named by ARN identifies its stack itself, and AWS may then ignore --stack-name:
  // the reply must name the stack the caller asked about (by name or by stack ARN), else it is
  // refused, so a read scoped to one stack never answers for another.
  if (p.stackName !== str(d["StackName"]) && p.stackName !== str(d["StackId"])) {
    throw new Error(`change set belongs to a different stack, not ${p.stackName}`);
  }
  const changes = await collectChanges(d, describe);
  const parameterKeys = (Array.isArray(d["Parameters"]) ? d["Parameters"] : [])
    .flatMap((x: unknown) => {
      const k =
        typeof x === "object" && x !== null
          ? str((x as Record<string, unknown>)["ParameterKey"])
          : undefined;
      return k === undefined ? [] : [k];
    })
    .sort((a, b) => a.localeCompare(b));
  const reply = {
    changeSetName: str(d["ChangeSetName"]) ?? null,
    changeSetId: str(d["ChangeSetId"]) ?? null,
    stackName: str(d["StackName"]) ?? null,
    status: str(d["Status"]) ?? null,
    executionStatus: str(d["ExecutionStatus"]) ?? null,
    statusReason: reasonOf(d["StatusReason"]),
    creationTime: str(d["CreationTime"]) ?? null,
    capabilities: stringList(d["Capabilities"]),
    parameterKeys,
    changes,
  };
  if (Buffer.byteLength(JSON.stringify(reply), "utf8") > CHANGESET_REPLY_MAX_BYTES) {
    throw new Error("change set too large");
  }
  return jsonResult(reply);
}

const PULUMI_UP_REFUSAL =
  "iac_pulumi_up is refused: Pulumi saved update plans are documented as experimental, so no plan-bound apply exists (OR-W34-2)";

/** Tool names exposed by this connector — for contract/introspection tests. */
export const IAC_TOOL_NAMES = [
  "iac_terraform_plan",
  "iac_terraform_destroy_plan",
  "iac_terraform_plan_refresh_only",
  "iac_terraform_show_json",
  "iac_terraform_apply",
  "iac_terraform_destroy",
  "iac_terraform_apply_refresh_only",
  "iac_terraform_init",
  "iac_cloudformation_changeset_create",
  "iac_cloudformation_changeset_discard",
  "iac_cloudformation_deploy",
  "iac_cloudformation_stack_get",
  "iac_cloudformation_changesets_list",
  "iac_cloudformation_changeset_get",
  "iac_pulumi_preview",
  "iac_pulumi_up",
] as const;

export function registerIacTools(
  server: ConsentServer & { tool: (...args: never) => unknown },
): void {
  const reg = createZodToolRegistrar(createRegisterSimpleTool(server));

  const cfg = {
    connector: "iac",
    scopeEnv: "NIMBUS_MCP_IAC_WRITE_SCOPE",
    scopeKinds: ["dir", "stack"],
  } as const;

  /**
   * Every MUTATING iac tool goes through here. Outside the gateway this adds the
   * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
   * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
   */
  const registerWriteTool = createWriteToolRegistrar(server, cfg);
  /** Tools the gateway calls before a write's prompt: they change nothing but a scratch area. */
  const registerPrepareTool = createPrepareToolRegistrar(server, cfg);

  const dirScope = (p: { workingDirectory: string }): { kind: string; value: string } => ({
    kind: "dir",
    value: p.workingDirectory,
  });
  const stackScope = (p: { stackName: string }): { kind: string; value: string } => ({
    kind: "stack",
    value: p.stackName,
  });

  registerPrepareTool(
    "iac_terraform_plan",
    { scopeTargetOf: dirScope },
    "Run terraform plan in a directory and save the plan under NIMBUS_IAC_PLAN_DIR. Returns the plan id, file, its SHA-256 and whether it has changes.",
    z.object({ workingDirectory: cliArg }),
    (p) => terraformPlan(p.workingDirectory, "apply"),
  );

  registerPrepareTool(
    "iac_terraform_destroy_plan",
    { scopeTargetOf: dirScope },
    "Run terraform plan -destroy in a directory and save the plan under NIMBUS_IAC_PLAN_DIR.",
    z.object({ workingDirectory: cliArg }),
    (p) => terraformPlan(p.workingDirectory, "destroy"),
  );

  registerPrepareTool(
    "iac_terraform_plan_refresh_only",
    { scopeTargetOf: dirScope },
    "Run terraform plan -refresh-only in a directory and save the plan (refresh.tfplan) under NIMBUS_IAC_PLAN_DIR. Returns the plan id, file, its SHA-256 and whether the state would change.",
    z.object({ workingDirectory: cliArg }),
    (p) => terraformPlan(p.workingDirectory, "refresh-only"),
  );

  registerPrepareTool(
    "iac_terraform_show_json",
    { scopeTargetOf: dirScope },
    "Render a saved terraform plan file as JSON (terraform show -json).",
    z.object({ workingDirectory: cliArg, planFile: planFileArg }),
    async (p) => {
      const planFile = await resolvePlanFile(p.planFile, [
        PLAN_NAME,
        DESTROY_PLAN_NAME,
        REFRESH_PLAN_NAME,
      ]);
      // Read once, immediately before the show: the hash is of the bytes the owner is shown.
      const planSha256 = sha256Of(await readFile(planFile));
      const r = await runCliCode(
        ["terraform", `-chdir=${p.workingDirectory}`, "show", "-json", "-no-color", planFile],
        terraformEnv(),
      );
      if (r.code !== 0) {
        throw new Error(`terraform exited ${String(r.code)}: ${r.stderr.slice(0, 500)}`);
      }
      if (Buffer.byteLength(r.stdout, "utf8") > PLAN_JSON_MAX_BYTES) {
        throw new Error("plan JSON too large");
      }
      try {
        JSON.parse(r.stdout);
      } catch {
        throw new Error("terraform show -json did not print JSON");
      }
      return jsonResult({ planJson: r.stdout, planSha256 });
    },
  );

  const applyShape = {
    workingDirectory: cliArg,
    planFile: planFileArg,
    planSha256: sha256Hex,
  };
  const applyPreState = (p: {
    workingDirectory: string;
    planFile: string;
    planSha256: string;
  }): Promise<Record<string, unknown>> =>
    Promise.resolve({
      workingDirectory: p.workingDirectory,
      planFile: p.planFile,
      planSha256: p.planSha256,
    });

  registerWriteTool(
    "iac_terraform_apply",
    {
      mutates: "iac.terraform.apply",
      // Applying infrastructure cannot be undone from its own result; the plan's identity is the
      // record.
      recoverable: false,
      capturePreState: applyPreState,
      scopeTargetOf: dirScope,
      refuseBefore: (p) => planFilePathProblem(p.planFile, [PLAN_NAME]),
    },
    "Apply a saved terraform plan file (plan.tfplan) whose SHA-256 matches the approved one.",
    z.object(applyShape),
    (p) => terraformApplyPlan(p, PLAN_NAME),
  );

  registerWriteTool(
    "iac_terraform_destroy",
    {
      mutates: "iac.terraform.destroy",
      recoverable: false,
      capturePreState: applyPreState,
      scopeTargetOf: dirScope,
      refuseBefore: (p) => planFilePathProblem(p.planFile, [DESTROY_PLAN_NAME]),
    },
    "Apply a saved terraform destroy plan file (destroy.tfplan) whose SHA-256 matches the approved one.",
    z.object(applyShape),
    (p) => terraformApplyPlan(p, DESTROY_PLAN_NAME),
  );

  registerWriteTool(
    "iac_terraform_apply_refresh_only",
    {
      mutates: "iac.terraform.apply_refresh_only",
      // Accepting drift rewrites the state; the plan's identity is the record.
      recoverable: false,
      capturePreState: applyPreState,
      scopeTargetOf: dirScope,
      refuseBefore: (p) => planFilePathProblem(p.planFile, [REFRESH_PLAN_NAME]),
    },
    "Apply a saved terraform refresh-only plan file (refresh.tfplan) whose SHA-256 matches the approved one: updates the state to match what exists, changes no infrastructure, and refuses a plan that would.",
    z.object(applyShape),
    (p) => terraformApplyPlan(p, REFRESH_PLAN_NAME),
  );

  registerWriteTool(
    "iac_terraform_init",
    {
      mutates: "iac.terraform.init",
      // It writes `.terraform/` and `.terraform.lock.hcl` in the directory and fetches the
      // providers and modules the configuration names; no tool undoes that.
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ workingDirectory: p.workingDirectory }),
      // The directory guard of iac_terraform_plan, unchanged: the same schema and the same scope.
      scopeTargetOf: dirScope,
    },
    "Run terraform init in a directory (-input=false; no -upgrade, -reconfigure, -migrate-state or -backend-config, and no other flag): writes .terraform/ and .terraform.lock.hcl and fetches the providers and modules the configuration names.",
    z.object({ workingDirectory: cliArg }),
    (p) => terraformInit(p.workingDirectory),
  );

  registerPrepareTool(
    "iac_cloudformation_changeset_create",
    { scopeTargetOf: stackScope },
    "Create a CloudFormation change set for a template and list its resource changes. Nothing is executed.",
    z.object({
      stackName: awsCliArg,
      templateBody: templateDocument,
      capabilities: capabilitiesSchema,
    }),
    changeSetCreate,
  );

  registerWriteTool(
    "iac_cloudformation_changeset_discard",
    {
      mutates: "iac.cloudformation.changeset.discard",
      recoverable: false,
      capturePreState: async (p) => {
        const d = await describeChangeSetOrMissing(p.changeSetId);
        return d === undefined
          ? { exists: false }
          : {
              exists: true,
              status: str(d["Status"]) ?? null,
              executionStatus: str(d["ExecutionStatus"]) ?? null,
            };
      },
      scopeTargetOf: stackScope,
      refuseBefore: (p) => discardProblem(p.changeSetId),
    },
    "Delete a change set made by iac_cloudformation_changeset_create, and the empty stack shell it left.",
    z.object({ stackName: awsCliArg, changeSetId: changeSetArn }),
    changeSetDiscard,
  );

  registerWriteTool(
    "iac_cloudformation_deploy",
    {
      mutates: "iac.cloudformation.deploy",
      recoverable: false,
      capturePreState: async (p) => {
        const s = await describeStack(p.stackName);
        return s.exists
          ? { exists: true, stackStatus: s.status, lastUpdatedTime: s.lastUpdatedTime ?? null }
          : { exists: false, stackStatus: null, lastUpdatedTime: null };
      },
      scopeTargetOf: stackScope,
      refuseBefore: deployProblem,
    },
    "Execute a reviewed CloudFormation change set (made by iac_cloudformation_changeset_create for exactly this template).",
    z.object({
      stackName: awsCliArg,
      templateBody: templateDocument,
      capabilities: capabilitiesSchema,
      changeSetId: changeSetArn,
    }),
    changeSetExecute,
  );

  reg(
    "iac_cloudformation_stack_get",
    "Describe a CloudFormation stack's status.",
    z.object({ stackName: awsCliArg }),
    async (p) => {
      const s = await describeStack(p.stackName);
      return jsonResult(
        s.exists
          ? {
              exists: true,
              status: s.status,
              statusReason: s.statusReason ?? null,
              lastUpdatedTime: s.lastUpdatedTime ?? null,
            }
          : { exists: false },
      );
    },
  );

  reg(
    "iac_cloudformation_changesets_list",
    "List a CloudFormation stack's change sets (one page, at most 100): {stackName, changeSets:[{changeSetName, changeSetId, status, executionStatus, statusReason, creationTime}], more}.",
    z.object({ stackName: awsCliArg }),
    (p) => changeSetsList(p.stackName),
  );

  reg(
    "iac_cloudformation_changeset_get",
    "Describe one change set of a CloudFormation stack, by name or ARN: its status, execution status, capabilities, parameter keys (never values) and resource changes [{action, logicalId, physicalId, resourceType, replacement, scope}].",
    z.object({ stackName: awsCliArg, changeSetName: awsCliArg }),
    changeSetGet,
  );

  reg(
    "iac_pulumi_preview",
    "Run pulumi preview in a stack directory.",
    z.object({ workingDirectory: cliArg }),
    async (p) => {
      await runCliOkThrowing(
        ["pulumi", "preview", "--cwd", p.workingDirectory, "--non-interactive"],
        { ...process.env },
      );
      return jsonResult({ ok: true });
    },
  );

  registerWriteTool(
    "iac_pulumi_up",
    {
      mutates: "iac.pulumi.up",
      // An apply changes real infrastructure, so the flag says it cannot be undone. The tool is
      // refused before every run, so the capture never executes; it records the directory anyway.
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ workingDirectory: p.workingDirectory }),
      scopeTargetOf: dirScope,
      refuseBefore: () => PULUMI_UP_REFUSAL,
    },
    "Refused: no plan-bound Pulumi apply exists. Kept registered so the refusal names its reason.",
    z.object({ workingDirectory: cliArg }),
    // Pulumi's saved update plans are experimental, so there is nothing the owner could approve
    // that an apply is then bound to. Refused on every door, spawning nothing.
    () => Promise.reject(new Error(PULUMI_UP_REFUSAL)),
  );
}
