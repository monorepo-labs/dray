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
                    Orb(.loading, size: 32)
                case true?:
                    ZStack {
                        Scanner(onScan: onScan) { allowed = false }.ignoresSafeArea()
                        VStack(spacing: 0) {
                            Viewfinder()
                                .stroke(Theme.text, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                                .frame(width: 240, height: 240)
                            Text("Point at the pairing code").font(Theme.Font.subhead).foregroundStyle(Theme.text)
                                .padding(.top, 36)
                            Text("Run dray server pair on the server.").font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                                .padding(.top, Theme.Space.xs)
                        }
                        .allowsHitTesting(false)
                    }
                default:
                    EmptyState(title: "Can't use the camera",
                               message: "Allow Dray to use the camera in Settings, or type the address and token instead.") {
                        Image(systemName: "camera").font(.largeTitle).foregroundStyle(Theme.tertiary)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .page()
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

/// The four corners the code is aimed into, drawn on a 240pt square.
private struct Viewfinder: Shape {
    func path(in r: CGRect) -> Path {
        let s = r.width / 240, inset = 4 * s, arm = 44 * s, radius = 20 * s
        var p = Path()
        for (x, y, dx, dy) in [(r.minX, r.minY, 1.0, 1.0), (r.maxX, r.minY, -1, 1), (r.maxX, r.maxY, -1, -1), (r.minX, r.maxY, 1, -1)] {
            let cx = x + dx * inset, cy = y + dy * inset
            p.move(to: CGPoint(x: cx, y: cy + dy * arm))
            p.addArc(tangent1End: CGPoint(x: cx, y: cy), tangent2End: CGPoint(x: cx + dx * arm, y: cy), radius: radius)
            p.addLine(to: CGPoint(x: cx + dx * arm, y: cy))
        }
        return p
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
