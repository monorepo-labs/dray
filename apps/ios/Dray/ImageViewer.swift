import SwiftUI
import UIKit

extension EnvironmentValues {
    /// Opens the viewer on a picture among the rest of its turn's, set by the turn.
    @Entry var openImage: ((ImageRef) -> Void)?
}

/// Presents or retires the viewer's cover with no slide: the viewer fades itself.
@MainActor func instantly(_ change: () -> Void) {
    var t = Transaction()
    t.disablesAnimations = true
    withTransaction(t, change)
}

/// A turn's pictures, full screen: swipe to page, pinch or double-tap to zoom,
/// drag down to close. Bar and strip step aside while zoomed or dragged.
struct ImageViewer: View {
    let shots: [Shot]
    let store: Store
    let server: Connection?
    let close: () -> Void
    @State private var page: Int
    @State private var images: [Int: UIImage]
    @State private var failed: Set<Int> = []
    @State private var zoomed = false
    /// Decided on a drag's first move: sideways pages, up or down is a dismiss.
    @State private var axis: Axis?
    /// A paging drag's sideways travel, and a dismiss drag's.
    @State private var slide: CGFloat = 0
    @State private var drag: CGSize = .zero
    @State private var shown = false

    init(shots: [Shot], start: Int, store: Store, server: Connection?, close: @escaping () -> Void) {
        self.shots = shots
        self.store = store
        self.server = server
        self.close = close
        _page = State(initialValue: start)
        // Whatever the transcript already drew, on the first frame.
        _images = State(initialValue: Dictionary(uniqueKeysWithValues: shots.enumerated().compactMap { i, shot in
            ImageLoader.cached(shot.ref, server).map { (i, $0) }
        }))
    }

    var body: some View {
        let current = min(page, shots.count - 1)
        let dragging = axis == .vertical
        let chrome = shown && !zoomed && !dragging
        // The page thins to `dim` as the picture is pulled a screen's half down.
        let pull = min(1, max(0, drag.height) / 400)
        ZStack {
            Theme.page.opacity(shown ? 1 - pull * (1 - Theme.Viewer.dim) : 0).ignoresSafeArea()
            pager(current, dragging: dragging).opacity(shown ? 1 : 0)
            VStack(spacing: 0) {
                bar(current)
                Spacer(minLength: 0)
                footer(current)
            }
            .opacity(chrome ? 1 : 0)
            .allowsHitTesting(chrome)
        }
        .statusBarHidden(!chrome)
        .animation(Theme.motion, value: chrome)
        .onAppear { withAnimation(Theme.motion) { shown = true } }
        .task {
            for i in [current] + shots.indices.filter({ $0 != current }) where images[i] == nil {
                await load(i)
            }
        }
    }

    /// Pages side by side, slid by offset rather than a paging ScrollView, so one
    /// drag owns both paging and the pull to close and the two never split a touch.
    private func pager(_ current: Int, dragging: Bool) -> some View {
        GeometryReader { geo in
            HStack(spacing: 0) {
                ForEach(shots.indices, id: \.self) { i in
                    pageView(i, current: i == current, dragging: dragging)
                        .offset(i == current ? drag : .zero)
                        .frame(width: geo.size.width, height: geo.size.height)
                }
            }
            .offset(x: slide - CGFloat(current) * geo.size.width)
            .contentShape(.rect)
            // Zoomed, a drag is the picture's own pan.
            .gesture(pagerDrag(width: geo.size.width), including: zoomed ? .subviews : .all)
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("image-pager")
    }

    @ViewBuilder
    private func pageView(_ i: Int, current: Bool, dragging: Bool) -> some View {
        if let image = images[i] {
            ZoomingImage(image: image, rounded: current && dragging,
                         zoomed: current ? $zoomed : .constant(false))
                .shadow(color: current && dragging ? Theme.Viewer.shadow : .clear,
                        radius: Theme.Viewer.shadowRadius, y: Theme.Viewer.shadowY)
                .accessibilityLabel(shots[i].target ?? "Image")
        } else if failed.contains(i) {
            failure(i)
        } else {
            ProgressView().tint(Theme.tertiary)
        }
    }

    private func pagerDrag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { g in
                let t = g.translation
                if axis == nil { axis = abs(t.width) > abs(t.height) ? .horizontal : .vertical }
                if axis == .vertical {
                    drag = t
                } else {
                    // Past either end it gives, a third as far.
                    let edge = (page == 0 && t.width > 0) || (page == shots.count - 1 && t.width < 0)
                    slide = edge ? t.width / 3 : t.width
                }
            }
            .onEnded { g in
                if axis == .vertical, g.translation.height > Theme.Viewer.dismissAt
                    || g.predictedEndTranslation.height > 2 * Theme.Viewer.dismissAt {
                    return dismiss(flinging: true)
                }
                let swing = g.predictedEndTranslation.width
                withAnimation(Theme.motion) {
                    if axis == .horizontal, swing < -width / 2 { page = min(page + 1, shots.count - 1) }
                    if axis == .horizontal, swing > width / 2 { page = max(page - 1, 0) }
                    slide = 0
                    drag = .zero
                    axis = nil
                }
            }
    }

