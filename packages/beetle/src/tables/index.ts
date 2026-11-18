// The tables of a schema.beetle once checked (spec 3.3): resolved
// models, their storage layout, model fingerprint layer, logical rows, setup
// SQL, and checks that a store implements them. `compileSchema` in ../schema.ts
// produces the CheckResult everything here reads.

export * from "./ast.ts";
export {
  logicalModels,
  logicalFromRows,
  rowsFromLogical,
  compareLogicalRows,
  type LogicalField,
  type LogicalModel,
  type LogicalRow,
  type LogicalTables,
  type LogicalValue,
  type FromRowsOptions,
} from "./logical.ts";
export { modelLayer, type ModelLayer, type ModelLayerEnd } from "./fingerprint.ts";
export { layoutOf, LayoutError, type Column, type ColumnType, type ForeignKey, type JoinEnd, type StoredField, type Table } from "./layout.ts";
export {
  rowOf,
  recordOf,
  joinRowsOf,
  rowsFromRecords,
  recordsFromRows,
  type StoredRecord,
  type RecordsByModel,
  type RowsByTable,
  type RecordOptions,
} from "./records.ts";
export { setupSql, columnType, SQL_TYPES, type Dialect, type SetupOptions } from "./sql.ts";
export { validateRow, fitsColumn, fromCell, type RowDiagnostic } from "./rows.ts";
export { typeDeclarations } from "./types.ts";
export { relationshipsOf, isPersonValue, personPlaceholderKey, PERSON_PLACEHOLDER_PREFIX, PERSON_RELATION, type Relationship } from "./relationships.ts";
export {
  checkTables,
  BUILTIN_MODELS,
  IMPLICIT_FIELDS,
  VALUE_TYPES,
  type CheckResult,
  type ResolvedConnection,
  type ResolvedEnd,
  type RowValue,
  type ResolvedField,
  type ResolvedModel,
  type ResolvedView,
  type LineItem,
  type Storage,
} from "./check.ts";

import type { Diagnostic } from "./ast.ts";

export function formatDiagnostic(path: string, d: Diagnostic): string {
  return `${path}:${d.line}:${d.column}: ${d.code}: ${d.message}`;
}
