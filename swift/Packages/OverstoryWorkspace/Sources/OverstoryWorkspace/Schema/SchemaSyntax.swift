import Foundation

// A collection's `schema.beetle` (spec 2.3), read for its data tables: `table`,
// `connection table`, `enum` and `re`, as the syntax tree the table checker
// (SchemaCheck.swift) reads; a connection field (`owner: Person <-> ownedLists[]`)
// becomes a connection with two ends. Views, rules, mutations, imports and state tables
// (`my table`, `session table`) are skipped, and so is a field's default: Story reads
// only the data layer here, and a seed row may leave a defaulted field out. The
// TypeScript reference is `tablesFileOf` in packages/beetle/src/schema.ts with the
// checker in packages/beetle/src/tables.
//
// A header line ending in `:` groups the lines indented below it. Inside
// parentheses, lists and records, newlines are ignored. `@` attributes are
// storage; of `~` attributes only `~views` is left, which Story no longer draws.
//
// Columns count Unicode scalars; TypeScript counts UTF-16 code units, so the
// two differ only after a character outside the Basic Multilingual Plane on
// the same line.

/// The file name of a collection's schema.
public let collectionSchemaFileName = "schema.beetle"

public struct SchemaPosition: Sendable, Equatable {
    public var line: Int
    public var column: Int
    public init(line: Int, column: Int) {
        self.line = line
        self.column = column
    }
}

/// `[]` is many, `?` is at most one, nothing is exactly one.
public enum SchemaArity: String, Sendable, Equatable {
    case one, optional, many
}

/// `@` marks storage and `~` presentation; the model layer is keywords.
public enum SchemaSigil: String, Sendable, Equatable {
    case storage = "@"
    case presentation = "~"
}

public struct SchemaAttribute: Sendable, Equatable {
    public var sigil: SchemaSigil
    public var name: String
    public var args: [SchemaExpr]
    public var at: SchemaPosition
}

public indirect enum SchemaExpr: Sendable, Equatable {
    case string(String, at: SchemaPosition)
    case number(Double, at: SchemaPosition)
    case ident(String, attrs: [SchemaAttribute], at: SchemaPosition)
    case list([SchemaExpr], at: SchemaPosition)
    case object([SchemaObjectEntry], at: SchemaPosition)

    public var at: SchemaPosition {
        switch self {
        case .string(_, let at), .number(_, let at), .ident(_, _, let at), .list(_, let at), .object(_, let at): at
        }
    }
}

public struct SchemaObjectEntry: Sendable, Equatable {
    public var key: String
    public var value: SchemaExpr
    public var at: SchemaPosition
}

/// A name and where it was written.
public struct SchemaName: Sendable, Equatable {
    public var name: String
    public var at: SchemaPosition
}

/// `name: [modifiers] Type [= default]`: a field of the table. Modifiers are `ordered`, `unique` and `path`.
public struct SchemaFieldDecl: Sendable, Equatable {
    public var name: String
    public var modifiers: [SchemaName]
    public var type: String
    public var arity: SchemaArity
    public var attrs: [SchemaAttribute]
    public var at: SchemaPosition
}

/// An end of a connection, declaring the field that table gains: one side of a connection field,
/// or in a connection table a field such as `list: List <-> ordered items[]` (with `as` its name there).
public struct SchemaEndDecl: Sendable, Equatable {
    public var model: String
    public var field: String
    public var arity: SchemaArity
    /// Where `ordered` was written before the end, if it was.
    public var ordered: SchemaPosition?
    /// `as name`: the field this end gets in a connection model.
    public var `as`: SchemaName?
    public var attrs: [SchemaAttribute]
    public var at: SchemaPosition
}

/// An attribute on a line of its own in a block: `@table(...)`, `@index(...)`, `~views(...)`.
public struct SchemaModelAttribute: Sendable, Equatable {
    public var sigil: SchemaSigil
    public var name: String
    public var args: [SchemaExpr]
    public var at: SchemaPosition
}

