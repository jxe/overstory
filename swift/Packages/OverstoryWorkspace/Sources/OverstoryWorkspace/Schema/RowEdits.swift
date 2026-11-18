import Foundation

// Row operations on a collection's data-file rows (spec 3.1 §2): the edits
// Story queues, checked and applied locally until the host's result arrives.
// Rows are the data-file rows `schemaLayout(…, store: .files)` lays out, by table
// name, in creation order. A row is named by its canonical stable key, the
// JSON of its key's column and value pairs: `[["id","g1"]]`.

public typealias SchemaRow = [String: JSONValue]
public typealias SchemaRowsByTable = [String: [SchemaRow]]

public struct RowEditError: Error, Sendable, Equatable {
    public var message: String
}

/// A row operation, as spec 10 §4.1 defines it, without the change-scoped
/// `key` and the `collection` reference, which the publisher adds.
public enum RowEdit: Sendable, Equatable {
    case create(table: String, row: String, values: SchemaRow, at: String?)
    case delete(table: String, row: String)
    case set(table: String, row: String, field: String, before: JSONValue, value: JSONValue, at: String?)
    case connect(table: String, row: String, field: String, member: JSONValue, at: String?)
    case disconnect(table: String, row: String, field: String, member: JSONValue, at: String?)
    /// `after: nil` places the member first.
    case move(table: String, row: String, field: String, member: JSONValue, after: JSONValue?, at: String?)

    var table: String {
        switch self {
        case .create(let t, _, _, _), .delete(let t, _), .set(let t, _, _, _, _, _), .connect(let t, _, _, _, _), .disconnect(let t, _, _, _, _), .move(let t, _, _, _, _, _): t
        }
    }
    var row: String {
        switch self {
        case .create(_, let r, _, _), .delete(_, let r), .set(_, let r, _, _, _, _), .connect(_, let r, _, _, _), .disconnect(_, let r, _, _, _), .move(_, let r, _, _, _, _): r
        }
    }

    /// The operation as spec 10 §4.1 spells it.
    public var json: JSONValue {
        func object(_ kind: String, _ members: [String: JSONValue], _ at: String?) -> JSONValue {
            var o = members
            o["kind"] = .string(kind)
            o["table"] = .string(table)
            o["row"] = .string(row)
            if let at { o["at"] = .string(at) }
            return .object(o)
        }
        switch self {
        case .create(_, _, let values, let at): return object("rowCreate", ["values": .object(values)], at)
        case .delete: return object("rowDelete", [:], nil)
        case .set(_, _, let field, let before, let value, let at): return object("set", ["field": .string(field), "before": before, "value": value], at)
        case .connect(_, _, let field, let member, let at): return object("connect", ["field": .string(field), "member": member], at)
        case .disconnect(_, _, let field, let member, let at): return object("disconnect", ["field": .string(field), "member": member], at)
        case .move(_, _, let field, let member, let after, let at): return object("move", ["field": .string(field), "member": member, "after": after ?? .null], at)
        }
    }

    /// The edit `json` spells, read back.
    public init(json: JSONValue) throws {
        guard case let .object(o) = json, let kind = o["kind"]?.stringValue, let table = o["table"]?.stringValue,
              let row = o["row"]?.stringValue else { throw RowEditError(message: "not a row edit: \(json.jsonText)") }
        let at = o["at"]?.stringValue
        func field() throws -> String {
            guard let name = o["field"]?.stringValue else { throw RowEditError(message: "\(kind) names no field") }
            return name
        }
        func value(_ name: String) throws -> JSONValue {
            guard let value = o[name] else { throw RowEditError(message: "\(kind) has no \(name)") }
            return value
        }
        switch kind {
        case "rowCreate":
            guard case let .object(values) = try value("values") else { throw RowEditError(message: "rowCreate values aren't an object") }
            self = .create(table: table, row: row, values: values, at: at)
        case "rowDelete": self = .delete(table: table, row: row)
        case "set": self = .set(table: table, row: row, field: try field(), before: try value("before"), value: try value("value"), at: at)
        case "connect": self = .connect(table: table, row: row, field: try field(), member: try value("member"), at: at)
        case "disconnect": self = .disconnect(table: table, row: row, field: try field(), member: try value("member"), at: at)
        case "move":
            let after = try value("after")
            self = .move(table: table, row: row, field: try field(), member: try value("member"), after: after.isNull ? nil : after, at: at)
        default: throw RowEditError(message: "unknown row edit \(kind)")
        }
    }
}

