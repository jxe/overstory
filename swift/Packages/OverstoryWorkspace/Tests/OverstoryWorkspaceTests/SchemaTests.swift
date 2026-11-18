import Foundation
import Testing
@testable import OverstoryWorkspace

/// The repository root, from this file (swift/Packages/OverstoryWorkspace/Tests/OverstoryWorkspaceTests).
private let repositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appending(path: "../../../../..")
    .standardizedFileURL

private var conformance: URL {
    ProcessInfo.processInfo.environment["STORY_PROTOCOL_FIXTURES"].map { URL(fileURLWithPath: $0) }
        ?? repositoryRoot.appending(path: "docs/overstory-spec/conformance")
}

private func beetleFiles(_ directory: String) throws -> [(name: String, source: String)] {
    let url = repositoryRoot.appending(path: directory)
    return try FileManager.default.contentsOfDirectory(atPath: url.path)
        .filter { $0.hasSuffix(".beetle") }
        .sorted()
        .map { ($0, try String(contentsOf: url.appending(path: $0), encoding: .utf8)) }
}

/// A schema.beetle's tables, read and checked as Story reads them. The TypeScript
/// reference (packages/beetle) runs the same fixtures in tests/unit/tables.test.ts.
@Suite("Schema tables")
struct SchemaTests {
    @Test("The table fixtures and the schemas Story ships check clean")
    func examplesCheckClean() throws {
        let files = try beetleFiles("tests/fixtures/tables")
        #expect(files.count >= 5)
        for file in files {
            #expect(compileCollectionSchema(file.source).diagnostics == [], "\(file.name)")
        }
        for path in ["packages/beetle/examples/supplies/data/schema.beetle", "tests/fixtures/games.beetle",
                     "tools/directory-seed/people/schema.beetle", "tools/directory-seed/trees/schema.beetle"] {
            let source = try String(contentsOf: repositoryRoot.appending(path: path), encoding: .utf8)
            #expect(compileCollectionSchema(source).diagnostics == [], "\(path)")
        }
    }

    @Test("Broken table fixtures report exactly the codes they expect")
    func brokenExamples() throws {
        let files = try beetleFiles("tests/fixtures/tables/invalid")
        #expect(!files.isEmpty)
        let regex = try NSRegularExpression(pattern: "^\\s*// expect: ([a-z-]+)$", options: [.anchorsMatchLines])
        for file in files {
            let range = NSRange(file.source.startIndex..., in: file.source)
            let expected = regex.matches(in: file.source, range: range).map { String(file.source[Range($0.range(at: 1), in: file.source)!]) }.sorted()
            #expect(!expected.isEmpty, "\(file.name)")
            let actual = compileCollectionSchema(file.source).diagnostics.map(\.code).sorted()
            #expect(actual == expected, "\(file.name)")
        }
    }

    @Test("A schema.beetle's views, rules, mutations, state tables and defaults are left out of its tables")
    func beetleSchemaSkipsTheRest() throws {
        let source = """
            // Lists.
            main table List:
              name:  Text
              first: Date = today
              owner: Person <-> lists[]
              seed:
                Inbox { name: "Inbox" }
              @index(name)

            my table Draft:
              text: Text

            view ByOwner():
              <Rows for={l in List} group={l.owner}>
                <Text>{l.name}</Text>
              </Rows>

            view Names() {
              lists: { name } for={l in List}
            }

            rule canEdit(l: List):
              l.owner == me

            mutation rename(l: List, name: Text):
              l.name = name

            re List:
              ~views([{ label: "All", line: [name] }])
            """
        // A seed row may leave out a defaulted field.
        let result = compileCollectionSchema(source)
        #expect(result.diagnostics == [])
        #expect(result.models.map(\.name).contains("List"))
        #expect(!result.models.map(\.name).contains("Draft"))
        #expect(result.models.first { $0.name == "List" }?.indexes == [["name"]])
    }