public struct SchemaRowDecl: Sendable, Equatable {
    public var name: String
    public var values: [SchemaObjectEntry]
    public var attrs: [SchemaAttribute]
    public var at: SchemaPosition
}

/// An enum's values (`fixed`) or a table's `seed:` rows.
public struct SchemaRowsBlock: Sendable, Equatable {
    public enum Mode: String, Sendable { case fixed, seed }
    public var mode: Mode
    public var rows: [SchemaRowDecl]
    public var at: SchemaPosition
}

/// In a `re` block: a field or enum value named again, with attributes.
public struct SchemaMention: Sendable, Equatable {
    public var name: String
    public var attrs: [SchemaAttribute]
    public var at: SchemaPosition
}

public enum SchemaMember: Sendable, Equatable {
    case field(SchemaFieldDecl)
    case end(SchemaEndDecl)
    case modelAttribute(SchemaModelAttribute)
    case rows(SchemaRowsBlock)
    case mention(SchemaMention)

    public var at: SchemaPosition {
        switch self {
        case .field(let f): f.at
        case .end(let e): e.at
        case .modelAttribute(let a): a.at
        case .rows(let r): r.at
        case .mention(let m): m.at
        }
    }
}

/// `[main] table Name [(key, ...)]:` or `enum Name:`.
public struct SchemaModelDecl: Sendable, Equatable {
    public enum Form: String, Sendable { case model, `enum` }
    public var form: Form
    public var name: String
    /// Where `main` was written, if it was.
    public var main: SchemaPosition?
    /// The header key, `(list, id)`, if there is one.
    public var key: SchemaHeaderKey?
    public var members: [SchemaMember]
    public var at: SchemaPosition
}

/// A table's header key: `table Tag (list, id):`.
public struct SchemaHeaderKey: Sendable, Equatable {
    public var fields: [SchemaName]
    public var at: SchemaPosition
}

/// `re Name:`: attributes for a table or enum declared elsewhere.
public struct SchemaReDecl: Sendable, Equatable {
    public var name: String
    public var members: [SchemaMember]
    public var at: SchemaPosition
}

/// A connection declared by a field (`owner: Person <-> ownedLists[]`), as its two ends. (`braces` is no longer written.)
public struct SchemaConnectionDecl: Sendable, Equatable {
    public enum Spelling: String, Sendable { case braces, arrow }
    public var spelling: Spelling
    public var members: [SchemaMember]
    public var at: SchemaPosition
}

public enum SchemaDeclaration: Sendable, Equatable {
    case model(SchemaModelDecl)
    case re(SchemaReDecl)
    case connection(SchemaConnectionDecl)
}

public struct SchemaFile: Sendable, Equatable {
    public var declarations: [SchemaDeclaration]
}

public struct SchemaDiagnostic: Sendable, Equatable {
    public var code: String
    public var message: String
    public var line: Int
    public var column: Int
}

/// Bounds on what a schema may ask of a parser, so an untrusted schema can't exhaust a host.
public enum SchemaLimits {
    public static let sourceBytes = 1_048_576
    public static let tokens = 65_536
    public static let depth = 32
}


struct SchemaSyntaxError: Error {
    var message: String
    var at: SchemaPosition
    var code = "syntax"
}

private enum TokenKind { case ident, string, number, punct, other, newline, eof }

private struct Token {
    var kind: TokenKind
    var text: String
    var stringValue: String?
    var numberValue: Double?
    var start: Int
    var end: Int
    var line: Int
    var column: Int
}

private let punctuation = ["<->", "{", "}", "(", ")", "[", "]", ",", ".", ":", "?", "@", "~", "="].map { Array($0.unicodeScalars) }

