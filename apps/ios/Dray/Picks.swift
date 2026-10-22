import Foundation


// MARK: Wire

struct Project: Decodable, Hashable {
    let path: String
    let name: String
    let lastSelected: String
}

struct AgentAvailability: Decodable, Hashable {
    let harness: String
    let available: Bool
    let label: String
    let reason: String
}

struct Model: Decodable, Hashable {
    let id: String
    let label: String
    let efforts: [String]
    let defaultEffort: String?
    let supportsFast: Bool
    /// Off the shortlist by default: a pinned older generation, reachable but not offered.
    let secondary: Bool?
}

struct BranchList: Decodable {
    let current: String?
    let branches: [String]
    let defaultBase: String?
    let dirty: Int
}

struct GithubRepo: Decodable, Hashable {
    let slug: String
    let description: String?
    let path: String?
}

struct CloneProgress: Decodable {
    let slug: String
    let line: String
}

// MARK: Rules

/// The desktop composer's rules, restated since neither side can call the
/// other: `permission.ts`, `fastMode.ts` and `model.ts`. A new session runs no
/// turn yet, so nothing in `liveControls.ts` locks here.
enum Picks {
    /// `DEFAULT_MODEL_FOR`. Empty is "let the harness decide", which pi and fx
    /// answer from their own settings.
    static let defaultModel = ["claude_code": "opus", "codex": "gpt-6-sol", "pi": "", "fx": "", "grok": "grok-4.7"]
    static let defaultEffort = "high"
    static let effortLabels = ["low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra High", "max": "Max", "ultra": "Ultra"]
    static let stances = [("bypassPermissions", "Bypass permissions"), ("manual", "Ask every time"), ("plan", "Plan"), ("auto", "Auto")]

    /// `HONOURED`: absent means every stance applies.
    private static let honoured: [String: [String]] = [
        "codex": ["bypassPermissions", "manual", "auto"],
        "pi": [],
        "fx": ["manual", "auto"],
        "grok": ["manual", "auto", "bypassPermissions"],
    ]

    static func honours(_ harness: String, _ mode: String) -> Bool {
        honoured[harness]?.contains(mode) ?? true
    }

    /// One honoured stance is not a menu, and pi honours none.
    static func offersStances(_ harness: String) -> Bool {
        stances.filter { honours(harness, $0.0) }.count > 1
    }

    /// `stanceFor`: what the session will actually run, which is what the index records.
    static func stanceFor(_ harness: String, _ mode: String) -> String {
        if honours(harness, mode) { return mode }
        switch harness {
        case "fx": return mode == "plan" ? "manual" : "auto"
        case "grok": return mode == "plan" ? "manual" : "bypassPermissions"
        default: return "bypassPermissions"
        }
    }

    /// `offersFast` and `fastFor` for a new session: the harness needs a route
    /// to one (pi has none) and the model a faster tier. fx alone stands with no
    /// model picked, since it decides per model itself.
    static func offersFast(_ harness: String, _ model: Model?) -> Bool {
        guard ["claude_code", "codex", "fx", "grok"].contains(harness) else { return false }
        return model?.supportsFast ?? (harness == "fx")
    }

    /// `usableModel`: a pick this list cannot run falls to the harness's
    /// default, never to the head of the list.
    static func usableModel(_ models: [Model], _ picked: String, _ harness: String) -> String {
        if models.isEmpty || models.contains(where: { $0.id == picked }) { return picked }
        let fallback = defaultModel[harness] ?? ""
        if fallback.isEmpty { return "" }
        return models.contains { $0.id == fallback } ? fallback : models[0].id
    }

    /// `usableEffort`: the pick, else the model's default, else the app's, else the top rung.
    static func usableEffort(_ model: Model, _ remembered: String?) -> String? {
        guard !model.efforts.isEmpty else { return nil }
        for wanted in [remembered, model.defaultEffort, defaultEffort] {
            if let wanted, model.efforts.contains(wanted) { return wanted }
        }
        return model.efforts.last
    }
}

/// The last model per harness and effort per model, which `@AppStorage` cannot hold.
enum Prefs {
    static func map(_ key: String) -> [String: String] {
        UserDefaults.standard.dictionary(forKey: "new." + key) as? [String: String] ?? [:]
    }
    static func set(_ value: [String: String], _ key: String) { UserDefaults.standard.set(value, forKey: "new." + key) }
}
