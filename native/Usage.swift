import Cocoa

struct UsageQueryIdentity: Equatable {
    let period: String
    let environmentId: String
    let accountId: String

    init(period: String, environmentId: String = "all", accountId: String = "all") {
        self.period = period
        let trimmedEnv = environmentId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.environmentId = trimmedEnv.isEmpty ? "all" : trimmedEnv
        let trimmedAcc = accountId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.accountId = trimmedAcc.isEmpty ? "all" : trimmedAcc
    }

    func matches(_ report: [String: Any]) -> Bool {
        guard report["period"] as? String == period else { return false }
        let summary = report["summary"] as? [String: Any]
        let rawEnv = (report["selectedEnvironmentId"] as? String)
            ?? (report["selected_environment_id"] as? String)
            ?? (summary?["selectedEnvironmentId"] as? String)
            ?? (summary?["selected_environment_id"] as? String)
            ?? "all"
        let trimmedEnv = rawEnv.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedEnv = trimmedEnv.isEmpty ? "all" : trimmedEnv
        let rawAcc = (report["selectedAccountId"] as? String)
            ?? (report["selected_account_id"] as? String)
            ?? (summary?["selectedAccountId"] as? String)
            ?? (summary?["selected_account_id"] as? String)
            ?? "all"
        let trimmedAcc = rawAcc.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAcc = trimmedAcc.isEmpty ? "all" : trimmedAcc
        return normalizedEnv == environmentId && normalizedAcc == accountId
    }
}

enum UsageFilterSupport {
    static func extractAvailableEnvironments(from report: [String: Any]) -> [[String: Any]] {
        let summary = report["summary"] as? [String: Any]
        return (report["availableEnvironments"] as? [[String: Any]])
            ?? (report["available_environments"] as? [[String: Any]])
            ?? (summary?["availableEnvironments"] as? [[String: Any]])
            ?? (summary?["available_environments"] as? [[String: Any]])
            ?? []
    }

    static func extractAvailableAccounts(from report: [String: Any]) -> [[String: Any]] {
        let summary = report["summary"] as? [String: Any]
        return (report["availableAccounts"] as? [[String: Any]])
            ?? (report["available_accounts"] as? [[String: Any]])
            ?? (summary?["availableAccounts"] as? [[String: Any]])
            ?? (summary?["available_accounts"] as? [[String: Any]])
            ?? []
    }

    static func extractEnvironmentBreakdown(from report: [String: Any]) -> [String: Any]? {
        let summary = report["summary"] as? [String: Any]
        return (report["environmentBreakdown"] as? [String: Any])
            ?? (report["environment_breakdown"] as? [String: Any])
            ?? (summary?["environmentBreakdown"] as? [String: Any])
            ?? (summary?["environment_breakdown"] as? [String: Any])
    }

    static func hasSshEnvironment(environments: [[String: Any]], breakdown: [String: Any]?, rows: [[String: Any]] = []) -> Bool {
        if environments.contains(where: { item in
            let kind = (item["kind"] as? String) ?? ""
            let id = (item["id"] as? String) ?? ""
            return kind == "ssh" || id.hasPrefix("ssh:")
        }) {
            return true
        }
        if let breakdown {
            if (breakdown["has_ssh_data"] as? Bool == true) || (breakdown["hasSshData"] as? Bool == true) {
                return true
            }
            if intVal(breakdown, "ssh_tokens", fallback: intVal(breakdown, "sshTokens")) > 0 {
                return true
            }
        }
        return rows.contains { row in
            let kind = (row["environment_kind"] as? String) ?? (row["environmentKind"] as? String) ?? ""
            let id = (row["environment_id"] as? String) ?? (row["environmentId"] as? String) ?? ""
            return kind == "ssh" || id.hasPrefix("ssh:")
        }
    }

    static func offlineSshHosts(environments: [[String: Any]], breakdown: [String: Any]?, report: [String: Any] = [:]) -> [String] {
        let summary = report["summary"] as? [String: Any]
        if let explicit = (breakdown?["offline_ssh_hosts"] as? [String])
            ?? (breakdown?["offlineSshHosts"] as? [String])
            ?? (report["offlineSshHosts"] as? [String])
            ?? (report["offline_ssh_hosts"] as? [String])
            ?? (summary?["offlineSshHosts"] as? [String])
            ?? (summary?["offline_ssh_hosts"] as? [String]) {
            return explicit.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        }
        var hosts: [String] = []
        for item in environments {
            let kind = (item["kind"] as? String) ?? ""
            let id = (item["id"] as? String) ?? ""
            guard kind == "ssh" || id.hasPrefix("ssh:") else { continue }
            guard (item["online"] as? Bool) == false else { continue }
            let rawHost = ((item["host_label"] as? String)
                ?? (item["hostLabel"] as? String)
                ?? (item["label"] as? String)
                ?? id).trimmingCharacters(in: .whitespacesAndNewlines)
            let cleaned = strippedSshPrefix(rawHost)
            if !cleaned.isEmpty && !hosts.contains(cleaned) {
                hosts.append(cleaned)
            }
        }
        return hosts
    }

