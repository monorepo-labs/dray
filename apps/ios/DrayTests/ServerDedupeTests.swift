import XCTest
@testable import Dray

/// One server is one saved entry, however it was added (#1244): copies an older
/// build saved fold on launch, and a moved address updates the entry it names.
@MainActor
final class ServerDedupeTests: XCTestCase {
    private var held: Data?
    private var made: [UUID] = []

    override func setUp() async throws {
        held = UserDefaults.standard.data(forKey: "servers")
    }

    override func tearDown() async throws {
        UserDefaults.standard.set(held, forKey: "servers")
        for id in made { Keychain.delete(id.uuidString) }
    }

    private func save(_ servers: [(Server, String)]) {
        for (s, token) in servers {
            Keychain.set(token, for: s.id.uuidString)
            made.append(s.id)
        }
        UserDefaults.standard.set(try! JSONEncoder().encode(servers.map(\.0)), forKey: "servers")
    }

    func testCopiesFoldOnLaunch() {
        let first = Server(id: UUID(), name: "Studio Mac", url: "ws://10.0.0.5:7777")
        let respelled = Server(id: UUID(), name: "Office Mac", url: "http://10.0.0.5:7777/")
        let moved = Server(id: UUID(), name: "Moved", url: "wss://new.example")
        let other = Server(id: UUID(), name: "VPS", url: "wss://vps.example")
        save([(first, String(repeating: "a", count: 64)), (respelled, String(repeating: "b", count: 64)),
              (moved, String(repeating: "b", count: 64)), (other, String(repeating: "c", count: 64))])

        let store = Store()
        XCTAssertEqual(store.servers.map(\.id), [first.id, other.id])
        XCTAssertEqual(store.servers[0].name, "Studio Mac", "the first copy's name stays")
        XCTAssertEqual(store.servers[0].url, "wss://new.example", "the newest copy's address wins")
        XCTAssertEqual(Keychain.get(first.id.uuidString), String(repeating: "b", count: 64), "the newest copy's token wins")
        XCTAssertNil(Keychain.get(respelled.id.uuidString))
        let saved = try! JSONDecoder().decode([Server].self, from: UserDefaults.standard.data(forKey: "servers")!)
        XCTAssertEqual(saved.map(\.id), [first.id, other.id], "the fold is saved")
    }

    func testMovedAddressUpdatesTheEntry() {
        let token = String(repeating: "d", count: 64)
        let s = Server(id: UUID(), name: "Studio Mac", url: "wss://old.example")
        save([(s, token)])

        let store = Store()
        store.addServer(name: "Studio Mac 2", url: "wss://new.example", token: token)
        XCTAssertEqual(store.servers.map(\.id), [s.id])
        XCTAssertEqual(store.servers[0].url, "wss://new.example")
        XCTAssertEqual(store.connection(s.id)?.url, "wss://new.example", "reconnected at the new address")

        store.addServer(name: "Again", url: "wss://NEW.example/", token: String(repeating: "e", count: 64))
        XCTAssertEqual(store.servers.count, 1, "the same address under another token")
        XCTAssertEqual(Keychain.get(s.id.uuidString), String(repeating: "e", count: 64))
    }
}
