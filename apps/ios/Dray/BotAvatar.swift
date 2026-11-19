/// A Blobatar face: a shape name and hue degrees. Its own file so the alert
/// extension can draw a bot's face without the rest of the wire.
struct BotAvatar: Codable, Hashable {
    let shape: String
    let hue: Double
}
