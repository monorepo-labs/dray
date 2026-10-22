import AVFoundation
import SwiftUI
import ThinkingOrbs
import VisionKit

/// What a pairing QR carries: `dray://connect?url=…&token=…&name=…`, drawn by
/// the Mac's Remote access row and by `dray server pair`. The app registers
/// the scheme, so the system Camera opens one too.
struct PairLink: Identifiable {
    var id: String { url + token }
    let url: String
    let token: String
    let name: String?

    init?(_ text: String) {
        guard let parts = URLComponents(string: text), parts.scheme == "dray", parts.host == "connect" else { return nil }
        let query = parts.queryItems ?? []
        func value(_ key: String) -> String? { query.first { $0.name == key }?.value }
        guard let line = parseConnectLine("\(value("url") ?? "") \(value("token") ?? "")") else { return nil }
        url = line.url
        token = line.token
        name = value("name").flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// The camera, looking for a pairing QR. Answers the first one it reads; any
/// other code is ignored.
struct PairScanner: View {
    let onScan: (PairLink) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var allowed: Bool?

    var body: some View {
        NavigationStack {
            Group {
                switch allowed {
                case nil:
                    Orb(state: .working)
                case true?:
                    Scanner(onScan: onScan) { allowed = false }.ignoresSafeArea()
                default:
                    ContentUnavailableView(
                        "Can't use the camera",
                        systemImage: "camera",
                        description: Text("Allow Dray to use the camera in Settings, or type the address and token instead.")
                    )
                }
            }
            .navigationTitle("Scan QR code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .task {
            // Asked here rather than left to the scanner, which shows a blank view until answered.
            // A device that cannot scan is never asked; the simulator's ask never answers.
            guard DataScannerViewController.isSupported else { return allowed = false }
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: allowed = true
            case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
            default: allowed = false
            }
        }
    }
}

/// `onFail` answers a scanner that would not start or stopped being
/// available, so the reader is not left in front of a camera that reads nothing.
private struct Scanner: UIViewControllerRepresentable {
    let onScan: (PairLink) -> Void
    let onFail: () -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        guard !scanner.isScanning else { return }
        do { try scanner.startScanning() } catch {
            // Not inside the view update that is running now.
            DispatchQueue.main.async(execute: onFail)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan, onFail: onFail) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (PairLink) -> Void
        let onFail: () -> Void
        private var done = false

        init(onScan: @escaping (PairLink) -> Void, onFail: @escaping () -> Void) {
            self.onScan = onScan
            self.onFail = onFail
        }

        func dataScanner(_ scanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            onFail()
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                guard !done, let link = code.payloadStringValue.flatMap(PairLink.init) else { continue }
                done = true
                scanner.stopScanning()
                onScan(link)
            }
        }
    }
}
