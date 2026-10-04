import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type SalesforceSearchMatchOptions = SearchMatchOptions;

/**
 * Salesforce Opportunity records are flat objects with PascalCase fields:
 * `{ Id, Name, StageName, Amount, CloseDate, Type, ... }`. Match (case-insensitive
 * substring) against the opportunity name, its stage, and its type.
 */
export const filterSalesforceOpportunities = makeQueryFilter(
  fieldsFromKeys(["Name", "StageName", "Type"]),
);
