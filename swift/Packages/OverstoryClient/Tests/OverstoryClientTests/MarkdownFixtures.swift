import Foundation
import Overstory
import Testing

/// Markdown `text` as the object a client writes for it: the page it reads as
/// (directory format §3). Fixtures that stand for a host's tree use this, so a
/// working tree that re-encodes the same text reaches the same root.
func markdownPage(_ text: String) throws -> ProtocolObjectEnvelope {
    try ProtocolObjectCodec.object(.page(try #require(ProtocolPage.parse(Data(text.utf8)))))
}
