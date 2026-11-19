import UserNotifications

/// Dresses an alert before iOS shows it (#1299); `dressAlert` says how.
final class NotificationService: UNNotificationServiceExtension {
    private var fallback: (() -> Void)?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler done: @escaping (UNNotificationContent) -> Void) {
        fallback = { done(request.content) }
        Task { @MainActor in
            done(await dressAlert(request.content))
            self.fallback = nil
        }
    }

    override func serviceExtensionTimeWillExpire() {
        fallback?()
    }
}