    static func strippedSshPrefix(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["SSH: ", "SSH · ", "ssh: ", "ssh · "] {
            if trimmed.hasPrefix(prefix) {
                return String(trimmed.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return trimmed
    }

    static func environmentShareNote(breakdown: [String: Any]?, selectedEnvironmentId: String) -> String? {
        guard selectedEnvironmentId == "all", let breakdown else { return nil }
        let localTokens = intVal(breakdown, "local_tokens", fallback: intVal(breakdown, "localTokens"))
        let sshTokens = intVal(breakdown, "ssh_tokens", fallback: intVal(breakdown, "sshTokens"))
        let hasSsh = (breakdown["has_ssh_data"] as? Bool) ?? (breakdown["hasSshData"] as? Bool) ?? (sshTokens > 0)
        guard hasSsh else { return nil }
        let hasExplicitPct = breakdown["local_share_pct"] != nil || breakdown["localSharePct"] != nil
        let localPct: Int
        let sshPct: Int
        if hasExplicitPct {
            let rawLocal = doubleVal(breakdown, "local_share_pct", fallback: doubleVal(breakdown, "localSharePct"))
            let clampedLocal = max(0, min(100, Int(round(rawLocal))))
            localPct = clampedLocal
            if breakdown["ssh_share_pct"] != nil || breakdown["sshSharePct"] != nil {
                let rawSsh = doubleVal(breakdown, "ssh_share_pct", fallback: doubleVal(breakdown, "sshSharePct"))
                sshPct = max(0, min(100, Int(round(rawSsh))))
            } else {
                sshPct = 100 - clampedLocal
            }
        } else {
            let total = localTokens + sshTokens
            guard total > 0 else { return nil }
            localPct = max(0, min(100, Int(round((Double(localTokens) / Double(total)) * 100.0))))
            sshPct = 100 - localPct
        }
        guard localTokens + sshTokens > 0 || (localPct + sshPct > 0) else { return nil }
        return L10n.t("usage.env.share_note", ["localPct": localPct, "sshPct": sshPct])
    }

    static func displayTitleForEnvironment(id: String, item: [String: Any]?, allTitle: String, localTitle: String, sshFormatKey: String) -> String {
        let kind = (item?["kind"] as? String) ?? (id == "all" ? "all" : (id == "local" ? "local" : (id.hasPrefix("ssh:") ? "ssh" : "")))
        if id == "all" || kind == "all" {
            return allTitle
        }
        if id == "local" || kind == "local" {
            return localTitle
        }
        let rawHost = ((item?["host_label"] as? String)
            ?? (item?["hostLabel"] as? String)
            ?? (item?["label"] as? String)
            ?? id).trimmingCharacters(in: .whitespacesAndNewlines)
        let host = strippedSshPrefix(rawHost)
        let baseTitle = L10n.t(sshFormatKey, ["host": host.isEmpty ? id : host])
        if (item?["online"] as? Bool) == false {
            return L10n.t("usage.env.offline_suffix", ["label": baseTitle])
        }
        return baseTitle
    }

    static func extractUnattributedStats(from report: [String: Any]) -> (requests: Int, tokens: Int) {
        let summary = report["summary"] as? [String: Any] ?? [:]
        let reqs = intVal(
            report,
            "unattributedRequests",
            fallback: intVal(
                report,
                "unattributed_requests",
                fallback: intVal(summary, "unattributedRequests", fallback: intVal(summary, "unattributed_requests"))
            )
        )
        let toks = intVal(
            report,
            "unattributedTokens",
            fallback: intVal(
                report,
                "unattributed_tokens",
                fallback: intVal(summary, "unattributedTokens", fallback: intVal(summary, "unattributed_tokens"))
            )
        )
        return (max(0, reqs), max(0, toks))
    }

    static func buildEnvironmentItems(
        environments: [[String: Any]],
        selectedId: String,
        allTitle: String,
        localTitle: String,
        sshFormatKey: String
    ) -> [(id: String, title: String)] {
        var items: [(id: String, title: String)] = [("all", allTitle)]
        var seen = Set<String>(["all"])
        for env in environments {
            guard let rawId = env["id"] as? String else { continue }
            let id = rawId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, !seen.contains(id) else { continue }
            seen.insert(id)
            items.append((id, displayTitleForEnvironment(id: id, item: env, allTitle: allTitle, localTitle: localTitle, sshFormatKey: sshFormatKey)))
        }
        let normalizedSelected = selectedId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "all" : selectedId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !seen.contains(normalizedSelected) {
            items.append((normalizedSelected, displayTitleForEnvironment(id: normalizedSelected, item: nil, allTitle: allTitle, localTitle: localTitle, sshFormatKey: sshFormatKey)))
        }
        return items
    }

    static func syncEnvironmentPopup(
        _ popup: NSPopUpButton,
        environments: [[String: Any]],
        selectedId: String,
        allTitle: String,
        localTitle: String,
        sshFormatKey: String,
        maxWidth: CGFloat = 220
    ) {
        if !(popup.cell is DesignPopUpCell) {
            Design.applyControls(popup)
        }
        let normalizedSelected = selectedId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "all" : selectedId.trimmingCharacters(in: .whitespacesAndNewlines)
        if let cell = popup.cell as? DesignPopUpCell {
            if normalizedSelected == "local" {
                cell.leadingSymbolName = "desktopcomputer"
            } else if normalizedSelected.hasPrefix("ssh:") {
                cell.leadingSymbolName = "server.rack"
            } else {
                cell.leadingSymbolName = "square.stack.3d.up"
            }
        }
        let items = buildEnvironmentItems(
            environments: environments,
            selectedId: normalizedSelected,
            allTitle: allTitle,
            localTitle: localTitle,
            sshFormatKey: sshFormatKey
        )
        applyPopupItems(popup, items: items, selectedId: normalizedSelected, maxWidth: maxWidth)
    }

    static func syncAccountPopup(
        _ popup: NSPopUpButton,
        accounts: [[String: Any]],
        cachedAccounts: [[String: Any]] = [],
        selectedId: String,
        allTitle: String,
        unattributedRequests: Int = 0,
        unattributedTitle: String? = nil,
        maxWidth: CGFloat = 220
    ) {
        if !(popup.cell is DesignPopUpCell) {
            Design.applyControls(popup)
        }
        if let cell = popup.cell as? DesignPopUpCell {
            cell.leadingSymbolName = "person.crop.circle"
        }
        var items: [(id: String, title: String)] = [("all", allTitle)]
        var seen = Set<String>(["all"])
        let source = accounts.isEmpty ? cachedAccounts : accounts
        for acc in source {
            guard let rawId = (acc["id"] as? String) ?? (acc["email"] as? String) else { continue }
            let id = rawId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, !seen.contains(id) else { continue }
            seen.insert(id)
            let email = (acc["email"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let label = (acc["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let name = (acc["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let title = !email.isEmpty ? email : (!label.isEmpty ? label : (!name.isEmpty ? name : id))
            items.append((id, title))
        }
        let normalizedSelected = selectedId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "all" : selectedId.trimmingCharacters(in: .whitespacesAndNewlines)
        if (unattributedRequests > 0 || normalizedSelected == "unattributed") && !seen.contains("unattributed") {
            seen.insert("unattributed")
            items.append(("unattributed", unattributedTitle ?? L10n.t("usage.account.unattributed", fallback: "未关联账号")))
        }
        if !seen.contains(normalizedSelected) {
            items.append((normalizedSelected, normalizedSelected))
        }
        applyPopupItems(popup, items: items, selectedId: normalizedSelected, maxWidth: maxWidth)
    }

    private static func applyPopupItems(_ popup: NSPopUpButton, items: [(id: String, title: String)], selectedId: String, maxWidth: CGFloat) {
        popup.removeAllItems()
        for entry in items {
            let item = NSMenuItem(title: entry.title, action: nil, keyEquivalent: "")
            item.representedObject = entry.id
            popup.menu?.addItem(item)
        }
        if let idx = items.firstIndex(where: { $0.id == selectedId }) {
            popup.selectItem(at: idx)
        } else {
            popup.selectItem(at: 0)
        }
        let fitted = Design.syncPopUpWidth(popup)
        if let widthConstraint = popup.constraints.first(where: { $0.identifier == "design-control-width" }) {
            widthConstraint.constant = min(maxWidth, fitted)
        }
        if !popup.constraints.contains(where: { $0.identifier == "usage-popup-max-width" }) {
            let maxConstraint = popup.widthAnchor.constraint(lessThanOrEqualToConstant: maxWidth)
            maxConstraint.identifier = "usage-popup-max-width"
            maxConstraint.priority = NSLayoutConstraint.Priority(999)
            maxConstraint.isActive = true
        }
        popup.invalidateIntrinsicContentSize()
    }

    static func breakdownFingerprint(_ breakdown: [String: Any]?, environments: [[String: Any]]) -> String {
        let envSig = environments.map { env in
            let id = env["id"] as? String ?? ""
            let online = (env["online"] as? Bool).map { $0 ? "1" : "0" } ?? "?"
            return "\(id):\(online)"
        }.joined(separator: ",")
        let localT = breakdown.map { intVal($0, "local_tokens", fallback: intVal($0, "localTokens")) } ?? 0
        let sshT = breakdown.map { intVal($0, "ssh_tokens", fallback: intVal($0, "sshTokens")) } ?? 0
        let hasSsh = breakdown.map { (($0["has_ssh_data"] as? Bool) ?? ($0["hasSshData"] as? Bool) ?? (sshT > 0)) ? "1" : "0" } ?? "0"
        let offline = offlineSshHosts(environments: environments, breakdown: breakdown).joined(separator: ",")
        return "\(L10n.shared.currentLocale)|\(envSig)|\(hasSsh):\(localT):\(sshT):\(offline)"
    }
}

final class UsagePage: NSObject {
    unowned let app: Assistant
    let view: NSView

    let periodSegment = DesignSegmentedControl(labels: [L10n.t("usage.period.today"), L10n.t("usage.period.7d"), L10n.t("usage.period.30d"), L10n.t("usage.period.all")], trackingMode: .selectOne, target: nil, action: nil)
    let environmentSegment = DesignSegmentedControl(
        labels: [L10n.t("usage.env.all"), L10n.t("usage.env.local_label")],
        trackingMode: .selectOne,
        target: nil,
        action: nil,
        compact: false,
        equalWidthSegments: false,
        maxSegmentWidth: 185
    )
    private var environmentSegmentIds: [String] = ["all", "local"]
    let environmentPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let accountPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    let offlineSshBadge = pillBadge("", color: accessibleWarningColor())
    let filterBarRow: NSStackView
    let unattributedNoticeBox = DesignCardBox()
    let unattributedNoticeLabel = text("", size: 11.5, color: .secondaryLabelColor, wrap: true)
    let switchUnattributedButton = button(L10n.t("usage.account.switch_unattributed_btn", fallback: "查看未关联"), target: nil, action: #selector(switchToUnattributedPressed))
    let refreshButton: InlineRefreshButton
    let exportButton = button(L10n.t("usage.export_btn"), target: nil, action: #selector(exportUsage))

    // 顶部 4 张 KPI 指标卡
    let totalTokensMetric = metricValue()
    let tokensDetail = text(L10n.t("usage.tokens.placeholder"), size: 11, color: .secondaryLabelColor, wrap: true)
    let costTitle = text(L10n.t("usage.section.cost"), size: 12, weight: .semibold)
    let costStatusBadge = pillBadge("", color: accessibleWarningColor())
    let usdMetric = metricValue()
    let usdDetail = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let cacheRateMetric = metricValue()
    let cacheTrack = UsageCacheTrack()
    let requestDetailsButton = button(L10n.t("usage.request_details_btn"), target: nil, action: #selector(showLog))
    let cacheRateDetail = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let requestsMetric = metricValue()
    let requestsDetail = text("", size: 11, color: .secondaryLabelColor, wrap: true)

    // 中部可视化图表
    let trendTitleLabel = text(L10n.t("usage.trend_title.today"), size: 13.5, weight: .semibold)
    let trendChart = UsageTrendChartView()
    let donutChart = ModelDonutChartView()
    let donutLegendStack = NSStackView()

    // Model summaries share the same card surface as the rest of the application.
    let modelsBreakdownStack = NSStackView()
    let modelsCountLabel = text("", size: 11.5, color: .secondaryLabelColor)

    let statusSummary = text("", size: 11.5, color: .secondaryLabelColor, wrap: true)
    let footerBox = DesignCardBox()

    var latestReport: [String: Any] = [:]
    var logController: UsageLogController?
    var loading = false
    private var requestGeneration: Int = 0
    var selectedEnvironmentId: String = "all"
    var selectedAccountId: String = "all"
    private var availableEnvironments: [[String: Any]] = []
    private var availableAccounts: [[String: Any]] = []
    private var cachedUnattributedRequests: Int = 0
    private var cachedUnattributedTokens: Int = 0
    // E02: 与总览页一致的 15s 节流指纹，避免每次 3s tick 都重拉 usage_summary 并重建图表。
    var metricsKey = ""
    private var renderedSnapshotKey = ""
    private var restoreScroll = true
    var lastFetchTime: Date = .distantPast
    var modelRows: [[String: Any]] = []
    let periods = ["today", "7d", "30d", "all"]
    let palette: [NSColor] = [
        Design.color(0x2563EB, 0x3B82F6),
        Design.color(0x0D9488, 0x2DD4BF),
        Design.color(0x7C3AED, 0xA78BFA),
        Design.color(0xD97706, 0xFBBF24),
        Design.color(0x4F46E5, 0x818CF8),
        Design.color(0xDB2777, 0xF472B6)
    ]

    init(app: Assistant) {
        self.app = app
        let initialEnv = app.usageSelectedEnvironment.trimmingCharacters(in: .whitespacesAndNewlines)
        self.selectedEnvironmentId = initialEnv.isEmpty ? "all" : initialEnv
        let initialAcc = app.usageSelectedAccount.trimmingCharacters(in: .whitespacesAndNewlines)
        self.selectedAccountId = initialAcc.isEmpty ? "all" : initialAcc
        refreshButton = InlineRefreshButton(L10n.t("common.refresh"), width: 76, target: nil, action: #selector(refreshUsage))
        periodSegment.selectedSegment = app.usageSelectedPeriod
        periodSegment.controlSize = .regular
        periodSegment.setAccessibilityLabel(L10n.t("usage.period_a11y"))
        periodSegment.translatesAutoresizingMaskIntoConstraints = false
        periodSegment.heightAnchor.constraint(equalToConstant: 28).isActive = true

        environmentSegment.setAccessibilityLabel(L10n.t("usage.env.a11y"))
        environmentSegment.translatesAutoresizingMaskIntoConstraints = false
        environmentSegment.heightAnchor.constraint(equalToConstant: 28).isActive = true
        environmentSegment.setContentHuggingPriority(.required, for: .horizontal)
        environmentSegment.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)

        environmentPopup.controlSize = .regular
        environmentPopup.setAccessibilityLabel(L10n.t("usage.env.a11y"))
        environmentPopup.setContentHuggingPriority(.required, for: .horizontal)
        environmentPopup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        environmentPopup.isHidden = true

        accountPopup.controlSize = .regular
        accountPopup.setAccessibilityLabel(L10n.t("usage.account.a11y"))
        accountPopup.setContentHuggingPriority(.required, for: .horizontal)
        accountPopup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        offlineSshBadge.label.font = .systemFont(ofSize: 10.5, weight: .semibold)
        offlineSshBadge.isHidden = true
        offlineSshBadge.toolTip = nil
        offlineSshBadge.setContentHuggingPriority(.required, for: .horizontal)
        offlineSshBadge.setContentCompressionResistancePriority(.required, for: .horizontal)

        filterBarRow = horizontal([environmentSegment, environmentPopup, accountPopup, offlineSshBadge, flexibleSpace()], spacing: 8)
        filterBarRow.alignment = .centerY
        filterBarRow.detachesHiddenViews = true
        filterBarRow.identifier = NSUserInterfaceItemIdentifier("usage-filter-bar")
        filterBarRow.isHidden = (selectedEnvironmentId == "all")

        let noticeIcon = symbol("info.circle.fill", size: 13, color: Design.blue)
        noticeIcon.setContentHuggingPriority(.required, for: .horizontal)
        unattributedNoticeLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        unattributedNoticeLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        switchUnattributedButton.controlSize = .small
        switchUnattributedButton.setContentHuggingPriority(.required, for: .horizontal)
        switchUnattributedButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        let noticeRow = horizontal([noticeIcon, unattributedNoticeLabel, flexibleSpace(), switchUnattributedButton], spacing: 8)
        noticeRow.alignment = .centerY
        unattributedNoticeBox.boxType = .custom
        unattributedNoticeBox.cornerRadius = 10
        unattributedNoticeBox.borderWidth = 0.75
        unattributedNoticeBox.borderColor = Design.dynamicAlpha(Design.blue, 0.22, 0.30)
        unattributedNoticeBox.fillColor = Design.dynamicAlpha(Design.blue, 0.05, 0.09)
        unattributedNoticeBox.enablesHoverHighlight = false
        unattributedNoticeBox.addSubview(noticeRow)
        noticeRow.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            noticeRow.leadingAnchor.constraint(equalTo: unattributedNoticeBox.leadingAnchor, constant: 12),
            noticeRow.trailingAnchor.constraint(equalTo: unattributedNoticeBox.trailingAnchor, constant: -12),
            noticeRow.topAnchor.constraint(equalTo: unattributedNoticeBox.topAnchor, constant: 9),
            noticeRow.bottomAnchor.constraint(equalTo: unattributedNoticeBox.bottomAnchor, constant: -9)
        ])
        unattributedNoticeBox.isHidden = true

        let headerActions = horizontal([periodSegment, refreshButton, exportButton], spacing: 8)
        headerActions.alignment = .centerY
        let root = pageStack(title: L10n.t("usage.title"), actions: headerActions)
        root.spacing = Design.Spacing.roomy
        root.detachesHiddenViews = true
        root.addArrangedSubview(filterBarRow)
        root.addArrangedSubview(unattributedNoticeBox)
        totalTokensMetric.font = .monospacedDigitSystemFont(ofSize: 30, weight: .semibold)
        let trendHeader = horizontal([vertical([text(L10n.t("usage.section.token_usage"), size: 11, color: Design.secondary), totalTokensMetric, tokensDetail], spacing: 6), flexibleSpace(), trendTitleLabel])
        let trend = vertical([trendHeader, trendChart], spacing: 12)
        fillWidth(trendHeader, in: trend); fillWidth(trendChart, in: trend)
        root.addArrangedSubview(group([trend]))
        costTitle.font = .systemFont(ofSize: 13, weight: .semibold)
        costTitle.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        costStatusBadge.label.font = .systemFont(ofSize: 10, weight: .semibold)
        costStatusBadge.isHidden = true
        costStatusBadge.setContentHuggingPriority(.required, for: .horizontal)
        costStatusBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        usdMetric.font = .monospacedDigitSystemFont(ofSize: 24, weight: .semibold)
        usdMetric.setContentCompressionResistancePriority(.required, for: .horizontal)
        donutLegendStack.orientation = .vertical; donutLegendStack.alignment = .leading; donutLegendStack.spacing = 5
        donutLegendStack.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let costHeading = horizontal([costTitle, costStatusBadge, flexibleSpace(), usdMetric], spacing: 8)
        costHeading.alignment = .centerY
        costHeading.detachesHiddenViews = true
        costHeading.heightAnchor.constraint(equalToConstant: 28).isActive = true
        let donutBody = horizontal([donutChart, donutLegendStack], spacing: 10)
        donutBody.alignment = .centerY
        donutLegendStack.translatesAutoresizingMaskIntoConstraints = false
        donutLegendStack.widthAnchor.constraint(equalTo: donutBody.widthAnchor, constant: -114).isActive = true
        let donutBodyHost = NSView()
        donutBodyHost.translatesAutoresizingMaskIntoConstraints = false
        donutBodyHost.setContentHuggingPriority(NSLayoutConstraint.Priority(200), for: .vertical)
        donutBodyHost.addSubview(donutBody)
        let donutBodyTight = donutBodyHost.heightAnchor.constraint(equalTo: donutBody.heightAnchor)
        donutBodyTight.priority = NSLayoutConstraint.Priority(210)
        NSLayoutConstraint.activate([
            donutBody.leadingAnchor.constraint(equalTo: donutBodyHost.leadingAnchor),
            donutBody.trailingAnchor.constraint(equalTo: donutBodyHost.trailingAnchor),
            donutBody.centerYAnchor.constraint(equalTo: donutBodyHost.centerYAnchor),
            donutBody.topAnchor.constraint(greaterThanOrEqualTo: donutBodyHost.topAnchor),
            donutBody.bottomAnchor.constraint(lessThanOrEqualTo: donutBodyHost.bottomAnchor),
            donutBodyTight
        ])
        usdDetail.isHidden = true
        let donutContent = vertical([costHeading, divider(), donutBodyHost, usdDetail], spacing: 12)
        donutContent.detachesHiddenViews = true
        for row in donutContent.arrangedSubviews { fillWidth(row, in: donutContent) }

        requestsMetric.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
        cacheRateMetric.font = .monospacedDigitSystemFont(ofSize: 20, weight: .semibold)
        requestDetailsButton.controlSize = .small
        let requestHeading = horizontal([text(L10n.t("usage.section.requests_cache"), size: 13, weight: .semibold), flexibleSpace(), requestDetailsButton], spacing: 8)
        requestHeading.alignment = .centerY
        requestHeading.heightAnchor.constraint(equalToConstant: 28).isActive = true
        let requestLeft = vertical([text(L10n.t("usage.section.total_requests"), size: 11.5, weight: .medium, color: .labelColor), requestsDetail], spacing: 3)
        let requestStats = horizontal([requestLeft, flexibleSpace(), requestsMetric], spacing: 10)
        requestStats.alignment = .centerY
        let cacheLeft = vertical([text(L10n.t("usage.section.cache_hit_rate"), size: 11.5, weight: .medium, color: .labelColor), cacheRateDetail], spacing: 2)
        let cacheHeading = horizontal([cacheLeft, flexibleSpace(), cacheRateMetric], spacing: 10)
        cacheHeading.alignment = .centerY
        let cacheStats = vertical([cacheHeading, cacheTrack], spacing: 8)
        fillWidth(cacheHeading, in: cacheStats); fillWidth(cacheTrack, in: cacheStats)

        // 当左侧费用卡因 5 行图例变高时，将额外纵向空间对称平分给「请求总数」与「缓存命中率」两个区块的上下留白，消除底部大块空白
        func makeBalancedSlot(for content: NSView) -> (host: NSView, padGuide: NSLayoutGuide) {
            let host = NSView()
            host.translatesAutoresizingMaskIntoConstraints = false
            host.setContentHuggingPriority(NSLayoutConstraint.Priority(200), for: .vertical)
            let topPad = NSLayoutGuide()
            let bottomPad = NSLayoutGuide()
            host.addLayoutGuide(topPad)
            host.addLayoutGuide(bottomPad)
            host.addSubview(content)
            content.translatesAutoresizingMaskIntoConstraints = false
            let zeroPad = topPad.heightAnchor.constraint(equalToConstant: 0)
            zeroPad.priority = NSLayoutConstraint.Priority(210)
            NSLayoutConstraint.activate([
                topPad.topAnchor.constraint(equalTo: host.topAnchor),
                content.topAnchor.constraint(equalTo: topPad.bottomAnchor),
                bottomPad.topAnchor.constraint(equalTo: content.bottomAnchor),
                bottomPad.bottomAnchor.constraint(equalTo: host.bottomAnchor),
                topPad.heightAnchor.constraint(equalTo: bottomPad.heightAnchor),
                content.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                zeroPad
            ])
            return (host, topPad)
        }
        let requestSlot = makeBalancedSlot(for: requestStats)
        let cacheSlot = makeBalancedSlot(for: cacheStats)

        let requestContent = vertical([requestHeading, divider(), requestSlot.host, divider(), cacheSlot.host], spacing: 12)
        for row in requestContent.arrangedSubviews { fillWidth(row, in: requestContent) }
        requestSlot.padGuide.heightAnchor.constraint(equalTo: cacheSlot.padGuide.heightAnchor).isActive = true
        let costCard = group([donutContent], inset: 15); let requestCard = group([requestContent], inset: 15); requestCard.identifier = NSUserInterfaceItemIdentifier("requests-cache-card")
        let middle = horizontal([costCard, requestCard], spacing: 12); middle.distribution = .fill; middle.alignment = .top
        costCard.heightAnchor.constraint(equalTo: requestCard.heightAnchor).isActive = true
        costCard.widthAnchor.constraint(equalTo: requestCard.widthAnchor, multiplier: 1.12).isActive = true
        root.addArrangedSubview(middle)
        modelsBreakdownStack.orientation = .vertical; modelsBreakdownStack.alignment = .leading; modelsBreakdownStack.spacing = 14
        modelsBreakdownStack.identifier = NSUserInterfaceItemIdentifier("model-usage-list")
        let breakdown = vertical([horizontal([text(L10n.t("usage.section.model_breakdown"), size: 13, weight: .semibold), flexibleSpace(), modelsCountLabel]), modelsBreakdownStack], spacing: 16)
        for row in breakdown.arrangedSubviews { fillWidth(row, in: breakdown) }
        let footerRow = horizontal([statusSummary], spacing: 8)
        footerRow.alignment = .centerY
        footerBox.boxType = .custom
        footerBox.cornerRadius = 10
        footerBox.borderWidth = 0.5
        footerBox.borderColor = Design.border
        footerBox.fillColor = Design.subcard
        footerBox.contentViewMargins = NSSize(width: 12, height: 10)
        footerBox.addSubview(footerRow)
        footerRow.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            footerRow.leadingAnchor.constraint(equalTo: footerBox.leadingAnchor, constant: 12),
            footerRow.trailingAnchor.constraint(equalTo: footerBox.trailingAnchor, constant: -12),
            footerRow.topAnchor.constraint(equalTo: footerBox.topAnchor, constant: 10),
            footerRow.bottomAnchor.constraint(equalTo: footerBox.bottomAnchor, constant: -10)
        ])
        footerBox.isHidden = true
        root.addArrangedSubview(group([breakdown])); root.addArrangedSubview(footerBox)

        view = scrollPage(root)
        super.init()

        exportButton.target = self
        environmentSegment.target = self
        environmentSegment.action = #selector(environmentSegmentChanged(_:))
        environmentPopup.target = self
        environmentPopup.action = #selector(environmentChanged(_:))
        accountPopup.target = self
        accountPopup.action = #selector(accountChanged(_:))
        switchUnattributedButton.target = self
        UsageFilterSupport.syncEnvironmentPopup(
            environmentPopup,
            environments: [],
            selectedId: selectedEnvironmentId,
            allTitle: L10n.t("usage.env.all"),
            localTitle: L10n.t("usage.env.local_label"),
            sshFormatKey: "usage.env.ssh_label"
        )
        UsageFilterSupport.syncAccountPopup(
            accountPopup,
            accounts: [],
            selectedId: selectedAccountId,
            allTitle: L10n.t("usage.account.all")
        )
        func connect(_ view: NSView) { if let control = view as? NSButton, control.target == nil { control.target = self }; for child in view.subviews { connect(child) } }; connect(view)
        refreshButton.target = self
        periodSegment.target = self
        periodSegment.action = #selector(periodChanged(_:))

        fetch()
    }

    private func syncEnvironmentControlSelections(to normalized: String) {
        if let menuIdx = environmentPopup.menu?.items.firstIndex(where: { ($0.representedObject as? String) == normalized }) {
            environmentPopup.selectItem(at: menuIdx)
        }
        if let segIdx = environmentSegmentIds.firstIndex(of: normalized) {
            environmentSegment.selectedSegment = segIdx
        }
    }

    func applyExternalFilter(period: Int? = nil, environmentId: String? = nil) {
        if let period {
            let clamped = max(0, min(periods.count - 1, period))
            periodSegment.selectedSegment = clamped
            app.usageSelectedPeriod = clamped
        }
        if let environmentId {
            let trimmed = environmentId.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = trimmed.isEmpty ? "all" : trimmed
            selectedEnvironmentId = normalized
            app.usageSelectedEnvironment = normalized
            syncEnvironmentControlSelections(to: normalized)
        }
        renderedSnapshotKey = ""
        fetch(force: false, interruptInFlight: true)
    }

    @objc func periodChanged(_ sender: DesignSegmentedControl) {
        app.usageSelectedPeriod = sender.selectedSegment
        fetch(force: false, interruptInFlight: true)
    }

    @objc func environmentSegmentChanged(_ sender: DesignSegmentedControl) {
        let idx = sender.selectedSegment
        guard environmentSegmentIds.indices.contains(idx) else { return }
        let normalized = environmentSegmentIds[idx]
        guard normalized != selectedEnvironmentId else { return }
        selectedEnvironmentId = normalized
        app.usageSelectedEnvironment = normalized
        syncEnvironmentControlSelections(to: normalized)
        renderedSnapshotKey = ""
        fetch(force: false, interruptInFlight: true)
    }

    @objc func environmentChanged(_ sender: NSPopUpButton) {
        let next = ((sender.selectedItem?.representedObject as? String) ?? "all").trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = next.isEmpty ? "all" : next
        guard normalized != selectedEnvironmentId else { return }
        selectedEnvironmentId = normalized
        app.usageSelectedEnvironment = normalized
        syncEnvironmentControlSelections(to: normalized)
        renderedSnapshotKey = ""
        fetch(force: false, interruptInFlight: true)
    }

    @objc func accountChanged(_ sender: NSPopUpButton) {
        let next = ((sender.selectedItem?.representedObject as? String) ?? "all").trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = next.isEmpty ? "all" : next
        guard normalized != selectedAccountId else { return }
        selectedAccountId = normalized
        app.usageSelectedAccount = normalized
        renderedSnapshotKey = ""
        fetch(force: false, interruptInFlight: true)
    }

    @objc func switchToUnattributedPressed() {
        selectedAccountId = "unattributed"
        app.usageSelectedAccount = "unattributed"
        if let idx = accountPopup.menu?.items.firstIndex(where: { ($0.representedObject as? String) == "unattributed" }) {
            accountPopup.selectItem(at: idx)
        }
        renderedSnapshotKey = ""
        fetch(force: false, interruptInFlight: true)
    }

    @objc func refreshUsage() {
        guard !loading else { return }
        fetch(force: true)
    }

    /// E02: 仅在数据/时间范围/任务状态变化或距上次刷新 ≥15s 时重新拉取；hover 与滚动不再每 3 秒被打断。
    func update(force: Bool = false) {
        guard !loading else { return }
        let key = metricsKeyForCurrentPeriod()
        let timeExpired = Date().timeIntervalSince(lastFetchTime) >= 15.0
        if !force && !timeExpired && key == metricsKey { return }
        fetch(force: force)
    }

    private func metricsKeyForCurrentPeriod() -> String {
        let segIdx = max(0, min(periods.count - 1, periodSegment.selectedSegment))
        return "\(periods[segIdx])_\(selectedEnvironmentId)_\(selectedAccountId)_\(app.activeAccountId)_\(app.statusValue.activeAccountEmail)_\(app.statusValue.remoteSyncRevision)_\(app.reachable)"
    }

    private func formatCompactTokens(_ count: Int) -> String {
        InterfaceText.formatCompactTokens(count, formatSmallWithLocale: true)
    }

    /// F14: one currency format everywhere on the usage surfaces.
    private func formatUsd(_ value: Double) -> String {
        InterfaceText.formatUsd(value)
    }

    private func syncExportButtonState(for period: String, environmentId: String? = nil, accountId: String? = nil) {
        let envId = environmentId ?? selectedEnvironmentId
        let accId = accountId ?? selectedAccountId
        let summary = latestReport["summary"] as? [String: Any] ?? [:]
        exportButton.isEnabled = !loading
            && UsageQueryIdentity(period: period, environmentId: envId, accountId: accId).matches(latestReport)
            && latestReport["snapshotId"] != nil
            && (summary["availability"] as? String) != "unavailable"
    }

    func fetch(force: Bool = false, interruptInFlight: Bool = false) {
        if loading && !interruptInFlight { return }
        let requestKey = metricsKeyForCurrentPeriod()
        let segIdx = max(0, min(periods.count - 1, periodSegment.selectedSegment))
        let period = periods[segIdx]
        let requestedEnv = selectedEnvironmentId
        let requestedAcc = selectedAccountId
        let isDefaultAllFilter = (requestedEnv == "all" && requestedAcc == "all")
        let cacheKey = isDefaultAllFilter ? period : "\(period)|env=\(requestedEnv)|acc=\(requestedAcc)"
        let identity = UsageQueryIdentity(period: period, environmentId: requestedEnv, accountId: requestedAcc)
        trendTitleLabel.stringValue = segIdx == 0 ? L10n.t("usage.trend_title.today") : (segIdx == 1 ? L10n.t("usage.trend_title.7d") : (segIdx == 2 ? L10n.t("usage.trend_title.30d") : L10n.t("usage.trend_title.all")))
        if !force, let preloaded = app.cachedUsageReportsByPeriod[cacheKey], !identity.matches(latestReport), identity.matches(preloaded) {
            applyUsagePayload(preloaded, period: period, segIdx: segIdx, requestKey: requestKey, environmentId: requestedEnv, accountId: requestedAcc)
        }
        requestGeneration += 1
        let gen = requestGeneration
        loading = true
        refreshButton.setBusy(true, available: app.reachable)
        exportButton.isEnabled = false

        app.fetchUsageSummary(period: period, environmentId: requestedEnv, accountId: requestedAcc, force: force, allowCached: !force) { [weak self] response in
            guard let self else { return }
            guard gen == self.requestGeneration else { return }
            self.loading = false
            self.refreshButton.setBusy(false, available: self.app.reachable)
            self.lastFetchTime = Date()
            let currentPeriod = self.periods[max(0, min(self.periods.count - 1, self.periodSegment.selectedSegment))]
            if currentPeriod != period || self.selectedEnvironmentId != requestedEnv || self.selectedAccountId != requestedAcc {
                self.fetch(force: force, interruptInFlight: true)
                return
            }
            switch response {
            case .failure(let error):
                // 失败同样进入 15s 退避，避免每个 3s tick 反复请求。
                self.metricsKey = requestKey
                self.syncExportButtonState(for: period, environmentId: requestedEnv, accountId: requestedAcc)
                let oldPeriod = self.latestReport["period"] as? String ?? ""
                self.statusSummary.stringValue = L10n.t("usage.error.read_keep_cached", ["period": oldPeriod, "error": error.localizedDescription])
                self.statusSummary.textColor = accessibleWarningColor()
                self.footerBox.isHidden = false
            case .success(let value):
                self.applyUsagePayload(value, period: period, segIdx: segIdx, requestKey: requestKey, environmentId: requestedEnv, accountId: requestedAcc)
            }
        }
    }

    private func updateFilterBar(from value: [String: Any]) {
        let envs = UsageFilterSupport.extractAvailableEnvironments(from: value)
        let accounts = UsageFilterSupport.extractAvailableAccounts(from: value)
        let breakdown = UsageFilterSupport.extractEnvironmentBreakdown(from: value)
        let unattributedStats = UsageFilterSupport.extractUnattributedStats(from: value)
        self.availableEnvironments = envs
        self.availableAccounts = accounts
        self.cachedUnattributedRequests = unattributedStats.requests
        self.cachedUnattributedTokens = unattributedStats.tokens
        let hasSsh = UsageFilterSupport.hasSshEnvironment(environments: envs, breakdown: breakdown)
        if !hasSsh && selectedEnvironmentId != "all" {
            let stillExists = envs.contains { ($0["id"] as? String) == selectedEnvironmentId }
            if !stillExists && envs.isEmpty == false {
                selectedEnvironmentId = "all"
                app.usageSelectedEnvironment = "all"
            }
        }
        let allEnvTitle = L10n.t("usage.env.all")
        let localEnvTitle = L10n.t("usage.env.local_label")
        UsageFilterSupport.syncEnvironmentPopup(
            environmentPopup,
            environments: envs,
            selectedId: selectedEnvironmentId,
            allTitle: allEnvTitle,
            localTitle: localEnvTitle,
            sshFormatKey: "usage.env.ssh_label"
        )
        let envItems = UsageFilterSupport.buildEnvironmentItems(
            environments: envs,
            selectedId: selectedEnvironmentId,
            allTitle: allEnvTitle,
            localTitle: localEnvTitle,
            sshFormatKey: "usage.env.ssh_label"
        )
        let useSegmentEnv = envItems.count <= 4
        if useSegmentEnv {
            environmentSegmentIds = envItems.map(\.id)
            let segIdx = environmentSegmentIds.firstIndex(of: selectedEnvironmentId) ?? 0
            environmentSegment.updateSegments(
                labels: envItems.map(\.title),
                selectedIndex: segIdx,
                animated: Design.shouldAnimate(in: environmentSegment)
            )
            environmentSegment.isHidden = false
            environmentPopup.isHidden = true
        } else {
            environmentSegment.isHidden = true
            environmentPopup.isHidden = false
        }
        UsageFilterSupport.syncAccountPopup(
            accountPopup,
            accounts: accounts,
            selectedId: selectedAccountId,
            allTitle: L10n.t("usage.account.all"),
            unattributedRequests: unattributedStats.requests,
            unattributedTitle: L10n.t("usage.account.unattributed")
        )
        let offlineHosts = UsageFilterSupport.offlineSshHosts(environments: envs, breakdown: breakdown, report: value)
        if offlineHosts.isEmpty {
            offlineSshBadge.isHidden = true
            offlineSshBadge.toolTip = nil
            offlineSshBadge.setAccessibilityHelp(nil)
        } else {
            let hostsJoined = offlineHosts.joined(separator: L10n.shared.isEnglish ? ", " : "、")
            offlineSshBadge.title = L10n.t("usage.env.offline_badge", ["count": offlineHosts.count])
            offlineSshBadge.tint = accessibleWarningColor()
            let tip = L10n.t("usage.env.offline_tooltip", ["hosts": hostsJoined])
            offlineSshBadge.toolTip = tip
            offlineSshBadge.setAccessibilityHelp(tip)
            offlineSshBadge.isHidden = false
        }
        filterBarRow.isHidden = !(hasSsh || selectedEnvironmentId != "all")
    }

    private func syncUnattributedNotice(selectedEnv: String, selectedAcc: String, periodTokens: Int, periodRequests: Int, available: Bool = true) {
        let shouldShow = available
            && (selectedAcc != "all" && selectedAcc != "unattributed")
            && periodTokens == 0
            && periodRequests == 0
            && cachedUnattributedRequests > 0
        if shouldShow {
            let tokStr = InterfaceText.formatCompactTokens(cachedUnattributedTokens, formatSmallWithLocale: true)
            unattributedNoticeLabel.stringValue = L10n.t(
                "usage.account.unattributed_hint",
                ["requests": cachedUnattributedRequests, "tokens": tokStr]
            )
            switchUnattributedButton.title = L10n.t("usage.account.switch_unattributed_btn")
            unattributedNoticeBox.isHidden = false
        } else {
            unattributedNoticeBox.isHidden = true
        }
        let _ = selectedEnv
    }

    func applyUsagePayload(_ value: [String: Any], period: String, segIdx: Int, requestKey: String, environmentId: String? = nil, accountId: String? = nil) {
        let expectedEnv = environmentId ?? selectedEnvironmentId
        let expectedAcc = accountId ?? selectedAccountId
        guard UsageQueryIdentity(period: period, environmentId: expectedEnv, accountId: expectedAcc).matches(value) else {
            self.statusSummary.stringValue = L10n.t("usage.error.period_mismatch")
            self.statusSummary.textColor = accessibleWarningColor()
            self.footerBox.isHidden = false
            self.exportButton.isEnabled = false
            self.unattributedNoticeBox.isHidden = true
            return
        }
        self.metricsKey = requestKey
        self.latestReport = value
        let summary = value["summary"] as? [String: Any] ?? [:]
        // Request state is independent of chart identity: a successful retry must
        // clear the old error even when the data snapshot itself did not change.
        self.updateReadStatus(summary)
        self.updateFilterBar(from: value)
        let envs = UsageFilterSupport.extractAvailableEnvironments(from: value)
        let breakdown = UsageFilterSupport.extractEnvironmentBreakdown(from: value)
        let total = intVal(summary, "totalTokens")
        let reqsForNotice = intVal(summary, "requestCount")
        let isUnavailable = (summary["availability"] as? String) == "unavailable"
        self.syncUnattributedNotice(selectedEnv: expectedEnv, selectedAcc: expectedAcc, periodTokens: total, periodRequests: reqsForNotice, available: !isUnavailable)
        let envFingerprint = UsageFilterSupport.breakdownFingerprint(breakdown, environments: envs)
        let snapshotKey = "\(value["snapshotId"] ?? ""):\(period):\(expectedEnv):\(expectedAcc):\(summary["availability"] ?? ""):\(summary["failedDatabasesCount"] ?? 0):\(summary["skippedLargeRecords"] ?? 0):\(summary["unknownTimeRecords"] ?? 0):\(total):\(cachedUnattributedRequests):\(envFingerprint)"
        if !snapshotKey.hasPrefix(":") && snapshotKey == self.renderedSnapshotKey {
            self.syncExportButtonState(for: period, environmentId: expectedEnv, accountId: expectedAcc)
            return
        }
        self.renderedSnapshotKey = snapshotKey
        self.syncExportButtonState(for: period, environmentId: expectedEnv, accountId: expectedAcc)
        if isUnavailable {
            for label in [self.totalTokensMetric, self.usdMetric, self.cacheRateMetric, self.requestsMetric] { label.stringValue = "—" }
            self.costStatusBadge.isHidden = true
            self.tokensDetail.stringValue = L10n.t("usage.unavailable.tokens")
            self.usdDetail.stringValue = L10n.t("usage.unavailable.cost")
            self.usdDetail.textColor = .secondaryLabelColor
            self.usdDetail.isHidden = false
            self.requestsDetail.stringValue = L10n.t("usage.unavailable.requests")
            self.cacheRateDetail.stringValue = L10n.t("usage.unavailable.cache")
            self.cacheTrack.update(percent: 0)
            self.modelRows = []; self.trendChart.points = []; self.donutChart.slices = []
            self.donutChart.isHidden = true
            self.modelsCountLabel.stringValue = ""
            self.modelsBreakdownStack.arrangedSubviews.forEach { self.modelsBreakdownStack.removeArrangedSubview($0); $0.removeFromSuperview() }
            self.statusSummary.stringValue = L10n.t("usage.unavailable.banner"); self.statusSummary.textColor = accessibleWarningColor(); self.footerBox.isHidden = false
            return
        }
        let prompt = intVal(summary, "promptTokens")
        let output = intVal(summary, "candidatesTokens")
        let cached = intVal(summary, "cachedTokens")
        let cacheWrite = intVal(summary, "cacheWriteTokens", fallback: intVal(summary, "cache_write_tokens"))
        let requests = intVal(summary, "requestCount")
        let usd = doubleVal(summary, "estimatedUsd")
        let cacheDenom = prompt + cached + cacheWrite
        let cacheHit = doubleVal(summary, "cacheHitRate", fallback: cacheDenom > 0 ? (Double(cached) / Double(cacheDenom)) * 100.0 : 0.0)

        self.totalTokensMetric.stringValue = self.formatCompactTokens(total)
        let cacheWritePart = cacheWrite > 0 ? L10n.t("usage.tokens.cache_write_part", ["count": self.formatCompactTokens(cacheWrite)]) : ""
        let baseTokensSummary = L10n.t("usage.tokens.summary", [
            "input": self.formatCompactTokens(prompt),
            "cached": self.formatCompactTokens(cached),
            "cacheWrite": cacheWritePart,
            "output": self.formatCompactTokens(output)
        ])
        if let shareNote = UsageFilterSupport.environmentShareNote(breakdown: breakdown, selectedEnvironmentId: expectedEnv) {
            self.tokensDetail.stringValue = "\(baseTokensSummary) · \(shareNote)"
        } else {
            self.tokensDetail.stringValue = baseTokensSummary
        }
        let pricedCount = (summary["pricedModels"] as? Int) ?? (summary["priced_models"] as? Int) ?? (value["pricedModels"] as? Int) ?? 0
        let unpricedCount = (summary["unpricedModels"] as? Int) ?? (summary["unpriced_models"] as? Int) ?? (value["unpricedModels"] as? Int) ?? 0
        self.costTitle.stringValue = L10n.t("usage.section.cost")
        let isAllUnpriced = unpricedCount > 0 && pricedCount == 0 && usd == 0
        let isPartialCost = unpricedCount > 0 && !isAllUnpriced
        self.usdMetric.stringValue = isAllUnpriced ? L10n.t("menu_panel.usage.unpriced") : self.formatUsd(usd)
        self.costStatusBadge.isHidden = !isPartialCost
        if isPartialCost {
            self.costStatusBadge.title = L10n.t("usage.cost.partial_badge")
            self.costStatusBadge.tint = accessibleWarningColor()
        }
        self.usdDetail.stringValue = ""
        self.usdDetail.isHidden = true

        self.cacheRateMetric.stringValue = String(format: "%.1f%%", locale: Locale(identifier: "en_US_POSIX"), cacheHit)
        self.cacheTrack.update(percent: cacheHit)
        self.cacheRateDetail.stringValue = L10n.t("usage.cache.read_detail", ["count": self.formatCompactTokens(cached)])

        self.requestsMetric.stringValue = L10n.t("usage.requests.value", ["count": InterfaceText.formatInteger(requests)])
        let avgIn = requests > 0 ? total / requests : 0
        self.requestsDetail.stringValue = requests > 0 ? L10n.t("usage.requests.avg_per_call", ["count": self.formatCompactTokens(avgIn)]) : L10n.t("usage.requests.none")

        self.updateReadStatus(summary)

        let priceRows = ModelUsageFold.foldThinkingVariants(value["byModel"] as? [[String: Any]] ?? [])
        let outdated = priceRows.filter { ($0["pricingStatus"] as? String ?? "") == "expired" }.count
        var costNotes: [String] = []
        if unpricedCount > 0 {
            costNotes.append(L10n.t("usage.cost.unpriced_models_note", ["count": unpricedCount]))
        }
        if outdated > 0 {
            costNotes.append(L10n.t("usage.cost.outdated_models", ["count": outdated]))
        }
        if !costNotes.isEmpty {
            self.usdDetail.stringValue = costNotes.joined(separator: " · ")
            self.usdDetail.textColor = accessibleWarningColor()
            self.usdDetail.isHidden = false
        } else {
            self.usdDetail.textColor = .secondaryLabelColor
            self.usdDetail.isHidden = true
        }
        let rows = ModelUsageFold.foldThinkingVariants((value["byModel"] as? [[String: Any]]) ?? (value["models"] as? [[String: Any]]) ?? [])
        self.modelRows = rows
        let scroll = self.view as? NSScrollView
        let preservedOrigin = self.restoreScroll ? self.app.usageScrollOrigin : (scroll?.contentView.bounds.origin ?? .zero)
        self.restoreScroll = false
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0
            ctx.allowsImplicitAnimation = false
            self.updateChartsAndBreakdown(summary: summary, value: value, segIdx: segIdx, totalTokens: total, totalUsd: usd)
            scroll?.layoutSubtreeIfNeeded()
            if let scroll {
                let maxY = max(0, (scroll.documentView?.bounds.height ?? 0) - scroll.contentView.bounds.height)
                let clampedY = max(0, min(preservedOrigin.y, maxY))
                scroll.contentView.scroll(to: NSPoint(x: 0, y: clampedY))
                scroll.reflectScrolledClipView(scroll.contentView)
            }
        }
    }

    func updateReadStatus(_ summary: [String: Any]) {
        let failed = intVal(summary, "failedDatabasesCount", fallback: intVal(summary, "failed_databases_count"))
        let skipped = intVal(summary, "skippedLargeRecords", fallback: intVal(summary, "skipped_large_records"))
        let unknown = intVal(summary, "unknownTimeRecords")
        let scanned = intVal(summary, "databasesScanned")
        let discovered = intVal(summary, "databasesDiscovered", fallback: scanned)
        let unpriced = intVal(summary, "unpricedModels", fallback: intVal(summary, "unpriced_models"))
        let scope = InterfaceText.usageScope(scanned: scanned, discovered: discovered, failed: failed, skipped: skipped, unknown: unknown)
        let cached = summary["availability"] as? String == "cached"
        let rawWarnings = summary["pricing_warnings"] as? [String] ?? []
        let warningCodes = summary["pricing_warning_codes"] as? [String]
        let suppressedCodes: Set<String> = ["legacy_json_migrated", "legacy_ledger_migrated", "historical_receipts_locked"]
        let isLegacyWarningText: (String) -> Bool = { text in
            text.hasPrefix("旧JSON")
                || text.hasPrefix("旧账本")
                || text.hasPrefix("历史金额凭据")
                || text.hasPrefix("Legacy JSON")
                || text.hasPrefix("Legacy ledger")
                || text.hasPrefix("Historical cost")
        }
        let warnings: [String]
        if let warningCodes, warningCodes.count == rawWarnings.count {
            warnings = zip(warningCodes, rawWarnings).compactMap { code, text in
                guard !suppressedCodes.contains(code), !isLegacyWarningText(text) else { return nil }
                return text
            }
        } else {
            warnings = rawWarnings.filter { !isLegacyWarningText($0) }
        }
        var parts: [String] = []
        if cached { parts.append(L10n.t("usage.status.cached_record")) }
        let hasScopeIssue = failed > 0 || skipped > 0 || unknown > 0 || (discovered > 0 && scanned < discovered)
        if hasScopeIssue || cached {
            parts.append(scope)
        }
        if unpriced > 0 {
            parts.append(L10n.t("usage.status.unpriced_models", ["count": unpriced]))
        }
        if !warnings.isEmpty {
            parts.append(warnings.joined(separator: L10n.shared.isEnglish ? "; " : "；"))
        }
        statusSummary.stringValue = parts.joined(separator: " · ")
        let hasWarning = hasScopeIssue || cached || unpriced > 0 || !warnings.isEmpty
        statusSummary.textColor = hasWarning ? accessibleWarningColor() : .secondaryLabelColor
        footerBox.isHidden = !hasWarning
    }

    func updateChartsAndBreakdown(summary: [String: Any], value: [String: Any], segIdx: Int, totalTokens: Int, totalUsd: Double) {
        let signpost = PerformanceSignpost.begin("UsageChartsAndBreakdown")
        defer { PerformanceSignpost.end("UsageChartsAndBreakdown", signpost) }
        if let rows = (value["byModel"] as? [[String: Any]]) ?? (value["models"] as? [[String: Any]]) {
            self.modelRows = ModelUsageFold.foldThinkingVariants(rows)
        }
        // 1. 更新趋势柱状图
        if segIdx == 0 {
            let hourly = (value["todayHourly"] as? [[String: Any]]) ?? (summary["today_hourly"] as? [[String: Any]]) ?? []
            let pts = UsageTrendChartView.todayPoints(hourly)
            trendChart.points = pts
        } else {
            let daily = (value["dailyTrends"] as? [[String: Any]]) ?? (summary["daily_trends"] as? [[String: Any]]) ?? []
            // segIdx == 1: 7天; segIdx == 2: 30天; segIdx == 3: 全部 (展示完整 30 天或更长历史，杜绝被截成14天)
            let count = segIdx == 1 ? 7 : (segIdx == 2 ? 30 : max(30, daily.count))
            let slice = daily.suffix(count)
            let pts: [UsageTrendChartView.Point] = slice.map { d in
                let dateStr = (d["date"] as? String) ?? ""
                let shortDate = dateStr.count >= 10 ? String(dateStr.suffix(5)) : dateStr
                let t = (d["total_tokens"] as? Int) ?? (d["totalTokens"] as? Int) ?? 0
                return .init(label: shortDate, tokens: t)
            }
            trendChart.points = pts
        }
        let maxPoint = trendChart.points.max(by: { $0.tokens < $1.tokens })
        let peakText = (maxPoint != nil && maxPoint!.tokens > 0) ? L10n.t("usage.chart.peak_suffix", ["label": maxPoint!.label, "tokens": formatCompactTokens(maxPoint!.tokens)]) : ""
        trendChart.setAccessibilityElement(true)
        trendChart.setAccessibilityLabel("\(trendTitleLabel.stringValue)\(peakText)")

        // 2. 更新环图与图例 (N09: 按费用降序排列，超出项合并为「其他」，保证图例百分比与环图 360° 完全对齐)
        donutLegendStack.arrangedSubviews.forEach {
            donutLegendStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        var slices: [ModelDonutChartView.Slice] = []

        // 先筛选已计价且有费用的模型，按费用降序排序
        let pricedModels = modelRows.filter {
            let mUsd = doubleVal($0, "estimatedUsd", fallback: doubleVal($0, "estimated_usd"))
            let isPriced = (($0["priced"] as? Bool) ?? (mUsd > 0)) || ($0["partiallyPriced"] as? Bool == true)
            return isPriced && mUsd > 0
        }.sorted {
            let u1 = doubleVal($0, "estimatedUsd", fallback: doubleVal($0, "estimated_usd"))
            let u2 = doubleVal($1, "estimatedUsd", fallback: doubleVal($1, "estimated_usd"))
            return u1 > u2
        }

        let totalPricedUsd = pricedModels.reduce(0.0) { $0 + doubleVal($1, "estimatedUsd", fallback: doubleVal($1, "estimated_usd")) }
        let effectiveTotalUsd = max(totalUsd, totalPricedUsd)

        let topCount = 4
        var topSlices: [(name: String, usd: Double, tokens: Int, color: NSColor)] = []
        var otherUsd = 0.0
        var otherTokens = 0
        var otherCount = 0

        for (idx, item) in pricedModels.enumerated() {
            let name = InterfaceText.localizedModelLabel(item["model"] as? String)
            let mUsd = doubleVal(item, "estimatedUsd", fallback: doubleVal(item, "estimated_usd"))
            let mTokens = intVal(item, "totalTokens", fallback: intVal(item, "total_tokens"))
            if idx < topCount || pricedModels.count <= 5 {
                let color = palette[idx % palette.count]
                topSlices.append((name: name, usd: mUsd, tokens: mTokens, color: color))
            } else {
                otherUsd += mUsd
                otherTokens += mTokens
                otherCount += 1
            }
        }

        if otherCount > 0 && otherUsd > 0 {
            topSlices.append((name: L10n.t("usage.donut.other_models", ["count": otherCount]), usd: otherUsd, tokens: otherTokens, color: .systemGray))
        }

        for (_, slice) in topSlices.enumerated() {
            slices.append(.init(model: slice.name, usd: slice.usd, tokens: slice.tokens, color: slice.color))

            let dot = NSBox()
            dot.boxType = .custom; dot.borderWidth = 0; dot.cornerRadius = 4; dot.fillColor = slice.color
            dot.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 8), dot.heightAnchor.constraint(equalToConstant: 8)])

            let pct = effectiveTotalUsd > 0 ? Int(round((slice.usd / effectiveTotalUsd) * 100)) : 0
            let pctText = (slice.usd > 0 && pct == 0) ? "<1%" : "\(pct)%"
            let nameLbl = text(slice.name, size: 12, weight: .medium, wrap: false)
            nameLbl.maximumNumberOfLines = 1
            nameLbl.lineBreakMode = .byTruncatingTail
            nameLbl.cell?.wraps = false
            nameLbl.cell?.truncatesLastVisibleLine = true
            nameLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

            let usdDisplay = self.formatUsd(slice.usd)
            let valLbl = text(L10n.t("usage.donut.value_share", ["usd": usdDisplay, "pct": pctText]), size: 10.5, weight: .regular, color: .secondaryLabelColor)
            valLbl.lineBreakMode = .byTruncatingTail
            valLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            valLbl.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
            let details = vertical([nameLbl, valLbl], spacing: 1.5)
            fillWidth(nameLbl, in: details); fillWidth(valLbl, in: details)
            let dotWrap = NSView()
            dotWrap.translatesAutoresizingMaskIntoConstraints = false
            dotWrap.addSubview(dot)
            NSLayoutConstraint.activate([
                dotWrap.widthAnchor.constraint(equalToConstant: 8),
                dotWrap.heightAnchor.constraint(equalToConstant: 14),
                dot.centerXAnchor.constraint(equalTo: dotWrap.centerXAnchor),
                dot.centerYAnchor.constraint(equalTo: dotWrap.centerYAnchor)
            ])
            let row = horizontal([dotWrap, details], spacing: 7)
            row.alignment = .top
            details.translatesAutoresizingMaskIntoConstraints = false
            details.widthAnchor.constraint(equalTo: row.widthAnchor, constant: -15).isActive = true
            donutLegendStack.addArrangedSubview(row)
            fillWidth(row, in: donutLegendStack)
        }

        if slices.isEmpty {
            let zeroHint = modelRows.isEmpty ? L10n.t("usage.donut.empty_calls") : modelRows.contains(where: { $0["priced"] as? Bool == true }) ? L10n.t("usage.donut.zero_cost") : L10n.t("usage.donut.no_pricing")
            donutLegendStack.addArrangedSubview(text(zeroHint, size: 12, color: .secondaryLabelColor))
        }
        donutChart.isHidden = slices.isEmpty
        donutChart.slices = slices
        donutChart.totalUsd = effectiveTotalUsd
        let topModelName = topSlices.first?.name ?? L10n.t("usage.donut.none_model")
        let topPct = topSlices.first.map { slice in effectiveTotalUsd > 0 ? Int(round((slice.usd / effectiveTotalUsd) * 100)) : 0 } ?? 0
        donutChart.setAccessibilityElement(true)
        donutChart.setAccessibilityLabel(pricedModels.isEmpty && !modelRows.isEmpty ? L10n.t("usage.donut.a11y_unpriced") : L10n.t("usage.donut.a11y_summary", ["total": self.formatUsd(effectiveTotalUsd), "model": topModelName, "pct": topPct]))

        // Visible summaries use real model metrics.
        modelsBreakdownStack.arrangedSubviews.forEach {
            modelsBreakdownStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        modelsCountLabel.stringValue = modelRows.isEmpty ? "" : L10n.t("usage.models.count", ["count": modelRows.count])

        guard !modelRows.isEmpty else {
            let empty = vertical([symbol("chart.bar", size: 22, color: Design.secondary), text(L10n.t("usage.models.empty"), size: 13, color: Design.secondary)], spacing: 10)
            empty.alignment = .centerX; empty.heightAnchor.constraint(greaterThanOrEqualToConstant: 90).isActive = true
            modelsBreakdownStack.addArrangedSubview(empty); fillWidth(empty, in: modelsBreakdownStack)
            return
        }

        for item in modelRows {
            let name = InterfaceText.localizedModelLabel(item["model"] as? String)
            let rawModelId = (item["modelId"] as? String) ?? (item["model_id"] as? String)
            let mTokens = intVal(item, "totalTokens", fallback: intVal(item, "total_tokens"))
            let mIn = intVal(item, "promptTokens", fallback: intVal(item, "input_tokens"))
            let mOut = intVal(item, "candidatesTokens", fallback: intVal(item, "output_tokens"))
            let mReq = intVal(item, "requestCount", fallback: intVal(item, "request_count"))
            let mUsd = doubleVal(item, "estimatedUsd", fallback: doubleVal(item, "estimated_usd"))
            let rawRatio = totalTokens > 0 ? (Double(mTokens) / Double(totalTokens)) * 100.0 : 0.0
            let sharePct = totalTokens > 0 ? max(0, min(100, Int(round(rawRatio)))) : 0
            let shareText = (mTokens > 0 && sharePct == 0) ? "<1%" : "\(sharePct)%"
            let isItemPriced = (item["priced"] as? Bool) ?? (mUsd > 0)
            var usdStr: String
            let isItemUnpriced = !(isItemPriced || (item["partiallyPriced"] as? Bool == true)) && mTokens > 0
            if isItemPriced || (item["partiallyPriced"] as? Bool == true) {
                usdStr = self.formatUsd(mUsd)
            } else {
                usdStr = mTokens > 0 ? L10n.t("menu_panel.usage.unpriced") : "$0.00"
            }
            if item["partiallyPriced"] as? Bool == true { usdStr = L10n.t("usage.models.partial_prefix") + usdStr }
            let row = ModelUsageRow(name: name, rawModelId: rawModelId, tokens: formatCompactTokens(mTokens), input: formatCompactTokens(mIn), output: formatCompactTokens(mOut), requests: mReq, cost: usdStr, share: sharePct, shareText: shareText, isUnpriced: isItemUnpriced)
            if !modelsBreakdownStack.arrangedSubviews.isEmpty {
                let line = divider(); modelsBreakdownStack.addArrangedSubview(line); fillWidth(line, in: modelsBreakdownStack)
            }
            modelsBreakdownStack.addArrangedSubview(row); fillWidth(row, in: modelsBreakdownStack)
        }
    }

    @objc func showLog() {
        guard let window = app.window, window.activeSheetWindow == nil else { return }
        let controller = UsageLogController(
            app: app,
            period: periods[max(0, min(periods.count - 1, periodSegment.selectedSegment))],
            environmentId: selectedEnvironmentId,
            accountId: selectedAccountId
        )
        logController = controller; controller.show(in: window) { [weak self] in self?.logController = nil }
    }
    @objc func exportUsage() {
        let selected = periods[max(0, min(periods.count - 1, periodSegment.selectedSegment))]
        let identity = UsageQueryIdentity(period: selected, environmentId: selectedEnvironmentId, accountId: selectedAccountId)
        guard !loading, exportButton.isEnabled, identity.matches(latestReport), latestReport["snapshotId"] != nil, let window = app.window else { return }
        var snapshot = latestReport
        if snapshot["environmentId"] == nil { snapshot["environmentId"] = selectedEnvironmentId }
        if snapshot["accountId"] == nil { snapshot["accountId"] = selectedAccountId }
        if snapshot["selectedEnvironmentId"] == nil && snapshot["selected_environment_id"] == nil {
            snapshot["selectedEnvironmentId"] = selectedEnvironmentId
        }
        if snapshot["selectedAccountId"] == nil && snapshot["selected_account_id"] == nil {
            snapshot["selectedAccountId"] = selectedAccountId
        }
        saveUsageJSON(snapshot, name: L10n.t("usage.models.export_filename", ["period": selected]), window: window, app: app)
    }

}
