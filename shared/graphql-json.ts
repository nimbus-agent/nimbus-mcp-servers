/**
 * graphql-json — one GraphQL-over-HTTP request, for the connectors whose API is a
 * GraphQL endpoint read as plain JSON (dagster, wiz).
 *
 * Both had written out the same request and the same reading of the response
 * envelope: a present `errors` member fails the call even when `data` came back
 * too, and an absent `data` member fails it as well. That reading is a rule about
 * what a partial GraphQL answer means, and it belongs in one place.
 *
 * Linear and Monte Carlo read the envelope differently (an `errors` ARRAY that
 * must be non-empty, messages joined, a result union) and keep their own clients.
 */

/** Body-snippet length in the thrown errors. The value both connectors used. */
const SNIPPET_MAX = 400;

export interface GraphqlRequest {
  /** The GraphQL endpoint. */
  readonly url: string;
  /** Service name that prefixes every failure, e.g. `"Wiz 401: ..."`. */
  readonly label: string;
  /** Auth headers; `Content-Type` and `Accept` (both `application/json`) are added after them. */
  readonly headers: Readonly<Record<string, string>>;
  readonly query: string;
  /** Omitted from the request body entirely when undefined. */
  readonly variables?: Record<string, unknown>;
}

/**
 * POST `query` (and `variables`) to `url` and resolve to the response's `data`.
 *
 * Throws `"<label> <status>: <body snippet>"` on a non-2xx,
 * `"<label> GraphQL error: <errors snippet>"` when the response carries `errors`,
 * and `"<label> GraphQL: response missing \`data\` field"` when it carries no `data`.
 */
export async function postGraphql<T>(request: GraphqlRequest): Promise<T> {
  const res = await fetch(request.url, {
    method: "POST",
    headers: {
      ...request.headers,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: request.query, variables: request.variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${request.label} ${String(res.status)}: ${text.slice(0, SNIPPET_MAX)}`);
  }
  const parsed = JSON.parse(text) as { data?: T; errors?: unknown };
  if (parsed.errors !== undefined) {
    throw new Error(
      `${request.label} GraphQL error: ${JSON.stringify(parsed.errors).slice(0, SNIPPET_MAX)}`,
    );
  }
  if (parsed.data === undefined) {
    throw new Error(`${request.label} GraphQL: response missing \`data\` field`);
  }
  return parsed.data;
}
