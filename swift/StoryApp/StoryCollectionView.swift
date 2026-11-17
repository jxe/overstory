import OverstoryClient
import StoryKit
import SwiftUI

/// A logical collection folder, read-only: its main table's rows as a plain
/// list with a search field. Story drew rows arranged by the schema's
/// `~views` until USL went (2026-11-17); Apps 011 draws them from Beetle views.
struct StoryCollectionView: View {
    let node: WorkspaceNode
    let workspace: StoryWorkspaceState
    /// Shown when the folder holds no logical collection (a `_store.*` from before 005).
    let kind: String
    let rowCount: Int?

    private enum Load {
        case loading
        case loaded(WorkspaceCollectionRows)
        case notCollection
        case failed(String)
    }

    @State private var load = Load.loading
    @State private var query = ""

    private struct LoadKey: Hashable {
        var node: WorkspaceNode
        var generation: Int
        var providerRevision: Int
    }

    var body: some View {
        content
            .task(id: LoadKey(node: node, generation: workspace.generation, providerRevision: workspace.providerRevision)) {
                await reload()
            }
    }

    @ViewBuilder
    private var content: some View {
        switch load {
        case .loading:
            ProgressView().frame(maxWidth: .infinity)
        case .notCollection:
            LabeledContent("Collection", value: kind)
            if let rowCount { LabeledContent("Rows", value: rowCount.formatted()) }
        case let .failed(message):
            ContentUnavailableView("Can't show this collection", systemImage: "tablecells.badge.ellipsis", description: Text(message))
        case let .loaded(collection):
            presented(collection)
        }
    }

    private func reload() async {
        do {
            load = .loaded(try await workspace.provider.collectionRows(node.reference))
        } catch WorkspaceCollectionError.notCollection {
            load = .notCollection
        } catch {
            load = .failed(error.localizedDescription)
        }
    }

    @ViewBuilder
    private func presented(_ collection: WorkspaceCollectionRows) -> some View {
        let names = Dictionary(
            (workspace.directory.map { ($0.id, $0.title) } + workspace.rememberedPeople.map { ($0.id, $0.name) }),
            uniquingKeysWith: { first, _ in first })
        switch Result(catching: { try CollectionList(collection, people: names) }) {
        case let .failure(error):
            ContentUnavailableView("Can't show this collection", systemImage: "tablecells.badge.ellipsis",
                                   description: Text((error as? RowEditError)?.message ?? error.localizedDescription))
        case let .success(list):
            let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
            let lines = trimmed.isEmpty ? list.lines : list.lines.filter { line in
                ([line.title] + line.details).contains { $0.localizedCaseInsensitiveContains(trimmed) }
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(list.table).font(.headline)
                    Text(list.lines.count.formatted()).foregroundStyle(.secondary)
                    Spacer()
                    TextField("Search", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 220)
                }
                ForEach(lines) { line in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.title)
                        if !line.details.isEmpty {
                            Text(line.details.joined(separator: " · "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 2)
                }
            }
        }
    }
}

/// A person a collection names, by profile id.
struct PresentedPerson: Sendable, Equatable {
    var id: String
    var name: String
}

/// A collection's main table as plain lines: each row's title (its `name` or
/// `title`, else its first text field, else its key) and its other single values.
private struct CollectionList {
    struct Line: Identifiable {
        var id: String
        var title: String
        var details: [String]
    }

    var table: String
    var lines: [Line]

    init(_ collection: WorkspaceCollectionRows, people: [String: String]) throws {
        let schema = collection.schema
        if let first = schema.diagnostics.first { throw RowEditError(message: first.message) }
        let data = schema.models.filter { $0.rows != .fixed && $0.ends.isEmpty && $0.name != "Person" }
        guard let model = data.first(where: \.main) ?? (data.count == 1 ? data.first : nil) else {
            throw RowEditError(message: "This collection has no main table to list")
        }
        let tables = try schemaLayout(schema, store: .files)
        guard let stored = tables.first(where: { $0.ends == nil && $0.stores == model.name }) else {
            throw RowEditError(message: "No table stores \(model.name)")
        }
        let columns = stored.fields.reduce(into: [String: String]()) { $0[$1.name] = $1.columns.first }
        let shown = model.fields.filter { $0.arity != .many && !["id", "created", "modified"].contains($0.name) }
        let titleField = shown.first { $0.name == "name" || $0.name == "title" }
            ?? shown.first { $0.type == "Text" }
        func text(_ value: JSONValue?, type: String) -> String? {
            let plain: String
            switch value {
            case .string(let s): plain = s
            case .bool(let b): plain = b ? "yes" : "no"
            case .number(let n): plain = n.formatted()
            default: return nil
            }
            if type == "Person" { return people[plain] ?? plain }
            if type == "Markdown" { return plain.split(separator: "\n").first.map(String.init) }
            return plain.isEmpty ? nil : plain
        }
        table = model.name
        lines = (collection.rows[stored.name] ?? []).enumerated().map { index, row in
            let value = { (field: SchemaResolvedField) in text(row[columns[field.name] ?? field.name], type: field.type) }
            let key = schemaRowKey(stored, row) ?? "\(index)"
            return Line(
                id: key,
                title: titleField.flatMap(value) ?? key,
                details: shown.filter { $0.name != titleField?.name }.compactMap(value)
            )
        }
    }
}
