import { describe, expect, it } from "bun:test";
import { filterVantageRecommendations } from "../src/search-filter.ts";
import { RECOMMENDATIONS_PAGE } from "./fixtures.ts";

const ROWS = RECOMMENDATIONS_PAGE.recommendations;

describe("filterVantageRecommendations", () => {
  it.each([
    ["description", "over-provisioned"],
    ["type", "CO-RIGHTSIZING"],
    ["service", "amazon s3"],
    ["provider", "AWS"],
    ["category", "S3_INTELLIGENT"],
  ])("matches on %s, case-insensitively", (_key, query) => {
    expect(filterVantageRecommendations(ROWS, { query }).length).toBeGreaterThan(0);
  });

  it("selects only the rows that match", () => {
    expect(filterVantageRecommendations(ROWS, { query: "rightsizing" })).toEqual([ROWS[0]]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterVantageRecommendations(ROWS, { query: "zzz-no-such-thing" })).toEqual([]);
  });

  it("caps the result at `limit`", () => {
    expect(filterVantageRecommendations(ROWS, { query: "aws", limit: 1 })).toHaveLength(1);
  });

  it("skips a row that is not an object", () => {
    expect(filterVantageRecommendations([null, 3, "x"], { query: "x" })).toEqual([]);
  });
});
