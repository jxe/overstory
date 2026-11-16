import Foundation
import Overstory
import Testing
@testable import OverstoryWorkingTree

/// Markdown `text` as the object a client writes for it: the page it reads as
/// (directory format §3). Fixtures that stand for a host's tree use this, so a
/// working tree that re-encodes the same text reaches the same root.
func markdownPage(_ text: String) throws -> ProtocolObjectEnvelope {
    try ProtocolObjectCodec.object(.page(try #require(ProtocolPage.parse(Data(text.utf8)))))
}

/// `snapshot` with each Markdown file entry that reads as a page replaced by
/// that page, as a client writes the same tree. Shared vectors state their
/// trees with files; a working tree installs only what it would write.
func withPages(_ snapshot: ProtocolSnapshot) throws -> ProtocolSnapshot {
    var objects = Dictionary(uniqueKeysWithValues: snapshot.objects.map { ($0.hash, $0.bytes) })
    var memo: [String: String] = [:]
    func convert(_ hash: String) throws -> String {
        if let known = memo[hash] { return known }
        guard let bytes = objects[hash], case let .directory(entries, collection) = try ProtocolObjectCodec.decode(bytes, kind: .directory) else { return hash }
        let converted = try entries.map { entry -> ProtocolDirectoryEntry in
            var entry = entry
            if let directory = entry.directory { entry.directory = try convert(directory) }
            else if let file = entry.file, ProtocolPage.isPageName(entry.name), let data = objects[file], let page = ProtocolPage.parse(data) {
                let object = try ProtocolObjectCodec.object(.page(page))
                objects[object.hash] = object.bytes
                entry.file = nil; entry.page = object.hash
            }
            return entry
        }
        let object = try ProtocolObjectCodec.object(.directory(converted, collection: collection))
        objects[object.hash] = object.bytes
        memo[hash] = object.hash
        return object.hash
    }
    let root = try convert(snapshot.root)
    return try ProtocolGraph.reachable(from: root, in: objects)
}
