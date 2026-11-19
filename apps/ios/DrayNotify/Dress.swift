import Intents
import SwiftUI
import UserNotifications

/// The per-question categories start with this; the app keeps them across its own registration.
let questionCategoryPrefix = "dray.question."

/// An alert as the extension shows it: a bot's chat comes from the bot, its
/// face as the sender's picture, and one question gets its options as the
/// alert's own buttons. Anything that fails leaves the alert as it came.
/// Compiled into the app too, for the simulator test simctl push gives no extension.
@MainActor
func dressAlert(_ content: UNNotificationContent) async -> UNNotificationContent {
    guard let dray = content.userInfo["dray"] as? [String: Any],
          let alert = content.mutableCopy() as? UNMutableNotificationContent else { return content }
    if let q = dray["question"] as? [String: Any], let request = dray["request"] as? String {
        alert.categoryIdentifier = await category(request, options: q["options"] as? [String] ?? [], freeText: q["freeText"] as? Bool ?? false)
    }
    guard let bot = dray["bot"] as? [String: Any], let id = bot["id"] as? String else { return alert }
    let avatar = (bot["shape"] as? String).map { BotAvatar(shape: $0, hue: bot["hue"] as? Double ?? 0) }
    // A pale wash of the bot's own colour; a face with no pick has no hue to wash with.
    let backdrop = avatar.map { Color(hue: $0.hue / 360, saturation: 0.22, brightness: 0.96) } ?? Color(white: 0.92)
    let face = ImageRenderer(content: BotFace(seed: id, avatar: avatar, size: 120).frame(width: 160, height: 160).background(backdrop))
    face.scale = 2
    let sender = INPerson(personHandle: INPersonHandle(value: id, type: .unknown), nameComponents: nil,
                          displayName: alert.title, image: face.uiImage?.pngData().map(INImage.init(imageData:)),
                          contactIdentifier: nil, customIdentifier: id)
    let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText, content: alert.body,
                                     speakableGroupName: nil, conversationIdentifier: dray["session"] as? String,
                                     serviceName: nil, sender: sender, attachments: nil)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    try? await interaction.donate()
    return (try? alert.updating(from: intent)) ?? alert
}

/// A category for one question: an action per option, and Reply where any answer
/// goes and iOS has room, four actions being all it shows. Without Reply, tapping
/// the alert opens the app, where a typed answer still can be given.
/// One whose alert is gone is dropped, since iOS holds every category registered.
private func category(_ request: String, options: [String], freeText: Bool) async -> String {
    let id = questionCategoryPrefix + request
    var actions = options.enumerated().map { UNNotificationAction(identifier: "q.\($0.offset)", title: $0.element) }
    if freeText && actions.count < 4 {
        actions.append(UNTextInputNotificationAction(identifier: "q.text", title: "Reply…", options: [],
                                                     textInputButtonTitle: "Send", textInputPlaceholder: "Your answer"))
    }
    let center = UNUserNotificationCenter.current()
    let held = await center.notificationCategories()
    let shown = Set(await center.deliveredNotifications().map(\.request.content.categoryIdentifier))
    let stale = held.filter { $0.identifier.hasPrefix(questionCategoryPrefix) && !shown.contains($0.identifier) }
    center.setNotificationCategories(held.subtracting(stale).union([UNNotificationCategory(identifier: id, actions: actions, intentIdentifiers: [])]))
    return id
}
