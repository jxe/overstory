// A collection's tables (spec 2.3): the table, enum, connection and `re` declarations
// of a schema.beetle, translated to the table checker's syntax tree (./tables) and checked
// there; the layout, relationships, records, setup SQL and fingerprints are built on its
// result. Defaults and state tables stay here: neither is part of the data layer.

import { checkTables, type CheckResult } from "./tables/index.ts";
import type * as Tables from "./tables/index.ts";
import type { Diagnostic, EnumDecl, Expr, ReDecl, SchemaAttribute, Span, TableDecl, TableMember, ViewFile } from "./ast.ts";
import { parseView } from "./parse.ts";

export interface SchemaResult extends CheckResult {
  /** Field defaults by table, then field (§2.1). */
  defaults: Record<string, Record<string, Expr>>;
}

const at = (span: Span): Tables.Position => ({ line: span.line, column: span.column });

function arg(e: Expr): Tables.Expr {
  const position = at(e.span);
  switch (e.kind) {
    case "name": return { kind: "ident", name: e.name, attrs: [], at: position };
    case "literal":
      if (typeof e.value === "string") return { kind: "string", value: e.value, at: position };
      if (typeof e.value === "number") return { kind: "number", value: e.value, at: position };
      return { kind: "ident", name: String(e.value), attrs: [], at: position };
    case "list": return { kind: "list", items: e.items.map(arg), at: position };
    case "annotated": {
      const value = arg(e.value);
      return value.kind === "ident" ? { ...value, attrs: attributes(e.attrs) } : value;
    }
    case "record": return { kind: "object", entries: e.entries.map((x) => ({ key: x.name, value: arg(x.value), at: at(x.nameSpan) })), at: position };
    default: return { kind: "string", value: "", at: position };
  }
}

/**
 * A row's color is data (spec 2.3): a Text field named `color`, on a table's rows or in
 * an enum value's record. Story's list views read it as the table checker's
 * `~color`, so the translation adds that attribute; Beetle itself has no `~` attributes
 * except `~views`, which stays until lists are drawn from Beetle views.
 */
const COLOR = "color";

function colorAttribute(at: Tables.Position, value?: string): Tables.Attribute {
  return { sigil: "~", name: COLOR, args: value === undefined ? [] : [{ kind: "string", value, at }], at };
}

function isColorField(m: TableMember): boolean {
  return m.kind === "field" && m.name === COLOR && m.type === "Text" && m.arity !== "many";
}

/** `~x` written in a schema: only `~views` is left of Beetle's presentation attributes. */
function presentationAttributes(file: ViewFile): Diagnostic[] {
  const found: Diagnostic[] = [];
  const check = (attrs: SchemaAttribute[]) => {
    for (const a of attrs) {
      if (a.sigil === "~" && a.name !== "views") {
        found.push({
          code: "presentation-attribute",
          message: a.name === COLOR
            ? "A color is data: give the table or enum a `color Text` field, and enum values a record with their color"
            : `\`~${a.name}\` is not Beetle; presentation belongs in views`,
          ...a.span,
        });
      }
    }
  };
  const walk = (members: TableMember[]) => {
    for (const m of members) {
      if (m.kind === "field" || m.kind === "value" || m.kind === "mention") check(m.attrs);
      else if (m.kind === "attribute") check([m.attr]);
      else if (m.kind === "seed") walk(m.rows);
    }
  };
  for (const { decl } of file.declarations) {
    if (decl.kind === "table" || decl.kind === "enum" || decl.kind === "re") walk(decl.members);
  }
  return found;
}

function attributes(attrs: SchemaAttribute[]): Tables.Attribute[] {
  return attrs.map((a) => ({ sigil: a.sigil, name: a.name, args: (a.args ?? []).map(arg), at: at(a.span) }));
}

function row(member: Extract<TableMember, { kind: "value" }>): Tables.Row {
  return {
    name: member.name,
    values: (member.values?.entries ?? []).map((x) => ({ key: x.name, value: arg(x.value), at: at(x.nameSpan) })),
    attrs: attributes(member.attrs),
    at: at(member.span),
  };
}

/** Where a table's connection fields go: a connection table's become its ends, any other's its connections. */
interface Owner {
  name: string;
  connectionTable: boolean;
  connections: Tables.ConnectionDecl[];
}