func sameJSON(_ a: JSONValue?, _ b: JSONValue?) -> Bool { (a ?? .null).jsonText == (b ?? .null).jsonText }

/// A row's canonical stable key, or nil when a key column holds no scalar.
public func schemaRowKey(_ table: SchemaTable, _ row: SchemaRow) -> String? {
    var pairs: [JSONValue] = []
    for column in table.primaryKey {
        guard let value = row[column], value.isScalar else { return nil }
        pairs.append(.array([.string(column), value]))
    }
    return JSONValue.array(pairs).jsonText
}

public struct SchemaRowsDiagnostic: Sendable, Equatable {
    public var code: String
    public var table: String
    public var row: String?
    public var column: String?
    public var message: String
}

/// Every row against its table: values, keys, distinct members, and references to rows that exist.
public func checkRows(_ schema: SchemaCheckResult, _ rows: SchemaRowsByTable) throws -> [SchemaRowsDiagnostic] {
    let tables = try schemaLayout(schema, store: .files)
    var out: [SchemaRowsDiagnostic] = []
    for table in tables {
        var seen = Set<String>()
        for row in rows[table.name] ?? [] {
            guard let key = schemaRowKey(table, row) else {
                out.append(SchemaRowsDiagnostic(code: "missing-key", table: table.name, message: "A row of \(table.name) has no key"))
                continue
            }
            for d in schemaValidateRow(table, row) {
                out.append(SchemaRowsDiagnostic(code: d.code.rawValue, table: table.name, row: key, column: d.column, message: d.message))
            }
            for column in table.columns where column.array {
                if let items = row[column.name]?.arrayValue, Set(items.map(\.jsonText)).count != items.count {
                    out.append(SchemaRowsDiagnostic(code: "duplicate-member", table: table.name, row: key, column: column.name, message: "`\(column.name)` lists a member twice"))
                }
            }
            if seen.contains(key) { out.append(SchemaRowsDiagnostic(code: "duplicate-key", table: table.name, row: key, message: "Two rows of \(table.name) have the key \(key)")) }
            seen.insert(key)
        }
    }
    func present(_ tableName: String, _ values: [JSONValue?]) -> Bool {
        guard let target = tables.first(where: { $0.name == tableName }) else { return false }
        return (rows[tableName] ?? []).contains { r in
            target.primaryKey.enumerated().allSatisfy { i, c in sameJSON(r[c], values[i]) }
        }
    }
    for table in tables {
        for row in rows[table.name] ?? [] {
            guard let key = schemaRowKey(table, row) else { continue }
            for column in table.columns {
                guard let ref = column.references, let items = row[column.name]?.arrayValue else { continue }
                for item in items {
                    let values: [JSONValue?] = ref.columns.count == 1 ? [item] : ref.columns.map { c in
                        if case .object(let o) = item { return o[c.name] }
                        return nil
                    }
                    if !present(ref.table, values) {
                        out.append(SchemaRowsDiagnostic(code: "dangling-reference", table: table.name, row: key, column: column.name, message: "`\(column.name)` names \(item.jsonText), which is no row of \(ref.table)"))
                    }
                }
            }
            for fk in table.foreignKeys {
                let values = fk.columns.map { row[$0] ?? .null }
                if values.allSatisfy(\.isNull) { continue }
                if !present(fk.table, values) {
                    out.append(SchemaRowsDiagnostic(code: "dangling-reference", table: table.name, row: key, column: fk.columns.joined(separator: ","), message: "\(JSONValue.array(values).jsonText) names no row of \(fk.table)"))
                }
            }
        }
    }
    return out
}

// MARK: - Applying row operations: cranberries' `apply`

private let systemColumns = ["created", "modified"]

