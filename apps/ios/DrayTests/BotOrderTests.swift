import XCTest
@testable import Dray

/// Bots follow the order the desktop drags them into (#1670).
@MainActor
final class BotOrderTests: XCTestCase {
    func testPlacedFirstUnplacedAfterInListOrder() throws {
        let json = #"[{"id":"a","name":"A","path":"/a"},{"id":"b","name":"B","path":"/b","order":1},{"id":"c","name":"C","path":"/c","order":null},{"id":"d","name":"D","path":"/d","order":0},{"id":"e","name":"E","path":"/e","order":1}]"#
        let bots = try JSONDecoder().decode([Bot].self, from: Data(json.utf8))
        let s = UUID()
        XCTAssertEqual(Store.placed(bots.map { (s, $0) }).map(\.bot.id), ["d", "b", "e", "a", "c"])
    }
}