    private func dismiss(flinging: Bool = false) {
        withAnimation(Theme.motion) {
            if flinging { drag.height += 600 }
            shown = false
        } completion: {
            close()
        }
    }

    private func bar(_ current: Int) -> some View {
        HStack {
            Button { dismiss() } label: { Image(systemName: "xmark") }
                .buttonStyle(GlassCircleStyle())
                .accessibilityLabel("Close")
            Spacer()
            if shots.count > 1 {
                Text("\(current + 1) of \(shots.count)")
                    .font(Theme.Font.subhead)
                    .monospacedDigit()
                    .foregroundStyle(Theme.text)
            }
            Spacer()
            if let image = images[current] {
                let name = shots[current].target ?? "Image"
                ShareLink(item: Image(uiImage: image), preview: SharePreview(name, image: Image(uiImage: image))) {
                    Image(systemName: "square.and.arrow.up")
                }
                .buttonStyle(GlassCircleStyle())
                .accessibilityLabel("Share")
            } else {
                Button {} label: { Image(systemName: "square.and.arrow.up") }
                    .buttonStyle(GlassCircleStyle())
                    .disabled(true)
                    .accessibilityLabel("Share")
            }
        }
        .padding(.horizontal, Theme.Space.l)
        .frame(height: Theme.Viewer.bar)
    }

    private func footer(_ current: Int) -> some View {
        VStack(spacing: Theme.Viewer.stripGap) {
            if shots.count > 1 { strip(current) }
            let shot = shots[current]
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(shot.verb).foregroundStyle(Theme.secondary)
                if let target = shot.target {
                    Text(target).foregroundStyle(Theme.tertiary).lineLimit(1).truncationMode(.middle)
                }
            }
            .font(Theme.Font.footnote)
            .padding(.horizontal, Theme.Space.l)
        }
        .padding(.bottom, Theme.Viewer.foot)
    }

    /// Every picture in the turn, the current one ringed; a tap jumps to it.
    private func strip(_ current: Int) -> some View {
        ScrollViewReader { proxy in
            ViewThatFits(in: .horizontal) {
                thumbs(current)
                ScrollView(.horizontal) { thumbs(current) }.scrollIndicators(.never)
            }
            .onChange(of: current) { withAnimation(Theme.motion) { proxy.scrollTo(current, anchor: .center) } }
        }
    }

    private func thumbs(_ current: Int) -> some View {
        HStack(spacing: Theme.Space.s) {
            ForEach(shots.indices, id: \.self) { i in
                Button {
                    withAnimation(Theme.motion) { page = i }
                } label: {
                    thumb(i, current: i == current)
                }
                .buttonStyle(.plain)
                .id(i)
                .accessibilityLabel("Image \(i + 1) of \(shots.count)")
                .accessibilityAddTraits(i == current ? .isSelected : [])
            }
        }
        // Room for the ring, which a scrolling strip would otherwise clip.
        .padding(Theme.Viewer.ringGap + Theme.Viewer.ring)
    }

    private func thumb(_ i: Int, current: Bool) -> some View {
        let radius = Theme.Radius.sm, gap = Theme.Viewer.ringGap, ring = Theme.Viewer.ring
        return Group {
            if let image = images[i] {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Theme.card.overlay {
                    if failed.contains(i) {
                        Image(systemName: "photo").font(Theme.Viewer.thumbMark).foregroundStyle(Theme.tertiary)
                    }
                }
            }
        }
        .frame(width: Theme.Viewer.thumb, height: Theme.Viewer.thumb)
        .clipShape(.rect(cornerRadius: radius, style: .continuous))
        .opacity(current ? 1 : Theme.Viewer.dim)
        .background {
            if current {
                ZStack {
                    RoundedRectangle(cornerRadius: radius + gap + ring, style: .continuous)
                        .fill(Theme.text).padding(-(gap + ring))
                    RoundedRectangle(cornerRadius: radius + gap, style: .continuous)
                        .fill(Theme.page).padding(-gap)
                }
            }
        }
    }

    private func failure(_ i: Int) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "photo").font(Theme.Viewer.mark).foregroundStyle(Theme.tertiary)
            VStack(spacing: 2) {
                Text("Couldn't load image").font(Theme.Font.headline).foregroundStyle(Theme.text)
                Text(reason(shots[i].ref)).font(Theme.Font.footnote).foregroundStyle(Theme.secondary)
                    .multilineTextAlignment(.center)
            }
            Button { Task { await load(i) } } label: {
                Text("Try again")
                    .font(Theme.Font.pill)
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, Theme.Space.l)
                    .frame(height: Theme.Viewer.button)
                    .background(Theme.raised, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(Theme.Space.xxl)
    }

    /// A path is read off its server, so a server away is the likely cause; a link stands alone.
    private func reason(_ ref: ImageRef) -> String {
        guard ref.path != nil || !(ref.url ?? "").hasPrefix("http") else { return "Its link didn't answer." }
        guard let id = server?.serverId else { return "Its server isn't connected." }
        return store.serverState[id] == .connected
            ? "\(store.name(of: id)) couldn't send it."
            : "\(store.name(of: id)) isn't reachable right now."
    }

    private func load(_ i: Int) async {
        failed.remove(i)
        if let image = await ImageLoader.load(shots[i].ref, from: server) {
            images[i] = image
        } else {
            failed.insert(i)
        }
    }
}

