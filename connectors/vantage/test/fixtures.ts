/**
 * Fixtures for the Vantage connector tests.
 *
 * THESE ARE DOCUMENTATION-SHAPED FIXTURES, NOT LIVE RECORDINGS. Every shape below was written from
 * Vantage's published OpenAPI file (https://api.vantage.sh/v2/oas_v3.json, OpenAPI 3.0.1, API
 * version 2.0.0, read 2026-11-12) and its documented response examples. No request was ever made
 * to a real Vantage account and no real token appears anywhere in this repo. The reply shapes have
 * not been checked against a live account (UNVERIFIED).
 *
 * Findings from the OpenAPI file that the connector and its tests rely on:
 *
 * - R1 `groupings` (GET /costs): `style: form`, `explode: false`, an array of strings, and the
 *   description says "join as comma separated values: groupings=provider,service,region". So ONE
 *   query parameter holding a comma-joined list.
 * - R2 grouped keys (Cost schema): the groupable fields (`provider`, `account_id`, `service`,
 *   `region`, `resource_id`, `charge_type`, ...) are top-level keys of a cost row. Where a custom
 *   `tag:<key>` grouping lands is NOT documented (the row has a `tags` array of pairs and a
 *   deprecated `tag` string), so the connector returns rows untouched and does not interpret it.
 * - R3 `start_date` / `end_date`: plain strings, "ISO 8601 formatted", no `format` declared. The
 *   connector sends `YYYY-MM-DD` (UTC). Whether a full datetime is also accepted is not stated.
 * - R5 `links.next` (Links schema): a nullable string URL; the documented last-page example has
 *   `next: null`. The connector treats a non-empty string as "more pages" and anything else as the
 *   last page, and never fetches that URL (it requests `page=N+1` itself).
 * - R6 security: a single `oauth2` scheme (clientCredentials, scopes `read` / `write`) with every
 *   read operation requiring `read`. The file does NOT show `Authorization: Bearer`; that comes
 *   from the authentication docs page (https://docs.vantage.sh/api/authentication). UNVERIFIED
 *   against a live account.
 * - R7 GET /cost_reports/{cost_report_token}: returns a CostReport (`token`, `title`, `workspace_token`,
 *   `groupings` as one string such as "provider, service", `filter`, `start_date`, `end_date`,
 *   `date_interval`, `date_bin`, `settings`, ...).
 * - R8 GET /recommendations: `{ links, recommendations: [...] }`, with `status`, `page`, `limit`
 *   (max 1000) and `workspace_token` query parameters. 429 is not listed among the operation's
 *   documented responses and the `x-rate-limit-reset` header is from the rate-limiting docs page
 *   (UNVERIFIED).
 */

/** GET /costs page 1: the OpenAPI response example's row keys, with a `next` link. */
export const COSTS_PAGE_ONE = {
  links: {
    self: "https://api.vantage.sh/v2/costs?cost_report_token=rprt_example",
    first: "https://api.vantage.sh/v2/costs?cost_report_token=rprt_example&page=1",
    next: "https://api.vantage.sh/v2/costs?cost_report_token=rprt_example&page=2",
    last: null,
    prev: null,
  },
  total_cost: { amount: "500.0", currency: "USD" },
  costs: [
    {
      accrued_at: "2023-06-05",
      amount: "100.0",
      currency: "USD",
      provider: "aws",
      account_id: "mock_56789",
      service: "AmazonSNS",
    },
    {
      accrued_at: "2023-06-04",
      amount: "100.0",
      currency: "USD",
      provider: "aws",
      account_id: "mock_56789",
      service: "AmazonSNS",
    },
  ],
} as const;

/** GET /costs last page: `links.next` is null (the documented last-page example). */
export const COSTS_LAST_PAGE = {
  links: {
    self: "https://api.vantage.sh/v2/costs?cost_report_token=rprt_example&page=2",
    first: "https://api.vantage.sh/v2/costs?cost_report_token=rprt_example&page=1",
    next: null,
    last: null,
    prev: "https://api.vantage.sh/v2/costs?cost_report_token=rprt_example&page=1",
  },
  total_cost: { amount: "500.0", currency: "USD" },
  costs: [
    {
      accrued_at: "2023-06-03",
      amount: "300.0",
      currency: "USD",
      provider: "gcp",
      account_id: "mock_12345",
      service: "Compute Engine",
    },
  ],
} as const;

/** GET /costs with no `links` key at all: the schema marks `links` optional (R5). */
export const COSTS_NO_LINKS = {
  total_cost: { amount: "0.0", currency: "USD" },
  costs: [],
} as const;

/** GET /recommendations: the Recommendation schema's field list (R8). */
export const RECOMMENDATIONS_PAGE = {
  links: {
    self: "https://api.vantage.sh/v2/recommendations?status=active&page=1",
    first: "https://api.vantage.sh/v2/recommendations?status=active&page=1",
    next: "https://api.vantage.sh/v2/recommendations?status=active&page=2",
    last: null,
    prev: null,
  },
  recommendations: [
    {
      token: "rec_example_1",
      type: "aws:ec2:co-rightsizing",
      category: "ec2_compute_optimizer_recommender",
      workspace_token: "wrkspc_example",
      provider: "aws",
      provider_account_id: "123456789012",
      service: "Amazon EC2",
      description: "Rightsize an over-provisioned EC2 instance",
      documentation_url: "https://handbook.vantage.sh/aws/services/ec2-pricing/",
      potential_savings: "100.00",
      resources_affected_count: 3,
      currency_code: "USD",
      currency_symbol: "$",
      created_at: "2026-11-01T00:00:00Z",
    },
    {
      token: "rec_example_2",
      type: "aws:s3:intelligent-tiering",
      category: "s3_intelligent_tiering",
      workspace_token: "wrkspc_example",
      provider: "aws",
      provider_account_id: "123456789012",
      service: "Amazon S3",
      description: "Move cold buckets to Intelligent-Tiering",
      documentation_url: null,
      potential_savings: "25.50",
      resources_affected_count: 1,
      currency_code: "USD",
      currency_symbol: "$",
      created_at: "2026-11-02T00:00:00Z",
    },
  ],
} as const;

/** GET /recommendations last page. */
export const RECOMMENDATIONS_LAST_PAGE = {
  links: { self: "https://api.vantage.sh/v2/recommendations?status=active&page=2", next: null },
  recommendations: [],
} as const;

/** GET /cost_reports/{token}: a subset of the CostReport schema (R7). */
export const COST_REPORT = {
  token: "rprt_example",
  title: "Production Environment",
  workspace_token: "wrkspc_example",
  filter: null,
  groupings: "provider, service",
  start_date: "2024-07-01",
  end_date: "2024-07-15",
  date_interval: "last_30_days",
  date_bin: "day",
  chart_type: "bar",
  created_at: "2021-07-09T00:00:00Z",
} as const;

/** A token-shaped string for tests. Not a real credential. */
export const TEST_TOKEN = "vantage-test-token-not-real";
