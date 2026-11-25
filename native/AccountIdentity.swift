import Cocoa

/// Shared identity DTO. Quota interpretation stays in QuotaPresentation.
struct AccountIdentity {
    static var isPrivacyMaskEnabled: Bool = false

    let id: String
    let name: String
    let email: String
    let tier: String
    let selectable: Bool

    var displayName: String {
        Self.displayName(name: name, email: email)
    }

    static func normalizeTier(_ raw: String?) -> String {
        let value = (raw ?? "").uppercased()
        if value.contains("ULTRA") { return "ULTRA" }
        if value.contains("ENTERPRISE") { return "ENTERPRISE" }
        if value.contains("TEAM") || value.contains("BUSINESS") || value.contains("WORKSPACE") { return "TEAM" }
        if value.contains("PLUS") { return "PLUS" }
        if value.range(of: "\\bPRO\\b", options: .regularExpression) != nil || value.contains("AI PREMIUM") { return "PRO" }
        if value.contains("FREE") || value.contains("STARTER") || value.contains("TRIAL") { return "FREE" }
        return ""
    }

    static func maskLocalSegment(_ segment: String) -> String {
        let trimmed = segment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let chars = Array(trimmed)
        switch chars.count {
        case 1: return "•"
        case 2: return "\(chars[0])•"
        case 3: return "\(chars[0])••"
        default: return "\(chars[0])\(chars[1])•••\(chars[chars.count - 1])"
        }
    }

    static func maskEmail(_ email: String) -> String {
        let trimmed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        guard let atIdx = trimmed.firstIndex(of: "@") else {
            return maskLocalSegment(trimmed)
        }
        let local = String(trimmed[..<atIdx])
        let domain = String(trimmed[trimmed.index(after: atIdx)...])
        if local.isEmpty {
            return maskLocalSegment(trimmed)
        }
        let maskedLocal = maskLocalSegment(local)
        guard !domain.isEmpty else { return "\(maskedLocal)@•••" }
        let parts = domain.split(separator: ".").map(String.init).filter { !$0.isEmpty }
        let maskedDomain: String
        if parts.count >= 2, let first = parts.first, let last = parts.last, let firstChar = Array(first).first {
            maskedDomain = "\(firstChar)•••.\(last)"
        } else {
            let dChars = Array(domain)
            maskedDomain = dChars.count <= 1 ? "•" : "\(dChars[0])•••"
        }
        return "\(maskedLocal)@\(maskedDomain)"
    }

    static func maskDisplayName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        if trimmed.contains("@") {
            return maskEmail(trimmed)
        }
        let chars = Array(trimmed)
        switch chars.count {
        case 1: return "•"
        case 2: return "\(chars[0])•"
        case 3: return "\(chars[0])••"
        default: return "\(chars[0])•••"
        }
    }

    static func displayEmail(_ email: String?, masked: Bool = isPrivacyMaskEnabled) -> String {
        let clean = (email ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return "" }
        return masked ? maskEmail(clean) : clean
    }

    static func displayName(name: String?, email: String) -> String {
        displayName(name: name, email: email, masked: false)
    }

    static func displayName(name: String?, email: String, masked: Bool) -> String {
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            return masked ? maskDisplayName(trimmed) : trimmed
        }
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanEmail.isEmpty else { return "" }
        let localPart = cleanEmail.components(separatedBy: "@").first ?? cleanEmail
        return masked ? maskLocalSegment(localPart) : localPart
    }

    static func displayTarget(
        name: String?,
        email: String,
        masked: Bool = isPrivacyMaskEnabled,
        isEnglish: Bool = L10n.shared.isEnglish
    ) -> String {
        let cleanName = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let shownName = masked ? maskDisplayName(cleanName) : cleanName
        let shownEmail = displayEmail(cleanEmail, masked: masked)
        if !shownName.isEmpty && !shownEmail.isEmpty && cleanName.caseInsensitiveCompare(cleanEmail) != .orderedSame {
            return isEnglish ? "\(shownName) (\(shownEmail))" : "\(shownName)（\(shownEmail)）"
        }
        return !shownEmail.isEmpty ? shownEmail : shownName
    }

    private static let emailRegex = try? NSRegularExpression(pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")

    static func maskEmailsInText(
        _ text: String,
        knownEmails: [String] = [],
        masked: Bool = isPrivacyMaskEnabled
    ) -> String {
        guard masked, !text.isEmpty else { return text }
        var output = text
        let sortedKnown = Array(Set(knownEmails.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }))
            .sorted { $0.count > $1.count }
        for email in sortedKnown {
            output = output.replacingOccurrences(of: email, with: maskEmail(email), options: .caseInsensitive)
        }
        guard let regex = emailRegex else { return output }
        let nsRange = NSRange(output.startIndex..<output.endIndex, in: output)
        let matches = regex.matches(in: output, range: nsRange)
        guard !matches.isEmpty else { return output }
        var mutable = output
        for match in matches.reversed() {
            guard let range = Range(match.range, in: mutable) else { continue }
            let found = String(mutable[range])
            mutable.replaceSubrange(range, with: maskEmail(found))
        }
        return mutable
    }

    init(_ raw: [String: Any]) {
        id = raw["id"] as? String ?? ""
        name = (raw["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        email = raw["email"] as? String ?? ""
        tier = Self.normalizeTier(raw["subscription_tier"] as? String)
        selectable = raw["disabled"] as? Bool != true
            && raw["validation_blocked"] as? Bool != true
            && (raw["credentialReadiness"] as? [String: Any])?["state"] as? String != "needs_authorization"
    }
}