    @Test("Collection schemas lay out the columns and keys the shared vectors give")
    func collectionSchemaVectors() throws {
        let data = try Data(contentsOf: conformance.appending(path: "collection-schemas.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let schemas = try #require(fixture["schemas"] as? [[String: Any]])
        for schema in schemas {
            let name = schema["name"] as? String ?? ""
            let result = compileCollectionSchema(try #require(schema["source"] as? String))
            if let accept = schema["accept"] as? [String: Any] {
                #expect(result.diagnostics == [], "\(name)")
                let tables = try schemaLayout(result, store: .files)
                #expect(tables.count == 1, "\(name)")
                #expect(tables.first?.columns.map(\.name) == accept["columns"] as? [String], "\(name)")
                #expect(tables.first?.primaryKey == accept["primaryKey"] as? [String], "\(name)")
            } else if let reject = schema["reject"] as? [String: Any], let code = reject["code"] as? String {
                if code == "collection-tables" {
                    #expect(result.diagnostics == [], "\(name)")
                    #expect(try schemaLayout(result, store: .files).count != 1, "\(name)")
                    continue
                }
                let first = try #require(result.diagnostics.first, "\(name)")
                #expect(first.code == code, "\(name)")
                if let line = reject["line"] as? Int { #expect(first.line == line, "\(name)") }
                if let column = reject["column"] as? Int { #expect(first.column == column, "\(name)") }
            }
        }
    }

    @Test("Person columns take profile ids and contact: placeholders, as the shared vectors' values say")
    func personValueVectors() throws {
        let data = try Data(contentsOf: conformance.appending(path: "collection-schemas.json"))
        let fixture = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let schemas = try #require(fixture["schemas"] as? [[String: Any]])
        var checked = 0
        for schema in schemas {
            let result = compileCollectionSchema(try #require(schema["source"] as? String))
            guard schema["accept"] != nil, let table = try schemaLayout(result, store: .files).first else { continue }
            let people = table.columns.filter(\.profile)
            guard !people.isEmpty else { continue }
            for item in schema["values"] as? [[String: Any]] ?? [] {
                let value = try #require(item["value"] as? [String: Any])
                let paths = (item["diagnostics"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }
                for column in people {
                    guard let stored = value[column.name] else { continue }
                    let items: [Any] = column.array ? try #require(stored as? [Any]) : [stored]
                    for (index, element) in items.enumerated() {
                        let path = column.array ? "/\(column.name)/\(index)" : "/\(column.name)"
                        var one = column
                        one.array = false
                        let fits = (element as? String).map { schemaFitsColumn(.string($0), one) } ?? false
                        #expect(fits == !paths.contains(path), "\(path) of \(value)")
                        checked += 1
                    }
                }
            }
        }
        #expect(checked >= 8)
        #expect(schemaPersonPlaceholderKey(.string("contact:Bo_2")) == "Bo_2")
        #expect(schemaPersonPlaceholderKey(.string("tr_abc")) == nil)
    }

    @Test("Resolution: a connection table is keyed by its ends; 1:n is a column, n:m a join table")
    func resolution() throws {
        let rating = compileCollectionSchema("table Game:\n  name: Text\n\nconnection table Rating:\n  person: Person <-> ratings[]\n  game: Game <-> ratings[]\n  stars: Number\n")
        #expect(rating.diagnostics == [])
        #expect(rating.models.first { $0.name == "Rating" }?.key == ["person", "game"])
        let storage = compileCollectionSchema("table Episode:\n  title: Text\n  series: Series <-> episodes[]\n\ntable Series:\n  title: Text\n\ntable Game:\n  name: Text\n  authors: Person[] <-> games[]\n")
        #expect(storage.connections.map(\.storage) == [.column(on: "Episode", field: "series"), .array(on: "Game", field: "authors")])
        let tables = try schemaLayout(storage)
        #expect(tables.map(\.name) == ["Episode", "Series", "Game", "Game_authors"])
    }

    @Test("re blocks annotate, header keys key, and one table is main")
    func layers() {
        let result = compileCollectionSchema("main table Tag (list, id):\n  name: Text\n  list: List <-> tags[]\n\ntable List:\n  name: Text\n\nenum Status:\n  A\n  B\n\nre Status:\n  A @stored(\"a\")\n")
        #expect(result.diagnostics == [])
        let tag = result.models.first { $0.name == "Tag" }
        #expect(tag?.main == true)
        #expect(tag?.key == ["list", "id"])
        #expect(result.models.first { $0.name == "Status" }?.schemaRows.first?.stored == "a")
        #expect(compileCollectionSchema("table A:\n  name: Text ~label(\"Name\")\n").diagnostics.map(\.code).contains("presentation-attribute"))
    }

    @Test("Limits and syntax errors carry positions")
    func syntaxErrors() {
        let broken = parseSchema("table Book:\n  title: Text\n  author: ?\n")
        #expect(broken.file == nil)
        #expect(broken.diagnostics.first?.code == "syntax")
        #expect(broken.diagnostics.first?.line == 3)
        let deep = String(repeating: "[", count: 40) + String(repeating: "]", count: 40)
        #expect(parseSchema("table A:\n  name: Text\n  ~views(\(deep))\n").diagnostics.first?.code == "limit")
        #expect(parseSchema(String(repeating: "x", count: 1_100_000)).diagnostics.first?.code == "limit")
    }
}
