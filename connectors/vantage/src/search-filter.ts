import { fieldsFromKeys, makeQueryFilter } from "../../../shared/search-filter.ts";

/** Substring search over an active recommendation's description, type, service, provider and category. */
export const filterVantageRecommendations = makeQueryFilter(
  fieldsFromKeys(["description", "type", "service", "provider", "category"]),
);