function members(list: TableMember[], context: "table" | "enum" | "re", owner?: Owner): Tables.Member[] {
  const result: Tables.Member[] = [];
  const values: Tables.Row[] = [];
  let valuesAt: Tables.Position | null = null;
  for (const m of list) {
    switch (m.kind) {
      case "field":
        if (m.link && owner) {
          const link = m.link;
          const far: Tables.EndDecl = {
            kind: "end", model: m.type, field: link.inverse, arity: link.inverseArity,
            ordered: link.inverseOrdered ? at(link.span) : null, as: null, attrs: [], at: at(link.span),
          };
          if (owner.connectionTable) {
            // `list: List <-> ordered items[]` in a connection table is its end `ordered List.items[] as list`.
            if (m.name !== m.type.toLowerCase()) far.as = { name: m.name, at: at(m.span) };
            far.attrs = attributes(m.attrs);
            result.push(far);
            if (link.array) result.push({ kind: "modelAttribute", sigil: "@", name: "fold", args: [{ kind: "ident", name: m.type, attrs: [], at: at(link.span) }], at: at(link.span) });
          } else {
            const near: Tables.EndDecl = {
              kind: "end", model: owner.name, field: m.name, arity: m.arity,
              ordered: m.modifiers.includes("ordered") ? at(m.span) : null, as: null,
              attrs: [...attributes(m.attrs), ...(link.array ? [{ sigil: "@" as const, name: "fold", args: [], at: at(link.span) }] : [])],
              at: at(m.span),
            };
            owner.connections.push({ kind: "connection", spelling: "arrow", members: [near, far], at: at(m.span) });
            // The field also stands where it is written, so the table's fields keep their written order.
            result.push({ kind: "field", name: m.name, modifiers: [], type: m.type, arity: m.arity, attrs: [], at: at(m.span) });
          }
          break;
        }
        result.push({
          kind: "field", name: m.name, modifiers: m.modifiers.map((name) => ({ name, at: at(m.span) })), type: m.type,
          arity: m.arity, attrs: [...attributes(m.attrs), ...(context === "table" && isColorField(m) && !m.attrs.some((a) => a.name === COLOR) ? [colorAttribute(at(m.span))] : [])],
          at: at(m.span),
        });
        break;
      case "attribute":
        result.push({ kind: "modelAttribute", sigil: m.attr.sigil, name: m.attr.name, args: (m.attr.args ?? []).map(arg), at: at(m.attr.span) });
        break;
      case "value": {
        valuesAt ??= at(m.span);
        const value = row(m);
        const color = list.some(isColorField) ? m.values?.entries.find((e) => e.name === COLOR)?.value : undefined;
        if (color?.kind === "literal" && typeof color.value === "string" && !value.attrs.some((a) => a.name === COLOR)) value.attrs.push(colorAttribute(at(m.span), color.value));
        values.push(value);
        break;
      }
      case "seed":
        result.push({ kind: "rows", mode: "seed", rows: m.rows.flatMap((r) => (r.kind === "value" ? [row(r)] : [])), at: at(m.span) });
        break;
      case "mention":
        result.push({ kind: "mention", name: m.name, attrs: attributes(m.attrs), at: at(m.span) });
        break;
      case "comment":
        break;
    }
  }
  if (context === "enum") result.push({ kind: "rows", mode: "fixed", rows: values, at: valuesAt ?? { line: 1, column: 1 } });
  return result;
}

/** The data tables a file declares, as the table checker's syntax tree, and where they may not be. */
export function tablesFileOf(file: ViewFile, isSchema: boolean): { tables: Tables.SchemaFile; diagnostics: Diagnostic[]; defaults: SchemaResult["defaults"] } {
  const declarations: Tables.Declaration[] = [];
  const diagnostics: Diagnostic[] = [];
  const defaults: SchemaResult["defaults"] = {};
  for (const { decl } of file.declarations) {
    if (decl.kind === "table" && (decl.tableKind === "my" || decl.tableKind === "session")) continue;
    const isData = decl.kind === "table" || decl.kind === "re";
    if (isData && !isSchema) {
      const span = decl.nameSpan;
      diagnostics.push({
        code: "data-table-outside-schema",
        message: "A collection's data tables, connections and re blocks are declared only in its schema.beetle; declare state here as `my table` or `session table`",
        ...span,
      });
      continue;
    }
    switch (decl.kind) {
      case "table": {
        const table = decl as TableDecl;
        for (const m of table.members) {
          if (m.kind === "field" && m.default) (defaults[table.name] ??= {})[m.name] = m.default;
        }
        const owner: Owner = { name: table.name, connectionTable: table.tableKind === "connection", connections: [] };
        declarations.push({
          kind: "model", form: "model", name: table.name, main: table.tableKind === "main" ? at(table.span) : null,
          key: table.key ? { fields: table.key.map((k) => ({ name: k.name, at: at(k.span) })), at: at(table.key[0]!.span) } : null,
          members: members(table.members, "table", owner), at: at(table.nameSpan),
        });
        declarations.push(...owner.connections);
        break;
      }
      case "enum": {
        if (!isSchema) break; // a file's own enums are checked with its state tables
        const e = decl as EnumDecl;
        const owner: Owner = { name: e.name, connectionTable: false, connections: [] };
        declarations.push({ kind: "model", form: "enum", name: e.name, main: null, key: null, members: members(e.members, "enum", owner), at: at(e.nameSpan) });
        declarations.push(...owner.connections);
        break;
      }
      case "re": {
        const re = decl as ReDecl;
        declarations.push({ kind: "re", name: re.name, members: members(re.members, "re"), at: at(re.nameSpan) });
        break;
      }
      default:
        break;
    }
  }
  return { tables: { declarations }, diagnostics, defaults };
}

/**
 * The table checker's result, reported once per line: a connection written as a field is both
 * a field and a connection to the checker, so one mistake can surface twice on its line.
 */
export function checkSchemaTables(tables: Tables.SchemaFile): ReturnType<typeof checkTables> {
  const result = checkTables(tables);
  const ends = new Set(result.diagnostics.filter((d) => d.code === "duplicate-end").map((d) => d.line));
  const seen = new Set<string>();
  const diagnostics = result.diagnostics.filter((d) => {
    if (d.code === "duplicate-field" && ends.has(d.line)) return false;
    const key = `${d.line}:${d.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...result, diagnostics };
}

/** Checks a schema.beetle's tables. Its views, rules and mutations are checked by checkView. */
export function compileSchema(text: string): SchemaResult {
  const parsed = parseView(text);
  const { tables, diagnostics, defaults } = tablesFileOf(parsed.file, true);
  const result = checkSchemaTables(tables);
  return { ...result, diagnostics: [...parsed.diagnostics, ...presentationAttributes(parsed.file), ...diagnostics, ...result.diagnostics], defaults };
}