/// Rows after row operations, by spec 10 §4.1's rules. Throws on an operation that doesn't apply.
public func applyRowEdits(_ schema: SchemaCheckResult, _ rows: SchemaRowsByTable, _ edits: [RowEdit]) throws -> SchemaRowsByTable {
    if !schema.diagnostics.isEmpty { throw RowEditError(message: "The schema has errors; check it first") }
    let tables = try schemaLayout(schema, store: .files)
    func tableNamed(_ name: String) throws -> SchemaTable {
        if let table = tables.first(where: { $0.ends == nil && $0.stores == name }) ?? tables.first(where: { $0.ends != nil && $0.name == name }) { return table }
        throw RowEditError(message: "No table `\(name)`")
    }
    var out = rows
    for edit in edits {
        let table = try tableNamed(edit.table)
        var list = out[table.name] ?? []
        let index = list.firstIndex { schemaRowKey(table, $0) == edit.row }
        func fail(_ message: String) -> RowEditError { RowEditError(message: "\(edit.json.jsonText): \(message)") }
        func stamp(_ row: inout SchemaRow, _ at: String?, created: Bool) {
            guard let at else { return }
            if created { row["created"] = .string(at) }
            row["modified"] = .string(at)
        }
        /// The row a member edit changes, after the checks every one of them makes.
        func editable(_ field: String) throws -> (Int, SchemaRow) {
            guard let index else { throw fail("the row is absent") }
            if table.primaryKey.contains(field) { throw fail("a key field is never set") }
            if systemColumns.contains(field) { throw fail("\(field) is set only by an operation's time") }
            return (index, list[index])
        }
        func membersOf(_ row: SchemaRow, _ field: String) throws -> [JSONValue] {
            guard let current = row[field], !current.isNull else { return [] }
            guard let members = current.arrayValue else { throw fail("\(field) isn't many-valued") }
            return members
        }
        switch edit {
        case .create(_, let key, let values, let at):
            if index != nil { throw fail("the row already exists") }
            if schemaRowKey(table, values) != key { throw fail("its values don't have the row's key") }
            if at != nil && systemColumns.contains(where: { values[$0] != nil }) { throw fail("a timed row's times come from its operation") }
            var row = values
            stamp(&row, at, created: true)
            list.append(row)
        case .delete:
            guard let index else { throw fail("the row is absent") }
            list.remove(at: index)
        case .set(_, _, let field, let before, let value, let at):
            let (i, found) = try editable(field)
            var row = found
            if !sameJSON(row[field], before) { throw fail("\(field) doesn't have the value seen") }
            if sameJSON(before, value) { throw fail("it changes nothing") }
            row[field] = value.isNull ? nil : value
            stamp(&row, at, created: false)
            list[i] = row
        case .connect(_, _, let field, let member, let at):
            let (i, found) = try editable(field)
            var row = found
            let members = try membersOf(row, field)
            if members.contains(where: { sameJSON($0, member) }) { throw fail("the member is already present") }
            row[field] = .array(members + [member])
            stamp(&row, at, created: false)
            list[i] = row
        case .disconnect(_, _, let field, let member, let at):
            let (i, found) = try editable(field)
            var row = found
            var members = try membersOf(row, field)
            guard let at0 = members.firstIndex(where: { sameJSON($0, member) }) else { throw fail("the member is absent") }
            members.remove(at: at0)
            row[field] = members.isEmpty ? nil : .array(members)
            stamp(&row, at, created: false)
            list[i] = row
        case .move(_, _, let field, let member, let anchor, let at):
            let (i, found) = try editable(field)
            var row = found
            let members = try membersOf(row, field)
            guard let from = members.firstIndex(where: { sameJSON($0, member) }) else { throw fail("the member is absent") }
            var rest = members
            rest.remove(at: from)
            var after = -1
            if let anchor {
                guard let found = rest.firstIndex(where: { sameJSON($0, anchor) }) else { throw fail("the anchor member is absent") }
                after = found
            }
            rest.insert(members[from], at: after + 1)
            if rest.indices.allSatisfy({ sameJSON(rest[$0], members[$0]) }) { throw fail("it changes nothing") }
            row[field] = .array(rest)
            stamp(&row, at, created: false)
            list[i] = row
        }
        out[table.name] = list
    }
    return out
}