private func isLetter(_ c: Unicode.Scalar) -> Bool {
    (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c == "_"
}
private func isDigit(_ c: Unicode.Scalar) -> Bool { c >= "0" && c <= "9" }

/// Top-level declarations that hold no data tables.
private let skippedDeclaration = try! NSRegularExpression(pattern: #"^(?:view|rule|mutation|import|from|my\s+table|session\s+table)\b"#)

/// The source with every declaration that holds no data tables blanked, line for line,
/// so views' elements and expressions never reach the lexer.
private func dataLayer(_ source: String) -> String {
    var skipping = false
    return source.components(separatedBy: "\n").map { line -> String in
        if let first = line.unicodeScalars.first, first != " ", first != "\t", first != "\r",
           !line.hasPrefix("//"), !["}", ")", "]"].contains(first) {
            skipping = skippedDeclaration.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) != nil
        }
        return skipping ? "" : line
    }.joined(separator: "\n")
}

private func lex(_ source: String) throws -> (tokens: [Token], scalars: [Unicode.Scalar]) {
    if source.utf8.count > SchemaLimits.sourceBytes {
        throw SchemaSyntaxError(message: "A file is at most \(SchemaLimits.sourceBytes) bytes", at: SchemaPosition(line: 1, column: 1), code: "limit")
    }
    let s = Array(source.unicodeScalars)
    var tokens: [Token] = []
    var i = 0
    var line = 1
    var lineStart = 0
    func text(_ a: Int, _ b: Int) -> String { String(String.UnicodeScalarView(s[a..<b])) }
    func push(_ kind: TokenKind, _ start: Int, _ end: Int, string: String? = nil, number: Double? = nil) {
        tokens.append(Token(kind: kind, text: text(start, end), stringValue: string, numberValue: number, start: start, end: end, line: line, column: start - lineStart + 1))
    }
    func startsWith(_ p: [Unicode.Scalar], _ at: Int) -> Bool {
        at + p.count <= s.count && Array(s[at..<(at + p.count)]) == p
    }
    while i < s.count {
        let c = s[i]
        if c == "\n" {
            push(.newline, i, i + 1)
            i += 1
            line += 1
            lineStart = i
        } else if c == " " || c == "\t" || c == "\r" {
            i += 1
        } else if c == "/" && i + 1 < s.count && s[i + 1] == "/" {
            while i < s.count && s[i] != "\n" { i += 1 }
        } else if isLetter(c) {
            let start = i
            while i < s.count && (isLetter(s[i]) || isDigit(s[i])) { i += 1 }
            push(.ident, start, i)
        } else if isDigit(c) || (c == "-" && i + 1 < s.count && isDigit(s[i + 1])) {
            let start = i
            i += 1
            while i < s.count && (isDigit(s[i]) || s[i] == ".") { i += 1 }
            let literal = text(start, i)
            guard literal.range(of: #"^-?[0-9]+(\.[0-9]+)?$"#, options: .regularExpression) != nil, let value = Double(literal) else {
                throw SchemaSyntaxError(message: "Malformed number \(jsonString(literal))", at: SchemaPosition(line: line, column: start - lineStart + 1))
            }
            push(.number, start, i, number: value)
        } else if c == "\"" {
            let start = i
            i += 1
            var value = ""
            while i < s.count && s[i] != "\"" {
                if s[i] == "\n" { break }
                if s[i] == "\\" {
                    if i + 1 < s.count {
                        let next = s[i + 1]
                        value.unicodeScalars.append(next == "n" ? "\n" : next == "t" ? "\t" : next)
                    }
                    i += 2
                } else {
                    value.unicodeScalars.append(s[i])
                    i += 1
                }
            }
            if i >= s.count || s[i] != "\"" {
                throw SchemaSyntaxError(message: "Unterminated string", at: SchemaPosition(line: line, column: start - lineStart + 1))
            }
            i += 1
            push(.string, start, i, string: value)
        } else {
            // Anything else is only allowed in a field's default, which is skipped.
            guard let p = punctuation.first(where: { startsWith($0, i) }) else {
                push(.other, i, i + 1)
                i += 1
                continue
            }
            push(.punct, i, i + p.count)
            i += p.count
        }
    }
    tokens.append(Token(kind: .eof, text: "", start: i, end: i, line: line, column: i - lineStart + 1))
    if tokens.count > SchemaLimits.tokens {
        throw SchemaSyntaxError(message: "A file has at most \(SchemaLimits.tokens) tokens", at: SchemaPosition(line: 1, column: 1), code: "limit")
    }
    return (tokens, s)
}


/// Keywords that may come between a field's name and its type.
private let modifierKeywords = ["ordered", "unique", "path"]

private func describe(_ token: Token) -> String {
    switch token.kind {
    case .eof: "end of file"
    case .newline: "end of line"
    default: jsonString(token.text)
    }
}

private struct Parser {
    let tokens: [Token]
    var pos = 0
    var depth = 0
    /// Fields written with a default, which a seed row may leave out.
    var defaulted = Set<String>()
    /// `~` attributes other than `~views`, which Beetle doesn't have.
    var presentation: [SchemaDiagnostic] = []
    /// Inside an attribute's arguments, where `~` marks a view line's presentation (`~bullet`)
    /// and is not reported.
    var argumentDepth = 0
    /// Connections declared by the fields of the declaration being read, which follow it in the file.
    var pendingConnections: [SchemaConnectionDecl] = []

    var token: Token { tokens[pos] }
    func peek(_ offset: Int = 1) -> Token { tokens[min(pos + offset, tokens.count - 1)] }
    func at(_ token: Token) -> SchemaPosition { SchemaPosition(line: token.line, column: token.column) }
    var here: SchemaPosition { at(token) }
    func `is`(_ text: String, _ t: Token? = nil) -> Bool {
        let t = t ?? token
        return (t.kind == .punct || t.kind == .ident) && t.text == text
    }
    func fail(_ expected: String) -> SchemaSyntaxError {
        SchemaSyntaxError(message: "Expected \(expected), found \(describe(token))", at: here)
    }
    @discardableResult mutating func next() -> Token {
        let t = token
        if t.kind != .eof { pos += 1 }
        return t
    }
    @discardableResult mutating func expect(_ text: String) throws -> Token {
        if !`is`(text) { throw fail(jsonString(text)) }
        return next()
    }
    mutating func ident(_ what: String) throws -> Token {
        if token.kind != .ident { throw fail(what) }
        return next()
    }
    var atEnd: Bool { token.kind == .eof }
    mutating func skipNewlines() { while token.kind == .newline { next() } }
    /// Skips any run of newlines and commas; true if there was one.
    mutating func separators() -> Bool {
        var any = false
        while token.kind == .newline || `is`(",") {
            next()
            any = true
        }
        return any
    }
    /// The end of a line: a newline (and any blank lines after it) or the end of the file.
    mutating func endOfLine() throws {
        if !atEnd && token.kind != .newline { throw fail("a new line") }
        skipNewlines()
    }

    mutating func file() throws -> SchemaFile {
        var declarations: [SchemaDeclaration] = []
        skipNewlines()
        while !atEnd {
            if token.column != 1 { throw fail("a declaration at the start of a line") }
            declarations.append(try declaration())
            declarations.append(contentsOf: pendingConnections.map { .connection($0) })
            pendingConnections = []
            // A block's last member already ended its line; a connection has not.
            if pos == 0 || tokens[pos - 1].kind != .newline { try endOfLine() }
        }
        return SchemaFile(declarations: declarations)
    }

    mutating func declaration() throws -> SchemaDeclaration {
        let start = here
        if `is`("main") && `is`("table", peek()) && peek(2).kind == .ident {
            next()
            return .model(try table(main: start))
        }
        if `is`("connection") && `is`("table", peek()) && peek(2).kind == .ident {
            next()
            return .model(try table(main: nil, connectionTable: true, column: start.column))
        }
        if `is`("table") && peek().kind == .ident { return .model(try table(main: nil)) }
        if `is`("enum") && peek().kind == .ident {
            next()
            let name = next()
            let members = try body(.enum, column: start.column, owner: Owner(name: name.text, connectionTable: false))
            return .model(SchemaModelDecl(form: .enum, name: name.text, main: nil, key: nil, members: members, at: at(name)))
        }
        if `is`("re") && peek().kind == .ident {
            next()
            let name = next()
            let members = try body(.re, column: start.column)
            return .re(SchemaReDecl(name: name.text, members: members, at: at(name)))
        }
        if startsEnd() { throw fail("a connection as a field of one of its tables: `owner: Person <-> ownedLists[]`") }
        throw fail("`table`, `enum` or `re`")
    }

    /// `table Name [(key, ...)]:` and its body, after any `main`.
    mutating func table(main: SchemaPosition?, connectionTable: Bool = false, column start: Int? = nil) throws -> SchemaModelDecl {
        let column = start ?? token.column
        try expect("table")
        let name = next()
        var key: SchemaHeaderKey?
        if `is`("(") {
            next()
            var fields: [SchemaName] = []
            _ = separators()
            while !`is`(")") {
                let field = try ident("a key field")
                fields.append(SchemaName(name: field.text, at: at(field)))
                if !`is`(")") && !separators() { throw fail("`,` or `)`") }
            }
            next()
            if let first = fields.first { key = SchemaHeaderKey(fields: fields, at: first.at) }
        }
        let members = try body(.table, column: main?.column ?? column, owner: Owner(name: name.text, connectionTable: connectionTable))
        return SchemaModelDecl(form: .model, name: name.text, main: main, key: key, members: members, at: at(name))
    }

    /// `[ordered] Table.field` starts here.
    func startsEnd() -> Bool {
        if `is`("ordered") && peek().kind == .ident && `is`(".", peek(2)) { return true }
        return token.kind == .ident && `is`(".", peek())
    }

    enum BlockContext { case table, `enum`, re }

    /// Where a block's connection fields go: a connection table's become its ends, any other's its connections.
    struct Owner {
        var name: String
        var connectionTable: Bool
    }

    /// `:` ending a header line, then the lines indented further than `column`.
    mutating func body(_ context: BlockContext, column: Int, owner: Owner? = nil) throws -> [SchemaMember] {
        try expect(":")
        try endOfLine()
        var members: [SchemaMember] = []
        var values: [SchemaRowDecl] = []
        var valuesAt: SchemaPosition?
        while !atEnd && token.column > column {
            if context == .enum && startsValue() {
                if valuesAt == nil { valuesAt = here }
                values.append(try row())
                try endOfLine()
            } else {
                members.append(contentsOf: try member(context, owner: owner))
            }
        }
        if context == .enum { members.append(.rows(SchemaRowsBlock(mode: .fixed, rows: values, at: valuesAt ?? SchemaPosition(line: 1, column: 1)))) }
        return members
    }

    /// In an enum, a value rather than a field: a name not followed by a type.
    func startsValue() -> Bool {
        if token.kind == .string { return true }
        return token.kind == .ident && peek().kind != .ident && !`is`(":", peek())
    }

    /// One member line (a `seed:` block takes the lines below it too), through its end of line.
    mutating func member(_ context: BlockContext, owner: Owner?) throws -> [SchemaMember] {
        let start = here
        if `is`("@") || `is`("~") {
            let attr = try attribute()
            try endOfLine()
            return [.modelAttribute(SchemaModelAttribute(sigil: attr.sigil, name: attr.name, args: attr.args, at: attr.at))]
        }
        if context == .re {
            let name: String
            if token.kind == .ident { name = next().text }
            else if token.kind == .string { name = next().stringValue ?? "" }
            else { throw fail("a field or value to annotate, or an attribute") }
            let attributes = try attrs()
            if attributes.isEmpty { throw fail("an attribute for `\(name)` (`re` blocks only annotate)") }
            try endOfLine()
            return [.mention(SchemaMention(name: name, attrs: attributes, at: start))]
        }
        if context == .table && `is`("seed") && `is`(":", peek()) && (peek(2).kind == .newline || peek(2).kind == .eof) {
            let column = token.column
            next()
            next()
            try endOfLine()
            var rows: [SchemaRowDecl] = []
            while !atEnd && token.column > column {
                rows.append(try row())
                try endOfLine()
            }
            return [.rows(SchemaRowsBlock(mode: .seed, rows: rows, at: start))]
        }
        if startsEnd() { throw fail("a connection as a field: `list: List <-> ordered items[]`") }
        if token.kind == .ident {
            let name = next().text
            if !`is`(":") { throw SchemaSyntaxError(message: "Write a field with a colon: \(name): Type", at: here) }
            next()
            var modifiers: [SchemaName] = []
            while token.kind == .ident && modifierKeywords.contains(token.text) && peek().kind == .ident {
                modifiers.append(SchemaName(name: token.text, at: start))
                next()
            }
            let type = try ident("a type for field `\(name)`").text
            let arity = try arityChecked()
            var link: (inverse: String, arity: SchemaArity, ordered: SchemaPosition?, array: Bool, at: SchemaPosition)?
            if `is`("<->") {
                next()
                let linkAt = here
                var ordered: SchemaPosition?
                if `is`("ordered") && peek().kind == .ident {
                    ordered = here
                    next()
                }
                let inverse = try ident("the field \(type) gains").text
                let inverseArity = try arityChecked()
                var array = false
                if `is`("as") {
                    next()
                    if !`is`("array") { throw fail("`array`: only `as array` follows a connection's other end") }
                    next()
                    array = true
                }
                link = (inverse, inverseArity, ordered, array, linkAt)
            }
            if `is`("=") {
                skipDefault()
                defaulted.insert(name)
            }
            let attributes = try attrs()
            try endOfLine()
            if let link {
                guard let owner else { throw SchemaSyntaxError(message: "A connection is a field of a table or enum", at: start) }
                var far = SchemaEndDecl(model: type, field: link.inverse, arity: link.arity, ordered: link.ordered, as: nil, attrs: [], at: link.at)
                if owner.connectionTable {
                    // `list: List <-> ordered items[]` in a connection table is its end `ordered List.items[] as list`.
                    if name != type.lowercased() { far.as = SchemaName(name: name, at: start) }
                    far.attrs = attributes
                    var result: [SchemaMember] = [.end(far)]
                    if link.array {
                        result.append(.modelAttribute(SchemaModelAttribute(sigil: .storage, name: "fold", args: [.ident(type, attrs: [], at: link.at)], at: link.at)))
                    }
                    return result
                }
                let near = SchemaEndDecl(
                    model: owner.name, field: name, arity: arity,
                    ordered: modifiers.contains { $0.name == "ordered" } ? start : nil, as: nil,
                    attrs: attributes + (link.array ? [SchemaAttribute(sigil: .storage, name: "fold", args: [], at: link.at)] : []),
                    at: start
                )
                pendingConnections.append(SchemaConnectionDecl(spelling: .arrow, members: [.end(near), .end(far)], at: start))
                // The field also stands where it is written, so the table's fields keep their written order.
                return [.field(SchemaFieldDecl(name: name, modifiers: [], type: type, arity: arity, attrs: [], at: start))]
            }
            return [.field(SchemaFieldDecl(name: name, modifiers: modifiers, type: type, arity: arity, attrs: attributes, at: start))]
        }
        throw fail("a field, a connection end `Table.field`, or an attribute")
    }

    /// `= value`: up to the field's first attribute or the end of the line, outside brackets.
    mutating func skipDefault() {
        next()
        var nesting = 0
        while !atEnd {
            if nesting == 0 && token.kind == .newline { return }
            if nesting == 0 && (`is`("@") || `is`("~")) && peek().kind == .ident { return }
            if token.kind == .punct {
                if ["(", "[", "{"].contains(token.text) { nesting += 1 }
                if [")", "]", "}"].contains(token.text) { nesting = max(0, nesting - 1) }
            }
            next()
        }
    }

    mutating func end() throws -> SchemaEndDecl {
        let start = here
        var ordered: SchemaPosition?
        if `is`("ordered") && peek().kind == .ident && `is`(".", peek(2)) {
            ordered = here
            next()
        }
        let model = try ident("a table name").text
        try expect(".")
        let field = try ident("a field name").text
        let arity = try arityChecked()
        var name: SchemaName?
        if `is`("as") && peek().kind == .ident {
            next()
            name = SchemaName(name: next().text, at: start)
        }
        let attributes = try attrs()
        return SchemaEndDecl(model: model, field: field, arity: arity, ordered: ordered, as: name, attrs: attributes, at: start)
    }

    mutating func arityChecked() throws -> SchemaArity {
        if `is`("?") {
            next()
            return .optional
        }
        if `is`("[") {
            next()
            try expect("]")
            return .many
        }
        return .one
    }

    mutating func attribute() throws -> SchemaAttribute {
        let start = here
        let sigil: SchemaSigil = next().text == "@" ? .storage : .presentation
        let name = try ident("an attribute name").text
        let arguments: [SchemaExpr] = try (`is`("(") ? args() : [])
        if sigil == .presentation && name != "views" && argumentDepth == 0 {
            presentation.append(SchemaDiagnostic(
                code: "presentation-attribute",
                message: name == "color"
                    ? "A color is data: give the table or enum a `color Text` field, and enum values a record with their color"
                    : "`~\(name)` is not Beetle; presentation belongs in views",
                line: start.line, column: start.column))
        }
        return SchemaAttribute(sigil: sigil, name: name, args: arguments, at: start)
    }

    mutating func attrs() throws -> [SchemaAttribute] {
        var result: [SchemaAttribute] = []
        while (`is`("@") || `is`("~")) && peek().kind == .ident { result.append(try attribute()) }
        return result
    }

    mutating func row() throws -> SchemaRowDecl {
        let start = here
        let name: String
        if token.kind == .ident { name = next().text }
        else if token.kind == .string { name = next().stringValue ?? "" }
        else { throw fail("a value name") }
        var values: [SchemaObjectEntry] = []
        if `is`("{") {
            next()
            values = try entries("}")
        }
        let attributes = try attrs()
        return SchemaRowDecl(name: name, values: values, attrs: attributes, at: start)
    }

    mutating func args() throws -> [SchemaExpr] {
        try expect("(")
        argumentDepth += 1
        defer { argumentDepth -= 1 }
        return try items(")")
    }

    /// Expressions up to `close`, separated by commas or newlines.
    mutating func items(_ close: String) throws -> [SchemaExpr] {
        var result: [SchemaExpr] = []
        _ = separators()
        while !`is`(close) {
            let value = try expr()
            result.append(value)
            if !`is`(close) && !separators() { throw fail("`,` or `\(close)`") }
        }
        next()
        return result
    }

    /// `key: value` entries up to `close`, separated by commas or newlines.
    mutating func entries(_ close: String) throws -> [SchemaObjectEntry] {
        var result: [SchemaObjectEntry] = []
        _ = separators()
        while !`is`(close) {
            let start = here
            let key: String
            if token.kind == .ident { key = next().text }
            else if token.kind == .string { key = next().stringValue ?? "" }
            else { throw fail("a key") }
            try expect(":")
            skipNewlines()
            let value = try expr()
            result.append(SchemaObjectEntry(key: key, value: value, at: start))
            if !`is`(close) && !separators() { throw fail("`,` or `\(close)`") }
        }
        next()
        return result
    }

    mutating func expr() throws -> SchemaExpr {
        depth += 1
        defer { depth -= 1 }
        if depth > SchemaLimits.depth {
            throw SchemaSyntaxError(message: "Values nest at most \(SchemaLimits.depth) deep", at: here, code: "limit")
        }
        let t = token
        let start = here
        if t.kind == .string {
            next()
            return .string(t.stringValue ?? "", at: start)
        }
        if t.kind == .number {
            next()
            return .number(t.numberValue ?? 0, at: start)
        }
        if t.kind == .ident {
            next()
            // A path through connections: `ties.group`.
            var name = t.text
            while `is`("."), peek().kind == .ident {
                next()
                name += "." + next().text
            }
            let attributes = try attrs()
            return .ident(name, attrs: attributes, at: start)
        }
        if `is`("[") {
            next()
            let list = try items("]")
            return .list(list, at: start)
        }
        if `is`("{") {
            next()
            let object = try entries("}")
            return .object(object, at: start)
        }
        throw fail("a value")
    }
}

public struct SchemaParseResult: Sendable {
    public var file: SchemaFile?
    public var diagnostics: [SchemaDiagnostic]
    /// Fields written with a default, which a seed row may leave out.
    public var defaulted: Set<String>
}

/// Reads a schema.beetle's data tables. A syntax error stops at the first one.
public func parseSchema(_ source: String) -> SchemaParseResult {
    do {
        if source.utf8.count > SchemaLimits.sourceBytes {
            throw SchemaSyntaxError(message: "A file is at most \(SchemaLimits.sourceBytes) bytes", at: SchemaPosition(line: 1, column: 1), code: "limit")
        }
        let tokens = try lex(dataLayer(source)).tokens
        var parser = Parser(tokens: tokens)
        let file = try parser.file()
        return SchemaParseResult(file: file, diagnostics: parser.presentation, defaulted: parser.defaulted)
    } catch let error as SchemaSyntaxError {
        return SchemaParseResult(file: nil, diagnostics: [SchemaDiagnostic(code: error.code, message: error.message, line: error.at.line, column: error.at.column)], defaulted: [])
    } catch {
        return SchemaParseResult(file: nil, diagnostics: [SchemaDiagnostic(code: "syntax", message: "\(error)", line: 1, column: 1)], defaulted: [])
    }
}

/// Checks a collection's `schema.beetle` for its data tables. A seed row may
/// leave out a field the table gives a default.
public func compileCollectionSchema(_ source: String) -> SchemaCheckResult {
    let parsed = parseSchema(source)
    guard let file = parsed.file else { return SchemaCheckResult(diagnostics: parsed.diagnostics, models: [], connections: []) }
    var result = checkSchema(file)
    // A connection field stands as both a field and an end, so one mistake can be reported twice.
    let endLines = Set(result.diagnostics.filter { $0.code == "duplicate-end" }.map(\.line))
    var seen = Set<String>()
    result.diagnostics = result.diagnostics.filter { diagnostic in
        if diagnostic.code == "duplicate-field" && endLines.contains(diagnostic.line) { return false }
        return seen.insert("\(diagnostic.line):\(diagnostic.code)").inserted
    }
    result.diagnostics.removeAll { diagnostic in
        diagnostic.code == "missing-value" && parsed.defaulted.contains { diagnostic.message.hasSuffix("needs a value for `\($0)`") }
    }
    if !parsed.diagnostics.isEmpty {
        result.diagnostics = (parsed.diagnostics + result.diagnostics).enumerated().sorted {
            ($0.element.line, $0.element.column, $0.offset) < ($1.element.line, $1.element.column, $1.offset)
        }.map(\.element)
    }
    return result
}