/// A round glass button over a picture: the viewer's Close and Share.
struct GlassCircleStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let label = configuration.label
            .font(Theme.Viewer.glyph)
            .foregroundStyle(Theme.text)
            .frame(width: Theme.Viewer.thumb, height: Theme.Viewer.thumb)
        Group {
            if #available(iOS 26, *) {
                label.glassEffect(.regular.interactive(), in: .circle)
            } else {
                label.background(.ultraThinMaterial, in: Circle()).pressed(configuration.isPressed)
            }
        }
        .opacity(enabled ? 1 : Theme.Viewer.off)
    }
}

/// UIScrollView's own pinch, pan and bounce around one picture, fitted at rest.
private struct ZoomingImage: UIViewRepresentable {
    let image: UIImage
    /// Lifted off the page by a dismiss drag.
    let rounded: Bool
    @Binding var zoomed: Bool

    func makeUIView(context: Context) -> ZoomView { ZoomView() }

    func updateUIView(_ view: ZoomView, context: Context) {
        let binding = $zoomed
        view.onZoom = { if binding.wrappedValue != $0 { binding.wrappedValue = $0 } }
        if view.imageView.image !== image {
            view.imageView.image = image
            view.setZoomScale(1, animated: false)
            view.setNeedsLayout()
        }
        view.imageView.layer.cornerRadius = rounded ? Theme.Radius.lg : 0
    }
}

private final class ZoomView: UIScrollView, UIScrollViewDelegate {
    let imageView = UIImageView()
    var onZoom: (Bool) -> Void = { _ in }

    init() {
        super.init(frame: .zero)
        delegate = self
        maximumZoomScale = Theme.Viewer.maxZoom
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        contentInsetAdjustmentBehavior = .never
        decelerationRate = .fast
        imageView.clipsToBounds = true
        imageView.layer.cornerCurve = .continuous
        addSubview(imageView)
        panGestureRecognizer.isEnabled = false
        let tap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        tap.numberOfTapsRequired = 2
        addGestureRecognizer(tap)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Fitted only at rest: zoomed, the scroll view owns the frame.
        if zoomScale == 1, let size = imageView.image?.size, size.width > 0, size.height > 0, bounds.width > 0 {
            let s = min(bounds.width / size.width, bounds.height / size.height)
            let fitted = CGSize(width: size.width * s, height: size.height * s)
            if imageView.bounds.size != fitted {
                imageView.frame = CGRect(origin: .zero, size: fitted)
                contentSize = fitted
            }
        }
        center()
    }

    /// Smaller than the screen on an axis, the picture sits in its middle.
    private func center() {
        imageView.center = CGPoint(x: max(bounds.width, contentSize.width) / 2,
                                   y: max(bounds.height, contentSize.height) / 2)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        center()
        let zoomed = zoomScale > 1.01
        // At rest there is nothing to pan, and the pager's drag must get the touch.
        panGestureRecognizer.isEnabled = zoomed
        onZoom(zoomed)
    }

    @objc private func doubleTapped(_ tap: UITapGestureRecognizer) {
        if zoomScale > 1 { return setZoomScale(1, animated: true) }
        let p = tap.location(in: imageView), scale: CGFloat = 2.5
        let size = CGSize(width: bounds.width / scale, height: bounds.height / scale)
        zoom(to: CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }
}
