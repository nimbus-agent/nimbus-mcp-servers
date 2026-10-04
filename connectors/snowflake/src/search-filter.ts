import {
  makeQueryFilter,
  recordFieldsFromKeys,
  type SearchMatchOptions,
} from "../../../shared/search-filter.ts";

export type SnowflakeSearchMatchOptions = SearchMatchOptions;

export const filterSnowflakeTables = makeQueryFilter(
  recordFieldsFromKeys(["table_name", "schema_name", "database_name"]),
);
