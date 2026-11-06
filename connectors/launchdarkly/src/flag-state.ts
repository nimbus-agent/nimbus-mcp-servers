/**
 * Pure helpers for the LaunchDarkly flag tools: the one-environment read projection and the
 * rollout-weight arithmetic. Kept apart from the tool registration so both are testable alone.
 */

/** LaunchDarkly rollout weights are thousandths of a percent: 0..100000, and a flag sums to 100000. */
export const FULL_ROLLOUT = 100_000;

export interface RolloutWeightInput {
  readonly variationId: string;
  readonly percent: number;
}

/**
 * `weights` as the `rolloutWeights` map the semantic patch takes (variation id -> thousandths of a
 * percent). Fails closed: duplicate ids, a percent with more than three decimals, or a total that is
 * not EXACTLY 100% all throw before any request is made. (The API only says the sum "should" be 100%;
 * what it does on a mismatch is not stated, so this connector does not find out on a production flag.)
 */
export function rolloutWeightsOf(weights: readonly RolloutWeightInput[]): Record<string, number> {
  const out: Record<string, number> = {};
  let total = 0;
  for (const w of weights) {
    if (Object.hasOwn(out, w.variationId)) {
      throw new Error(`variationId ${w.variationId} appears more than once`);
    }
    const thousandths = Math.round(w.percent * 1000);
    if (Math.abs(w.percent * 1000 - thousandths) > 1e-6) {
      throw new Error(`percent ${String(w.percent)} has more than 3 decimal places`);
    }
    out[w.variationId] = thousandths;
    total += thousandths;
  }
  if (total !== FULL_ROLLOUT) {
    throw new Error(
      `weights must sum to exactly 100 percent, got ${String(total / 1000)}; nothing was changed`,
    );
  }
  return out;
}

/** The `on` a flag-change reply shows for `environmentKey`, when it is a boolean. */
export function echoedOn(response: unknown, environmentKey: string): boolean | undefined {
  const envs =
    isRecord(response) && isRecord(response["environments"]) ? response["environments"] : {};
  const env = envs[environmentKey];
  return isRecord(env) && typeof env["on"] === "boolean" ? env["on"] : undefined;
}

/**
 * True only when the reply carries `environmentKey`'s fallthrough rollout and its weights (by
 * variation id, a missing id counting as 0) equal `requested`. A reply without them is not a
 * confirmation.
 */
export function rolloutEchoed(
  response: unknown,
  environmentKey: string,
  requested: Readonly<Record<string, number>>,
): boolean {
  if (!isRecord(response)) return false;
  const envs = isRecord(response["environments"]) ? response["environments"] : {};
  const env = envs[environmentKey];
  const fallthrough = isRecord(env) && isRecord(env["fallthrough"]) ? env["fallthrough"] : {};
  const rollout = fallthrough["rollout"];
  if (!isRecord(rollout) || !Array.isArray(rollout["variations"])) return false;
  const variations = Array.isArray(response["variations"]) ? response["variations"] : [];
  const echoed: Record<string, number> = {};
  for (const entry of rollout["variations"]) {
    const row = isRecord(entry) ? entry : {};
    const index = row["variation"];
    const weight = row["weight"];
    const variation = typeof index === "number" ? variations[index] : undefined;
    const id = isRecord(variation) ? variation["_id"] : undefined;
    if (typeof id !== "string" || typeof weight !== "number") return false;
    echoed[id] = weight;
  }
  const ids = new Set([...Object.keys(requested), ...Object.keys(echoed)]);
  for (const id of ids) {
    if ((requested[id] ?? 0) !== (echoed[id] ?? 0)) return false;
  }
  return true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * The state of one flag in one environment, from `GET /flags/{p}/{f}?env={e}`.
 *
 * Variation references (`fallthrough.variation`, `offVariation`, `rollout.variations[].variation`)
 * are read as INDICES into `variations[]`, which is how the schema describes `fallthrough.variation`.
 * The same schema calls `offVariation` an "ID" in one place; the raw number is returned beside the
 * resolved id so a caller can see which reading applied. Pinned by a fixture; live-check item.
 */
export function projectFlagState(
  raw: unknown,
  ids: { projectKey: string; flagKey: string; environmentKey: string },
): Record<string, unknown> {
  const flag = isRecord(raw) ? raw : {};
  const envs = isRecord(flag["environments"]) ? flag["environments"] : {};
  const env = envs[ids.environmentKey];
  if (!isRecord(env)) {
    throw new Error(`LaunchDarkly environment not found: ${ids.environmentKey}`);
  }
  const rawVariations = Array.isArray(flag["variations"]) ? flag["variations"] : [];
  const variations = rawVariations.map((v, index) => {
    const row = isRecord(v) ? v : {};
    return { index, id: row["_id"], name: row["name"], value: row["value"] };
  });
  const idAt = (index: unknown): unknown =>
    typeof index === "number" ? variations[index]?.id : undefined;

  const fallthroughRaw = isRecord(env["fallthrough"]) ? env["fallthrough"] : {};
  const fallthrough: Record<string, unknown> = {};
  if (typeof fallthroughRaw["variation"] === "number") {
    fallthrough["variation"] = fallthroughRaw["variation"];
    fallthrough["variationId"] = idAt(fallthroughRaw["variation"]);
  }
  const rollout = fallthroughRaw["rollout"];
  if (isRecord(rollout) && Array.isArray(rollout["variations"])) {
    fallthrough["rollout"] = rollout["variations"].map((entry) => {
      const row = isRecord(entry) ? entry : {};
      const weight = numberOrUndefined(row["weight"]);
      return {
        variation: row["variation"],
        variationId: idAt(row["variation"]),
        weightPercent: weight === undefined ? undefined : weight / 1000,
      };
    });
  }
  if (isRecord(rollout)) {
    if (typeof rollout["bucketBy"] === "string")
      fallthrough["rolloutBucketBy"] = rollout["bucketBy"];
    if (typeof rollout["contextKind"] === "string") {
      fallthrough["rolloutContextKind"] = rollout["contextKind"];
    }
  }
  return {
    projectKey: ids.projectKey,
    flagKey: ids.flagKey,
    environmentKey: ids.environmentKey,
    on: env["on"],
    offVariation: env["offVariation"],
    offVariationId: idAt(env["offVariation"]),
    fallthrough,
    variations,
    version: numberOrUndefined(env["version"]) ?? numberOrUndefined(flag["_version"]),
    archived: flag["archived"],
  };
}
