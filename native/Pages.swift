import Cocoa

final class BentoShareBarView: NSView {
    let fraction: CGFloat

    init(fraction: CGFloat) {
        self.fraction = max(0, min(1, fraction))
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 4.5).isActive = true
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard bounds.width > 2 && bounds.height > 1 else { return }
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let radius = bounds.height / 2.0
        let trackRect = bounds.insetBy(dx: 0.25, dy: 0.25)
        let trackPath = NSBezierPath(roundedRect: trackRect, xRadius: radius, yRadius: radius)
        Design.track.setFill()
        trackPath.fill()
        NSColor(white: isDark ? 1.0 : 0.0, alpha: isDark ? 0.05 : 0.04).setStroke()
        trackPath.lineWidth = 0.5
        trackPath.stroke()

        guard fraction > 0.001 else { return }
        let fillW = max(bounds.height, min(bounds.width, bounds.width * fraction))
        let fillRect = NSRect(x: 0, y: 0, width: fillW, height: bounds.height)
        NSGraphicsContext.current?.saveGraphicsState()
        trackPath.addClip()
        let fillPath = NSBezierPath(roundedRect: fillRect, xRadius: radius, yRadius: radius)
        let startTint = Design.blue.withAlphaComponent(0.75)
        let endTint = Design.blue
        if let grad = NSGradient(starting: startTint, ending: endTint) {
            grad.draw(in: fillPath, angle: 0)
        } else {
            endTint.setFill()
            fillPath.fill()
        }
        NSGraphicsContext.current?.restoreGraphicsState()
    }
}

private final class BentoRowStackView: NSStackView {
    var onHeightChanged: ((CGFloat) -> Void)?
    override func layout() {
        super.layout()
        onHeightChanged?(bounds.height)
    }
}

final class DashboardPage: NSObject {
    static let tallBentoExpandThreshold: CGFloat = 322
    static let tallBentoCollapseThreshold: CGFloat = 314

    unowned let app: Assistant
    let view: NSView

    // Hero 账号与 5 桶配额
    let debugPortTitleLabel = text(L10n.t("status.debug_port_missing", fallback: "未开启调试端口"), size: 12.5, weight: .semibold, color: .labelColor)
    let debugPortBodyLabel = text(L10n.t("debug_port_missing.banner_body", fallback: "Antigravity 未带调试端口运行，请先保存工作后安全重启以连接。"), size: 11.5, color: Design.secondary, wrap: true)
    let safeRelaunchButton = button(L10n.t("assistant.safe_relaunch_btn", fallback: "安全重启以连接"), target: nil, action: #selector(safeRelaunchAntigravityPressed))
    let debugPortBannerBox: NSBox
    let activeAccountLabel = text(L10n.t("overview.loading_account"), size: 16, weight: .semibold)
    // B02: status/freshness warnings and the mailbox are two separate lines so a warning can
    // never be overwritten by the raw email (and so the badge always matches the visible copy).
    let accountStatusLabel = text("", size: 11, color: Design.secondary, wrap: true)
    let activeEmailLabel = text("", size: 11, color: .secondaryLabelColor, wrap: true)
    let tierBadge = TierBadge(L10n.t("overview.tier_pending"), scale: .regular)
    let currentAccountPill = pillBadge("", color: Design.blue)
    let contextComparisonPill = pillBadge("", color: Design.inactivePill)
    let contextSwitcher = DesignSegmentedControl(
        labels: [L10n.t("ssh.context.all", fallback: "总计"), L10n.t("ssh.context.local", fallback: "本机")],
        trackingMode: .selectOne,
        target: nil,
        action: nil,
        compact: true,
        equalWidthSegments: false,
        maxSegmentWidth: 165
    )
    let envSharePill = pillBadge("", color: Design.inactivePill)
    var contextSwitcherRow: NSStackView!
    private var contextSegmentKeys: [String] = ["all", "local"]
    // F04: percentage = remaining quota, so the title carries the "剩余" semantics explicitly.
    let coreQuotaStack = NSStackView()
    let standaloneDivider = divider()
    let standaloneQuotaStack = NSStackView()
    private var quotaMinHeightConstraint: NSLayoutConstraint?
    private var lockedQuotaHeight: CGFloat = 0
    private var heroIdentityRow: NSView?
    private var quotaSectionContainer: NSView?
    private(set) var metricsContainer: NSView?
    let refreshQuotaButton: QuotaRefreshButton

    // 三磁贴 Bento 磁贴
    let todayTokensMetric = metricValue()
    let todayTokensDetail = metricDetail(L10n.t("overview.metric.total_tokens_placeholder"))
    let todayRequestsMetric = metricValue()
    let todayRequestsDetail = metricDetail(L10n.t("overview.metric.total_requests_placeholder"))
    let usageMetric = metricValue()
    let usageDetail = metricDetail(L10n.t("overview.metric.total_cost_placeholder"))
    var tokenMetricCard: MetricCardBox?
    var costMetricCard: MetricCardBox?
    var requestsMetricCard: MetricCardBox?

    // Bento 双栏数据看板（左侧今日 24h 时段消耗趋势 + 右侧今日活跃模型速览）
    let todayTrendChart = UsageTrendChartView()
    let trendTitleLabel = text(L10n.t("overview.trend.title"), size: 13, weight: .semibold, color: .labelColor)
    let trendDetailLabel = text("", size: 11, color: Design.secondary)
    let todayPeakBadge = pillBadge(L10n.t("overview.trend.24h_badge"), color: Design.inactivePill)
    private(set) var currentTrendPoints: [UsageTrendChartView.Point] = []
    private var hoveredTrendPoint: UsageTrendChartView.Point? = nil
    let rightBentoTitleLabel = text(L10n.t("overview.bento.active_models"), size: 13, weight: .semibold, color: .labelColor)
    let rightBentoCountBadge = pillBadge(L10n.t("overview.bento.no_calls_badge"), color: Design.inactivePill)
    let bentoRightStack = NSStackView()
    let bentoRow: NSStackView
    private(set) var activeModelDisplayLimit: Int = 2
    private var bentoFingerprint = ""

    var metricsKey = ""
    var metricsLoading = false
    private var activeRequestEnvId: String? = nil
    private var requestGeneration: Int = 0
    var lastMetricsFetchTime: Date = .distantPast
    var lastSuccessfulSummary: [String: Any]?
    private var cachedSummariesByEnv: [String: [String: Any]] = [:]
    private var cachedSummaryFetchTimeByEnv: [String: Date] = [:]
    private var lastRenderedContextKey: String = "all"
    let dataTimestampLabel = text("", size: 11, color: .secondaryLabelColor)
    let usageQualityLabel = text("", size: 11.5, color: .secondaryLabelColor, wrap: true)

    init(app: Assistant) {
        self.app = app
        refreshQuotaButton = QuotaRefreshButton(target: nil, action: #selector(refreshActiveQuota))
        refreshQuotaButton.controlSize = .small

        let warnTint = accessibleWarningColor()
        let debugIconBox = tintedIconBox(
            size: 28,
            cornerRadius: 7,
            tint: warnTint,
            darkFillAlpha: 0.18,
            lightFillAlpha: 0.11,
            darkBorderAlpha: 0.30,
            lightBorderAlpha: 0.16
        )
        let debugIcon = symbol("exclamationmark.triangle.fill", size: 13.5, color: warnTint)
        debugIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .semibold)
        debugIconBox.addSubview(debugIcon)
        NSLayoutConstraint.activate([
            debugIcon.centerXAnchor.constraint(equalTo: debugIconBox.centerXAnchor),
            debugIcon.centerYAnchor.constraint(equalTo: debugIconBox.centerYAnchor)
        ])
        debugPortTitleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        debugPortTitleLabel.lineBreakMode = .byTruncatingTail
        debugPortBodyLabel.font = .systemFont(ofSize: 11, weight: .regular)
        debugPortBodyLabel.maximumNumberOfLines = 1
        debugPortBodyLabel.lineBreakMode = .byTruncatingTail
        debugPortBodyLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let debugCopyCol = vertical([debugPortTitleLabel, debugPortBodyLabel], spacing: 2)
        debugCopyCol.alignment = .leading
        debugCopyCol.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        safeRelaunchButton.controlSize = .small
        safeRelaunchButton.font = .systemFont(ofSize: 11.5, weight: .medium)
        safeRelaunchButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
        safeRelaunchButton.imagePosition = .imageLeading
        safeRelaunchButton.setContentHuggingPriority(.required, for: .horizontal)
        safeRelaunchButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        safeRelaunchButton.toolTip = nil
        let debugRow = horizontal([debugIconBox, debugCopyCol, flexibleSpace(), safeRelaunchButton], spacing: 10)
        debugRow.alignment = .centerY
        debugRow.heightAnchor.constraint(greaterThanOrEqualToConstant: 32).isActive = true
        let debugBanner = group([debugRow], inset: 14)
        debugBanner.cornerRadius = Design.Radius.card
        debugBanner.borderWidth = 1
        debugBanner.borderColor = Design.dynamicAlpha(warnTint, 0.25, 0.34)
        debugBanner.fillColor = Design.dynamicAlpha(warnTint, 0.06, 0.11)
        debugBanner.isHidden = true
        debugPortBannerBox = debugBanner

        let stack = pageStack(title: L10n.t("overview.title"))
        stack.spacing = Design.Spacing.standard
        activeAccountLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        activeAccountLabel.lineBreakMode = .byTruncatingTail
        activeAccountLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        activeAccountLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        accountStatusLabel.maximumNumberOfLines = 1
        accountStatusLabel.lineBreakMode = .byTruncatingTail
        accountStatusLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        accountStatusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        accountStatusLabel.isHidden = true
        enableTextCopy(activeEmailLabel, title: L10n.t("common.copy_full_email"))
        activeEmailLabel.font = .systemFont(ofSize: 11.5, weight: .regular)
        activeEmailLabel.maximumNumberOfLines = 1
        activeEmailLabel.lineBreakMode = .byTruncatingMiddle
        activeEmailLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        activeEmailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let titleSpacer = flexibleSpace()
        titleSpacer.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let titleRow = horizontal([activeAccountLabel, tierBadge, currentAccountPill, contextComparisonPill, titleSpacer], spacing: 6)
        titleRow.alignment = .centerY
        titleRow.detachesHiddenViews = true
        tierBadge.setContentHuggingPriority(.required, for: .horizontal)
        tierBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        currentAccountPill.setContentHuggingPriority(.required, for: .horizontal)
        currentAccountPill.setContentCompressionResistancePriority(.required, for: .horizontal)
        currentAccountPill.isHidden = true
        contextComparisonPill.setContentHuggingPriority(.required, for: .horizontal)
        contextComparisonPill.setContentCompressionResistancePriority(.required, for: .horizontal)
        contextComparisonPill.isHidden = true
        let identity = vertical([titleRow, activeEmailLabel, accountStatusLabel], spacing: 4)
        for row in identity.arrangedSubviews { fillWidth(row, in: identity) }
        identity.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let heroActions = horizontal([refreshQuotaButton], spacing: 6)
        heroActions.alignment = .centerY
        let accountTopRow = identityHeader(identity: identity, actions: heroActions)
        heroIdentityRow = accountTopRow
        coreQuotaStack.orientation = .vertical
        coreQuotaStack.alignment = .leading
        coreQuotaStack.spacing = 9
        coreQuotaStack.detachesHiddenViews = true
        standaloneDivider.isHidden = true
        standaloneQuotaStack.orientation = .vertical
        standaloneQuotaStack.alignment = .leading
        standaloneQuotaStack.spacing = 6
        standaloneQuotaStack.isHidden = true
        standaloneQuotaStack.detachesHiddenViews = true
        Self.syncCoreGroupBars(QuotaPresentation.contract([:]).coreGroups, into: coreQuotaStack, compact: true)
        dataTimestampLabel.isHidden = true
        dataTimestampLabel.setContentHuggingPriority(.required, for: .vertical)
        dataTimestampLabel.setContentCompressionResistancePriority(.required, for: .vertical)

        let quotaSectionStack = vertical([coreQuotaStack, standaloneDivider, standaloneQuotaStack], spacing: 8)
        quotaSectionStack.detachesHiddenViews = true
        for sub in quotaSectionStack.arrangedSubviews { fillWidth(sub, in: quotaSectionStack) }
        let quotaSectionHost = NSView()
        quotaSectionHost.translatesAutoresizingMaskIntoConstraints = false
        quotaSectionStack.translatesAutoresizingMaskIntoConstraints = false
        quotaSectionHost.addSubview(quotaSectionStack)
        let tightQuotaHeight = quotaSectionHost.heightAnchor.constraint(equalTo: quotaSectionStack.heightAnchor)
        tightQuotaHeight.priority = NSLayoutConstraint.Priority(480)
        let maxQuotaCushion = quotaSectionHost.heightAnchor.constraint(lessThanOrEqualTo: quotaSectionStack.heightAnchor, constant: 8)
        maxQuotaCushion.priority = NSLayoutConstraint.Priority(475)
        let lockedMinQuota = quotaSectionHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 0)
        lockedMinQuota.priority = NSLayoutConstraint.Priority(496)
        quotaMinHeightConstraint = lockedMinQuota
        quotaSectionContainer = quotaSectionHost
        NSLayoutConstraint.activate([
            quotaSectionStack.leadingAnchor.constraint(equalTo: quotaSectionHost.leadingAnchor),
            quotaSectionStack.trailingAnchor.constraint(equalTo: quotaSectionHost.trailingAnchor),
            quotaSectionStack.topAnchor.constraint(equalTo: quotaSectionHost.topAnchor),
            quotaSectionStack.bottomAnchor.constraint(lessThanOrEqualTo: quotaSectionHost.bottomAnchor),
            tightQuotaHeight,
            maxQuotaCushion,
            lockedMinQuota
        ])
        quotaSectionHost.setContentHuggingPriority(NSLayoutConstraint.Priority(480), for: .vertical)

        contextSwitcher.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        contextSwitcher.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        envSharePill.setContentHuggingPriority(.required, for: .horizontal)
        envSharePill.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        envSharePill.isHidden = true
        let ctxRow = horizontal([contextSwitcher, flexibleSpace(), envSharePill], spacing: 8)
        ctxRow.alignment = .centerY
        ctxRow.detachesHiddenViews = true
        ctxRow.isHidden = true
        contextSwitcherRow = ctxRow

        let heroDivider = divider()
        let heroCard = group([ctxRow, accountTopRow, heroDivider, quotaSectionHost, dataTimestampLabel], inset: 14, spacing: 8)
        if let heroInner = groupStack(heroCard) {
            heroInner.distribution = .fill
            heroInner.detachesHiddenViews = true
            heroInner.setCustomSpacing(8, after: ctxRow)
            heroInner.setCustomSpacing(8, after: accountTopRow)
            heroInner.setCustomSpacing(8, after: heroDivider)
            heroInner.setCustomSpacing(6, after: quotaSectionHost)
        }
        heroCard.cornerRadius = Design.Radius.card
        heroCard.borderWidth = 0.5
        heroCard.borderColor = Design.border
        stack.addArrangedSubview(debugPortBannerBox)
        stack.addArrangedSubview(heroCard)
        usageMetric.allowsDefaultTighteningForTruncation = true
        let token = compactMetric(L10n.t("overview.metric.today_tokens"), value: todayTokensMetric, detail: todayTokensDetail, kind: .tokens)
        let cost = compactMetric(L10n.t("overview.metric.today_cost"), value: usageMetric, detail: usageDetail, kind: .cost)
        let requests = compactMetric(L10n.t("overview.metric.today_requests"), value: todayRequestsMetric, detail: todayRequestsDetail, kind: .requests)
        tokenMetricCard = token as? MetricCardBox
        costMetricCard = cost as? MetricCardBox
        requestsMetricCard = requests as? MetricCardBox
        let metrics = horizontal([token, cost, requests], spacing: 12); metrics.distribution = .fillEqually; metrics.alignment = .top
        metricsContainer = metrics
        for card in [token, cost, requests] {
            card.topAnchor.constraint(equalTo: metrics.topAnchor).isActive = true
            card.bottomAnchor.constraint(equalTo: metrics.bottomAnchor).isActive = true
        }
        usageQualityLabel.isHidden = true
        usageQualityLabel.setContentHuggingPriority(.required, for: .vertical)
        stack.addArrangedSubview(usageQualityLabel)
        stack.addArrangedSubview(metrics)

        // 方案 A：Bento 双栏数据看板
        let trendIconBox = Self.makeHeaderIconBadge(symbolName: "chart.bar.xaxis", tint: Design.blue)
        Self.configureBentoHeaderTitle(trendTitleLabel)
        todayPeakBadge.setContentHuggingPriority(.required, for: .horizontal)
        todayPeakBadge.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let trendSpacer = Self.makeBentoHeaderSpacer()
        let trendHeader = horizontal([trendIconBox, trendTitleLabel, trendSpacer, todayPeakBadge], spacing: 6)
        trendHeader.setCustomSpacing(0, after: trendSpacer)
        trendHeader.alignment = .centerY
        trendHeader.heightAnchor.constraint(equalToConstant: 22).isActive = true

        // 保持左右 Bento 顶栏与分割线严格等高对齐，将时段实时读数置于分割线下方图表区顶部
        trendDetailLabel.font = .monospacedDigitSystemFont(ofSize: 11.5, weight: .regular)
        trendDetailLabel.lineBreakMode = .byTruncatingTail
        trendDetailLabel.maximumNumberOfLines = 1
        trendDetailLabel.setContentHuggingPriority(.required, for: .vertical)
        trendDetailLabel.setContentCompressionResistancePriority(.required, for: .vertical)
        trendDetailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        // 限制柱图最大高度避免大窗口下柱体拉得过长，余出空间由内置读数与宿主弹性留白平滑消化
        todayTrendChart.useFlexibleHeight(minHeight: 84, maxHeight: 114)
        let trendChartHost = NSView()
        trendChartHost.translatesAutoresizingMaskIntoConstraints = false
        trendChartHost.setContentHuggingPriority(NSLayoutConstraint.Priority(200), for: .vertical)
        trendChartHost.addSubview(todayTrendChart)
        let fillChartH = todayTrendChart.heightAnchor.constraint(equalTo: trendChartHost.heightAnchor)
        // 必须显著低于 viewportMetricRatio(470) / tightQuotaHeight(480) / fitViewport(490)，避免限制柱图最大高度时反向抢占 Bento 高度导致 1-row FREE 无法自动展开 Top 3
        fillChartH.priority = NSLayoutConstraint.Priority(210)
        NSLayoutConstraint.activate([
            trendChartHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 84),
            todayTrendChart.leadingAnchor.constraint(equalTo: trendChartHost.leadingAnchor),
            todayTrendChart.trailingAnchor.constraint(equalTo: trendChartHost.trailingAnchor),
            todayTrendChart.centerYAnchor.constraint(equalTo: trendChartHost.centerYAnchor),
            todayTrendChart.topAnchor.constraint(greaterThanOrEqualTo: trendChartHost.topAnchor),
            todayTrendChart.bottomAnchor.constraint(lessThanOrEqualTo: trendChartHost.bottomAnchor),
            fillChartH
        ])
        let trendDivider = divider()
        let trendCard = group([trendHeader, trendDivider, trendDetailLabel, trendChartHost], inset: 14, spacing: 8)
        if let trendStack = groupStack(trendCard) {
            trendStack.distribution = .fill
            trendStack.setCustomSpacing(4, after: trendDetailLabel)
        }
        trendCard.cornerRadius = Design.Radius.card
        trendCard.borderWidth = 0.5
        trendCard.borderColor = Design.border

        let rightIconBox = Self.makeHeaderIconBadge(symbolName: "square.stack.3d.up.fill", tint: Design.blue)
        Self.configureBentoHeaderTitle(rightBentoTitleLabel)
        rightBentoCountBadge.setContentHuggingPriority(.required, for: .horizontal)
        rightBentoCountBadge.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let rightSpacer = Self.makeBentoHeaderSpacer()
        let rightHeader = horizontal([rightIconBox, rightBentoTitleLabel, rightSpacer, rightBentoCountBadge], spacing: 6)
        rightHeader.setCustomSpacing(0, after: rightSpacer)
        rightHeader.alignment = .centerY
        rightHeader.heightAnchor.constraint(equalToConstant: 22).isActive = true
        bentoRightStack.orientation = .vertical
        bentoRightStack.alignment = .leading
        bentoRightStack.distribution = .fillEqually
        bentoRightStack.spacing = 8
        bentoRightStack.setContentHuggingPriority(NSLayoutConstraint.Priority(200), for: .vertical)
        let rightCard = group([rightHeader, divider(), bentoRightStack], inset: 14, spacing: 8)
        groupStack(rightCard)?.distribution = .fill
        rightCard.cornerRadius = Design.Radius.card
        rightCard.borderWidth = 0.5
        rightCard.borderColor = Design.border

        let bento = BentoRowStackView(views: [trendCard, rightCard])
        bento.orientation = .horizontal
        bento.spacing = 12
        bento.distribution = .fillEqually
        bento.alignment = .top
        bento.setContentHuggingPriority(NSLayoutConstraint.Priority(200), for: .vertical)
        for card in [trendCard, rightCard] {
            card.topAnchor.constraint(equalTo: bento.topAnchor).isActive = true
            card.bottomAnchor.constraint(equalTo: bento.bottomAnchor).isActive = true
        }
        bentoRow = bento
        stack.addArrangedSubview(bento)

        view = dashboardScrollPage(stack, hero: heroCard, metrics: [token, cost, requests], bento: bento)
        super.init()

        todayTrendChart.onHoverPoint = { [weak self] point in
            self?.hoveredTrendPoint = point
            self?.syncTrendDetailLabel()
        }
        if let stickyScroll = view as? StickyHeaderScrollView {
            stickyScroll.onViewportHeightChanged = { [weak self] viewportH in
                self?.syncBentoModelLimitForViewport(viewportH)
            }
        }
        bento.onHeightChanged = { [weak self] height in
            self?.syncBentoModelLimit(forBentoHeight: height)
        }
        refreshQuotaButton.target = self
        safeRelaunchButton.target = self
        contextSwitcher.target = self
        contextSwitcher.action = #selector(contextSegmentChanged(_:))
        safeRelaunchButton.setAccessibilityLabel(L10n.t("assistant.safe_relaunch_btn", fallback: "安全重启 Antigravity 以连接"))
        if let boot = app.cachedDashboardBootstrapSummary {
            lastSuccessfulSummary = boot
            renderSummary(boot, isStaleFallback: false)
        }
        update()
    }

    private static func configureBentoHeaderTitle(_ label: NSTextField) {
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.allowsDefaultTighteningForTruncation = true
        label.cell?.wraps = false
        label.cell?.truncatesLastVisibleLine = true
        label.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        // Keep below .fittingSizeCompression (50) so window.fittingSize.width stays <= 880pt while strictly beating the header spacer (priority 1).
        label.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(49), for: .horizontal)
    }

    private static func makeBentoHeaderSpacer() -> NSView {
        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        spacer.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        return spacer
    }

    private static func makeHeaderIconBadge(symbolName: String, tint: NSColor) -> NSView {
        let iconView = symbol(symbolName, size: 12, color: tint)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11.5, weight: .semibold)
        let iconBox = tintedIconBox(
            size: 22,
            cornerRadius: 6,
            tint: tint,
            darkFillAlpha: 0.18,
            lightFillAlpha: 0.10,
            darkBorderAlpha: 0.30,
            lightBorderAlpha: 0.16
        )
        iconBox.addSubview(iconView)
        NSLayoutConstraint.activate([
            iconView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
        ])
        return iconBox
    }

    private func estimatedBentoHeight(forViewportHeight viewportH: CGFloat) -> CGFloat {
        let coreRows = coreQuotaStack.isHidden ? 0 : coreQuotaStack.arrangedSubviews.count
        let standaloneRows = standaloneQuotaStack.isHidden ? 0 : standaloneQuotaStack.arrangedSubviews.count
        let coreH: CGFloat = coreRows > 0 ? (CGFloat(coreRows) * 31.5 + CGFloat(max(0, coreRows - 1)) * 9.0) : 0
        let standH: CGFloat = standaloneRows > 0 ? (17.0 + CGFloat(standaloneRows) * 31.5 + CGFloat(max(0, standaloneRows - 1)) * 6.0) : 0
        let quotaH = max(coreH + standH, contextSwitcherRow.isHidden ? 0 : lockedQuotaHeight)
        let switcherH: CGFloat = contextSwitcherRow.isHidden ? 0 : 32.0
        let stampH: CGFloat = dataTimestampLabel.isHidden ? 0 : 20.0
        let statusH: CGFloat = accountStatusLabel.isHidden ? 0 : 18.0
        let heroH: CGFloat = 81.0 + switcherH + quotaH + stampH + statusH
        let kpiH: CGFloat = min(148.0, max(103.0, viewportH * 0.21))
        let qualityH: CGFloat = usageQualityLabel.isHidden ? 0 : 26.0
        let debugBannerH: CGFloat = debugPortBannerBox.isHidden ? 0 : (max(56.0, debugPortBannerBox.bounds.height) + 12.0)
        return viewportH - 44.0 - debugBannerH - qualityH - heroH - kpiH
    }

    private func syncBentoModelLimitForViewport(_ viewportH: CGFloat? = nil) {
        let resolvedViewportH = viewportH ?? ((view as? NSScrollView)?.contentView.bounds.height ?? 0)
        guard resolvedViewportH > 100 else { return }
        syncBentoModelLimit(forBentoHeight: estimatedBentoHeight(forViewportHeight: resolvedViewportH))
    }

    private func syncBentoModelLimit(forBentoHeight height: CGFloat) {
        guard height > 1 else { return }
        let nextLimit: Int
        if activeModelDisplayLimit == 2 {
            nextLimit = height >= Self.tallBentoExpandThreshold ? 3 : 2
        } else {
            nextLimit = height < Self.tallBentoCollapseThreshold ? 2 : 3
        }
        guard nextLimit != activeModelDisplayLimit else { return }
        activeModelDisplayLimit = nextLimit
        updateReadinessMatrix()
        bentoRightStack.needsLayout = true
    }

    private static func makeBentoSubRow(
        title: String,
        copyModelId: String? = nil,
        badgeText: String,
        badgeTint: NSColor,
        subtitle: String,
        trailingText: String,
        trailingTint: NSColor = Design.secondary,
        shareFraction: CGFloat? = nil
    ) -> NSView {
        let nameLabel = text(title, size: 12.5, weight: .semibold, color: .labelColor)
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        nameLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        if let copyModelId, !copyModelId.isEmpty {
            enableTextCopy(nameLabel, value: copyModelId, title: L10n.t("overview.copy_model_id"))
        }

        let pill = pillBadge(badgeText, color: badgeTint)
        pill.label.font = .systemFont(ofSize: 9.5, weight: .semibold)
        pill.isHidden = badgeText.isEmpty
        pill.setContentCompressionResistancePriority(.required, for: .horizontal)
        pill.setContentHuggingPriority(.required, for: .horizontal)

        let rightLabel = text(trailingText, size: 11, weight: .semibold, color: trailingTint)
        rightLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        rightLabel.lineBreakMode = .byTruncatingTail
        rightLabel.alignment = .right
        rightLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        rightLabel.setContentHuggingPriority(.required, for: .horizontal)

        let topRow = horizontal([nameLabel, pill, flexibleSpace(), rightLabel], spacing: 6)
        topRow.alignment = .centerY
        topRow.detachesHiddenViews = true

        let subLabel = metricDetail(subtitle)

        var stackItems: [NSView] = [topRow]
        if let shareFraction {
            stackItems.append(BentoShareBarView(fraction: shareFraction))
        }
        stackItems.append(subLabel)

        let rowStack = vertical(stackItems, spacing: 3)
        rowStack.distribution = .equalSpacing
        for item in stackItems { fillWidth(item, in: rowStack) }
        if shareFraction != nil {
            let maxSpread = rowStack.heightAnchor.constraint(lessThanOrEqualToConstant: 52)
            maxSpread.priority = NSLayoutConstraint.Priority(485)
            maxSpread.isActive = true
            let comfortSpread = rowStack.heightAnchor.constraint(equalToConstant: 48)
            comfortSpread.priority = NSLayoutConstraint.Priority(450)
            comfortSpread.isActive = true
        }

        let box = DesignCardBox()
        box.boxType = .custom
        box.cornerRadius = 9
        box.borderWidth = 0.5
        box.borderColor = Design.border
        box.enablesHoverHighlight = false
        box.fillColor = NSColor(name: nil) { app in
            app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor.white.withAlphaComponent(0.03) : NSColor.black.withAlphaComponent(0.02)
        }
        let a11ySummary = [title, badgeText, subtitle, trailingText].filter { !$0.isEmpty }.joined(separator: L10n.shared.isEnglish ? ", " : "，")
        box.setAccessibilityElement(true)
        box.setAccessibilityRole(.group)
        box.setAccessibilityLabel(a11ySummary)
        box.toolTip = nil
        box.translatesAutoresizingMaskIntoConstraints = false
        box.setContentHuggingPriority(NSLayoutConstraint.Priority(200), for: .vertical)
        box.addSubview(rowStack)
        rowStack.translatesAutoresizingMaskIntoConstraints = false
        let comfortTop = rowStack.topAnchor.constraint(greaterThanOrEqualTo: box.topAnchor, constant: 6)
        comfortTop.priority = NSLayoutConstraint.Priority(460)
        let comfortBottom = rowStack.bottomAnchor.constraint(lessThanOrEqualTo: box.bottomAnchor, constant: -6)
        comfortBottom.priority = NSLayoutConstraint.Priority(460)
        NSLayoutConstraint.activate([
            box.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            rowStack.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
            rowStack.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -12),
            rowStack.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            rowStack.topAnchor.constraint(greaterThanOrEqualTo: box.topAnchor, constant: 3),
            rowStack.bottomAnchor.constraint(lessThanOrEqualTo: box.bottomAnchor, constant: -3),
            comfortTop,
            comfortBottom
        ])
        return box
    }

    private func formatTrendDetail(_ point: UsageTrendChartView.Point) -> String {
        if point.isFuture {
            return L10n.t("menu_panel.hover.future", ["label": point.tooltipLabel], fallback: "\(point.tooltipLabel) · 尚未到达")
        }
        let tokens = InterfaceText.formatCompactTokens(point.tokens, formatSmallWithLocale: true)
        return L10n.t("menu_panel.hover.tokens", ["label": point.tooltipLabel, "tokens": tokens], fallback: "\(point.tooltipLabel) · \(tokens) Token")
    }

    func syncTrendDetailLabel(currentHour: Int? = nil) {
        let resolvedHour = currentHour ?? Calendar.current.component(.hour, from: Date())
        let defaultPoint = currentTrendPoints.indices.contains(resolvedHour)
            ? currentTrendPoints[resolvedHour]
            : currentTrendPoints.last
        if let target = hoveredTrendPoint ?? defaultPoint {
            trendDetailLabel.stringValue = formatTrendDetail(target)
        } else {
            trendDetailLabel.stringValue = ""
        }
    }

    func currentOverviewEnvironmentId() -> String {
        let key = app.overviewEnvironmentKey
        if key == "local" { return "local" }
        if key.hasPrefix("env:") {
            let id = String(key.dropFirst("env:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            return id.isEmpty ? "all" : id
        }
        return "all"
    }

    private func summaryEnvironmentId(_ result: [String: Any]) -> String {
        let usg = result["usage"] as? [String: Any]
        let raw = (usg?["selectedEnvironmentId"] as? String)
            ?? (usg?["selected_environment_id"] as? String)
            ?? "all"
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "all" : trimmed
    }

    func updateReadinessMatrix() {
        let envId = currentOverviewEnvironmentId()
        let activeSummary: [String: Any]? = cachedSummariesByEnv[envId]
            ?? (lastSuccessfulSummary.flatMap { summaryEnvironmentId($0) == envId ? $0 : nil })
        let dashUsage = (activeSummary?["usage"] as? [String: Any]) ?? [:]
        let reportCacheKey = envId == "all" ? "today" : "today|env=\(envId)|acc=all"
        let report = app.cachedUsageReportsByPeriod[reportCacheKey]
            ?? (envId == "all" ? app.cachedUsageReportsByPeriod["today:all"] : nil)
            ?? [:]
        let summary = report["summary"] as? [String: Any] ?? [:]
        let hourly = (dashUsage["todayHourly"] as? [[String: Any]])
            ?? (report["todayHourly"] as? [[String: Any]])
            ?? (summary["today_hourly"] as? [[String: Any]])
            ?? []
        let pts = UsageTrendChartView.todayPoints(hourly)
        trendTitleLabel.stringValue = L10n.t("overview.trend.title")
        currentTrendPoints = pts
        hoveredTrendPoint = nil
        todayTrendChart.points = pts
        syncTrendDetailLabel()
        if let maxPt = pts.max(by: { $0.tokens < $1.tokens }), maxPt.tokens > 0 {
            let peakStr = InterfaceText.formatCompactTokens(maxPt.tokens)
            todayPeakBadge.title = L10n.t("overview.trend.peak_badge", ["label": maxPt.label, "peak": peakStr])
            todayPeakBadge.tint = Design.blue
        } else {
            todayPeakBadge.title = L10n.t("overview.trend.24h_badge")
            todayPeakBadge.tint = Design.inactivePill
        }

        let rawModels = (dashUsage["todayByModel"] as? [[String: Any]])
            ?? (report["byModel"] as? [[String: Any]])
            ?? (report["models"] as? [[String: Any]])
            ?? []
        let models = ModelUsageFold.foldThinkingVariants(rawModels).filter {
            let t = intVal($0, "totalTokens", fallback: intVal($0, "total_tokens"))
            let r = intVal($0, "requestCount", fallback: intVal($0, "request_count"))
            return t > 0 || r > 0
        }.sorted { m1, m2 in
            let t1 = intVal(m1, "totalTokens", fallback: intVal(m1, "total_tokens"))
            let t2 = intVal(m2, "totalTokens", fallback: intVal(m2, "total_tokens"))
            if t1 != t2 { return t1 > t2 }
            let r1 = intVal(m1, "requestCount", fallback: intVal(m1, "request_count"))
            let r2 = intVal(m2, "requestCount", fallback: intVal(m2, "request_count"))
            return r1 > r2
        }

        let totalTokens = models.reduce(0) { $0 + intVal($1, "totalTokens", fallback: intVal($1, "total_tokens")) }
        let totalReqs = models.reduce(0) { $0 + intVal($1, "requestCount", fallback: intVal($1, "request_count")) }
        let displayLimit = models.count >= 3 ? activeModelDisplayLimit : 2

        let fp = "\(envId)||" + models.prefix(3).map {
            let m = "\($0["model"] ?? "")"
            let t = intVal($0, "totalTokens", fallback: intVal($0, "total_tokens"))
            let r = intVal($0, "requestCount", fallback: intVal($0, "request_count"))
            let u = doubleVal($0, "estimatedUsd", fallback: doubleVal($0, "estimated_usd"))
            return "\(m):\(t):\(r):\(u)"
        }.joined(separator: "|") + "||\(models.count)||\(displayLimit)"
        guard fp != bentoFingerprint else { return }
        bentoFingerprint = fp

        bentoRightStack.arrangedSubviews.forEach {
            bentoRightStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        rightBentoTitleLabel.stringValue = L10n.t("overview.bento.active_models")

        if models.count >= 2 {
            let shown = min(models.count, displayLimit)
            if models.count > shown {
                if shown == 2 {
                    rightBentoCountBadge.title = L10n.t("overview.bento.top2_of_n", ["count": models.count], fallback: L10n.shared.isEnglish ? "Top 2 / \(models.count) total" : "Top 2 / 共 \(models.count) 个")
                } else {
                    rightBentoCountBadge.title = L10n.t("overview.bento.topn_of_m", ["shown": shown, "count": models.count], fallback: L10n.shared.isEnglish ? "Top \(shown) / \(models.count) total" : "Top \(shown) / 共 \(models.count) 个")
                }
            } else {
                rightBentoCountBadge.title = L10n.t("overview.bento.n_models", ["count": models.count])
            }
            rightBentoCountBadge.tint = Design.blue
            for item in models.prefix(shown) {
                let displayModel = InterfaceText.localizedModelLabel(item["model"] as? String)
                let rawModelId = (item["modelId"] as? String) ?? (item["model_id"] as? String) ?? displayModel
                let mTokens = intVal(item, "totalTokens", fallback: intVal(item, "total_tokens"))
                let mReqs = intVal(item, "requestCount", fallback: intVal(item, "request_count"))
                let mUsd = doubleVal(item, "estimatedUsd", fallback: doubleVal(item, "estimated_usd"))
                let shareRatio: Double
                if totalTokens > 0 {
                    shareRatio = Double(mTokens) / Double(totalTokens)
                } else if totalReqs > 0 {
                    shareRatio = Double(mReqs) / Double(totalReqs)
                } else {
                    shareRatio = 0
                }
                let sharePct = Int(round(shareRatio * 100))
                let shareNote = sharePct > 0 ? L10n.t("overview.bento.share_pct", ["pct": sharePct]) : ""
                let isPriced = (item["priced"] as? Bool) ?? true
                let isPartialModel = (item["partiallyPriced"] as? Bool) ?? false
                let isUnpricedModel = !isPriced && !isPartialModel && mTokens > 0
                let badgeText: String
                let badgeTint: NSColor
                if isUnpricedModel {
                    badgeText = L10n.t("overview.model.unpriced_badge")
                    badgeTint = accessibleWarningColor()
                } else if isPartialModel {
                    badgeText = L10n.t("overview.model.partial_badge")
                    badgeTint = accessibleWarningColor()
                } else {
                    badgeText = ""
                    badgeTint = Design.blue
                }
                let costNote: String
                if isPartialModel && mUsd > 0 {
                    costNote = L10n.t("overview.bento.cost_partial", ["cost": InterfaceText.formatUsd(mUsd)])
                } else if !isUnpricedModel && mUsd > 0 {
                    costNote = " · \(InterfaceText.formatUsd(mUsd))"
                } else {
                    costNote = ""
                }
                let row = Self.makeBentoSubRow(
                    title: displayModel,
                    copyModelId: rawModelId,
                    badgeText: badgeText,
                    badgeTint: badgeTint,
                    subtitle: L10n.t("overview.bento.model_sub_multi", ["reqs": InterfaceText.formatInteger(mReqs), "share": shareNote, "cost": costNote]),
                    trailingText: L10n.t("overview.bento.tokens_trailing", ["tokens": InterfaceText.formatCompactTokens(mTokens)]),
                    trailingTint: .labelColor,
                    shareFraction: CGFloat(shareRatio)
                )
                bentoRightStack.addArrangedSubview(row)
                fillWidth(row, in: bentoRightStack)
            }
        } else if models.count == 1 {
            rightBentoCountBadge.title = L10n.t("overview.bento.n_models", ["count": 1])
            rightBentoCountBadge.tint = Design.blue
            let topModel = models[0]
            let displayModel = InterfaceText.localizedModelLabel(topModel["model"] as? String)
            let rawModelId = (topModel["modelId"] as? String) ?? (topModel["model_id"] as? String) ?? displayModel
            let mTokens = intVal(topModel, "totalTokens", fallback: intVal(topModel, "total_tokens"))
            let mReqs = intVal(topModel, "requestCount", fallback: intVal(topModel, "request_count"))
            let mUsd = doubleVal(topModel, "estimatedUsd", fallback: doubleVal(topModel, "estimated_usd"))
            let isPriced = (topModel["priced"] as? Bool) ?? true
            let isPartialModel = (topModel["partiallyPriced"] as? Bool) ?? false
            let isUnpricedModel = !isPriced && !isPartialModel && mTokens > 0
            let badgeText: String
            let badgeTint: NSColor
            if isUnpricedModel {
                badgeText = L10n.t("overview.model.unpriced_badge")
                badgeTint = accessibleWarningColor()
            } else if isPartialModel {
                badgeText = L10n.t("overview.model.partial_badge")
                badgeTint = accessibleWarningColor()
            } else {
                badgeText = ""
                badgeTint = Design.blue
            }
            let costNote: String
            if isPartialModel && mUsd > 0 {
                costNote = L10n.t("overview.bento.cost_partial", ["cost": InterfaceText.formatUsd(mUsd)])
            } else if !isUnpricedModel && mUsd > 0 {
                costNote = " · \(InterfaceText.formatUsd(mUsd))"
            } else {
                costNote = ""
            }
            let row1 = Self.makeBentoSubRow(
                title: displayModel,
                copyModelId: rawModelId,
                badgeText: badgeText,
                badgeTint: badgeTint,
                subtitle: L10n.t("overview.bento.model_sub_single", ["reqs": InterfaceText.formatInteger(mReqs), "cost": costNote]),
                trailingText: L10n.t("overview.bento.tokens_trailing", ["tokens": InterfaceText.formatCompactTokens(mTokens)]),
                trailingTint: .labelColor,
                shareFraction: 1.0
            )
            bentoRightStack.addArrangedSubview(row1)
            fillWidth(row1, in: bentoRightStack)

            let hintRow = Self.makeBentoSubRow(
                title: L10n.t("overview.bento.more_title"),
                badgeText: L10n.t("overview.bento.single_model_badge"),
                badgeTint: Design.inactivePill,
                subtitle: L10n.t("overview.bento.more_sub"),
                trailingText: L10n.t("overview.bento.empty_tokens_trailing"),
                trailingTint: Design.secondary
            )
            bentoRightStack.addArrangedSubview(hintRow)
            fillWidth(hintRow, in: bentoRightStack)
        } else {
            rightBentoCountBadge.title = L10n.t("overview.bento.no_calls_badge")
            rightBentoCountBadge.tint = Design.inactivePill

            let emptyRow1 = Self.makeBentoSubRow(
                title: L10n.t("overview.bento.empty_title"),
                badgeText: L10n.t("overview.bento.empty_badge"),
                badgeTint: Design.inactivePill,
                subtitle: L10n.t("overview.bento.empty_sub"),
                trailingText: L10n.t("overview.bento.empty_tokens_trailing"),
                trailingTint: Design.secondary
            )
            bentoRightStack.addArrangedSubview(emptyRow1)
            fillWidth(emptyRow1, in: bentoRightStack)

            let emptyRow2 = Self.makeBentoSubRow(
                title: L10n.t("overview.bento.detail_title"),
                badgeText: L10n.t("overview.bento.detail_badge"),
                badgeTint: Design.inactivePill,
                subtitle: L10n.t("overview.bento.detail_sub"),
                trailingText: L10n.t("overview.bento.empty_reqs_trailing"),
                trailingTint: Design.secondary
            )
            bentoRightStack.addArrangedSubview(emptyRow2)
            fillWidth(emptyRow2, in: bentoRightStack)
        }
    }

    @objc func safeRelaunchAntigravityPressed() {
        app.safeRelaunchAntigravityForDebug()
    }

    func syncDebugPortBanner() {
        let showBanner = app.statusValue.mode == "debug-port-missing"
        let visibilityChanged = debugPortBannerBox.isHidden != !showBanner
        debugPortTitleLabel.stringValue = L10n.t("status.debug_port_missing", fallback: "未开启调试端口")
        debugPortBodyLabel.stringValue = L10n.t("debug_port_missing.banner_body", fallback: "Antigravity 未带调试端口运行，请先保存工作后安全重启以连接。")
        let btnTitle = L10n.t("assistant.safe_relaunch_btn", fallback: "安全重启以连接")
        safeRelaunchButton.title = btnTitle
        safeRelaunchButton.setAccessibilityLabel(btnTitle)
        safeRelaunchButton.toolTip = nil
        debugPortBannerBox.isHidden = !showBanner
        safeRelaunchButton.isHidden = !showBanner
        if visibilityChanged {
            syncBentoModelLimitForViewport()
        }
    }

    @objc func refreshActiveQuota() {
        if let remote = app.selectedOverviewRemoteSession() {
            app.refreshRemoteQuota(remoteKey: remote["remoteKey"] as? String)
            return
        }
        let activeId = ((lastSuccessfulSummary?["accounts"] as? [String: Any])?["currentAccountId"] as? String)
            ?? (app.resolvedActiveAccount()?["id"] as? String)
            ?? app.activeAccountId
        if !activeId.isEmpty {
            app.refreshSingleAccountQuota(id: activeId)
        } else {
            app.refreshAccountQuotas()
        }
    }

    @objc func contextSegmentChanged(_ sender: DesignSegmentedControl) {
        let idx = sender.selectedSegment
        guard contextSegmentKeys.indices.contains(idx) else { return }
        app.selectOverviewEnvironment(contextSegmentKeys[idx])
    }

    func handleOverviewEnvironmentChanged() {
        syncContextSwitcher()
        let envId = currentOverviewEnvironmentId()
        let cached = cachedSummariesByEnv[envId] ?? syntheticSummaryFromUsageCache(for: envId)
        if let cached {
            renderSummary(cached, isStaleFallback: false)
        } else if let remote = app.selectedOverviewRemoteSession() {
            renderRemoteHeroSection(remote)
            syncLockedQuotaHeight()
        } else if let base = lastSuccessfulSummary {
            renderSummary(base, isStaleFallback: false)
        }
        metricsKey = ""
        update(force: false)
    }

    func syncRemoteSessionsUI() {
        syncContextSwitcher()
        let envId = currentOverviewEnvironmentId()
        if let summary = cachedSummariesByEnv[envId] ?? lastSuccessfulSummary {
            renderSummary(summary, isStaleFallback: false)
        } else if let remote = app.selectedOverviewRemoteSession() {
            renderRemoteHeroSection(remote)
            syncLockedQuotaHeight()
        }
    }

    private func syntheticSummaryFromUsageCache(for envId: String) -> [String: Any]? {
        let cacheKey = envId == "all" ? "today" : "today|env=\(envId)|acc=all"
        guard let report = app.cachedUsageReportsByPeriod[cacheKey]
            ?? (envId == "all" ? app.cachedUsageReportsByPeriod["today:all"] : nil) else {
            return nil
        }
        let summary = report["summary"] as? [String: Any] ?? [:]
        var usageDict: [String: Any] = [
            "selectedEnvironmentId": envId,
            "todayTokens": intVal(summary, "totalTokens", fallback: intVal(summary, "total_tokens")),
            "totalTokens": intVal(summary, "totalTokens", fallback: intVal(summary, "total_tokens")),
            "estimatedUsd": doubleVal(summary, "estimatedUsd", fallback: doubleVal(summary, "estimated_usd")),
            "allTimeEstimatedUsd": doubleVal(summary, "estimatedUsd", fallback: doubleVal(summary, "estimated_usd")),
            "requestCount": intVal(summary, "requestCount", fallback: intVal(summary, "request_count")),
            "totalRequestCount": intVal(summary, "requestCount", fallback: intVal(summary, "request_count")),
            "todayPricedModels": intVal(summary, "pricedModels", fallback: intVal(summary, "priced_models")),
            "todayUnpricedModels": intVal(summary, "unpricedModels", fallback: intVal(summary, "unpriced_models")),
            "pricedModels": intVal(summary, "pricedModels", fallback: intVal(summary, "priced_models")),
            "unpricedModels": intVal(summary, "unpricedModels", fallback: intVal(summary, "unpriced_models")),
            "databasesScanned": intVal(summary, "databasesScanned"),
            "databasesDiscovered": intVal(summary, "databasesDiscovered"),
            "availability": (summary["availability"] as? String) ?? "complete",
            "todayHourly": (report["todayHourly"] as? [[String: Any]]) ?? [],
            "todayByModel": (report["byModel"] as? [[String: Any]]) ?? (report["models"] as? [[String: Any]]) ?? []
        ]
        if let bd = (report["environmentBreakdown"] as? [String: Any]) ?? (report["environment_breakdown"] as? [String: Any]) {
            usageDict["environmentBreakdown"] = bd
        }
        var synthetic: [String: Any] = ["usage": usageDict]
        if let baseAccounts = (cachedSummariesByEnv["all"]?["accounts"] as? [String: Any])
            ?? (lastSuccessfulSummary?["accounts"] as? [String: Any]) {
            synthetic["accounts"] = baseAccounts
        }
        return synthetic
    }

    func syncContextSwitcher() {
        let remotes = app.overviewRemoteEnvironments()
        let allLabel = L10n.t("ssh.context.all", fallback: "总计")
        let localLabel = L10n.t("ssh.context.local", fallback: "本机")
        var labels = [allLabel, localLabel]
        var tooltips: [String?] = [nil, nil]
        var keys = ["all", "local"]
        for item in remotes {
            let lbl = L10n.t("ssh.context.remote", ["host": item.hostLabel], fallback: "SSH: \(item.hostLabel)")
            labels.append(lbl)
            tooltips.append(lbl)
            keys.append("env:\(item.environmentId)")
        }
        contextSegmentKeys = keys
        let hidden = remotes.isEmpty
        if !hidden {
            let selectedIdx = keys.firstIndex(of: app.overviewEnvironmentKey) ?? 0
            contextSwitcher.updateSegments(
                labels: labels,
                tooltips: tooltips,
                selectedIndex: selectedIdx,
                animated: Design.shouldAnimate(in: contextSwitcher)
            )
        } else {
            envSharePill.isHidden = true
        }
        contextSwitcherRow.isHidden = hidden
    }

    private func estimateQuotaRows(for contract: QuotaPresentation.Contract, fallbackEmptyRows: Int) -> (coreRows: Int, standaloneRows: Int) {
        var coreRows = 0
        var hasPendingSingle = false
        for g in contract.coreGroups {
            let count = g.windows.count
            guard count > 0 else { continue }
            if count == 1 {
                if hasPendingSingle {
                    coreRows += 1
                    hasPendingSingle = false
                } else {
                    hasPendingSingle = true
                }
            } else {
                if hasPendingSingle {
                    coreRows += 1
                    hasPendingSingle = false
                }
                coreRows += (count + 1) / 2
            }
        }
        if hasPendingSingle { coreRows += 1 }
        if coreRows == 0 && contract.standaloneGroups.isEmpty {
            coreRows = fallbackEmptyRows
        }
        let standaloneSpecCount = contract.standaloneGroups.reduce(0) { $0 + max(1, $1.windows.count) }
        let standaloneRows = standaloneSpecCount > 0 ? (standaloneSpecCount + 1) / 2 : 0
        return (coreRows, standaloneRows)
    }

    private func estimateQuotaSectionHeight(for contract: QuotaPresentation.Contract, fallbackEmptyRows: Int) -> CGFloat {
        let counts = estimateQuotaRows(for: contract, fallbackEmptyRows: fallbackEmptyRows)
        let coreH: CGFloat = counts.coreRows > 0
            ? (CGFloat(counts.coreRows) * 32.0 + CGFloat(max(0, counts.coreRows - 1)) * 9.0)
            : 0
        let standH: CGFloat = counts.standaloneRows > 0
            ? (17.0 + CGFloat(counts.standaloneRows) * 32.0 + CGFloat(max(0, counts.standaloneRows - 1)) * 6.0)
            : 0
        return coreH + (coreH > 0 && standH > 0 ? 8.0 : 0) + standH
    }

    private func syncLockedQuotaHeight() {
        guard !contextSwitcherRow.isHidden else {
            lockedQuotaHeight = 0
            quotaMinHeightConstraint?.constant = 0
            return
        }
        let baseAccounts = (cachedSummariesByEnv["all"]?["accounts"] as? [String: Any])
            ?? (lastSuccessfulSummary?["accounts"] as? [String: Any])
            ?? [:]
        let localContract = QuotaPresentation.contract(baseAccounts)
        var maxH = estimateQuotaSectionHeight(for: localContract, fallbackEmptyRows: 2)
        for item in app.overviewRemoteEnvironments() {
            let contract = QuotaPresentation.contract(item.session)
            maxH = max(maxH, estimateQuotaSectionHeight(for: contract, fallbackEmptyRows: 2))
        }
        let measured = coreQuotaStack.superview?.fittingSize.height ?? 0
        let resolved = max(maxH, measured)
        if resolved > lockedQuotaHeight {
            lockedQuotaHeight = resolved
        } else if abs(resolved - maxH) < 1 && maxH < lockedQuotaHeight && measured <= maxH + 1 {
            lockedQuotaHeight = maxH
        }
        quotaMinHeightConstraint?.constant = lockedQuotaHeight
    }

    private func anyEnvironmentHasStatusWarning(localAccounts: [String: Any]?) -> Bool {
        if let acc = localAccounts {
            let refreshErr = (acc["quotaRefreshError"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let isStale = acc["isStale"] as? Bool == true
            let isConnected = acc["isLiveVerified"] as? Bool == true
            let email = (acc["activeEmail"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let liveEmail = (acc["liveAccountEmail"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let mismatch = isConnected && !email.isEmpty && !liveEmail.isEmpty && liveEmail.lowercased() != email.lowercased()
            let stale = !staleGroupSummary(acc).hint.isEmpty
            let qWarn = !QuotaPresentation.warningSummary(QuotaPresentation.contract(acc)).isEmpty
            if !refreshErr.isEmpty || isStale || mismatch || stale || qWarn { return true }
        }
        for item in app.overviewRemoteEnvironments() {
            let r = item.session
            let state = r["state"] as? String ?? "connected"
            let lastErr = (r["lastError"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let contract = QuotaPresentation.contract(r)
            let hasGroups = !(contract.coreGroups.isEmpty && contract.standaloneGroups.isEmpty)
            let qWarn = !QuotaPresentation.warningSummary(contract).isEmpty
            if state == "disconnected" || state == "auth_expired" || !lastErr.isEmpty || !hasGroups || qWarn {
                return true
            }
        }
        return false
    }

    private func animateContextTransitionIfNeeded() {
        let nextCtx = app.overviewEnvironmentKey
        guard nextCtx != lastRenderedContextKey else { return }
        lastRenderedContextKey = nextCtx
        guard Design.shouldAnimate(in: view) else { return }
        let targets: [NSView] = [
            heroIdentityRow,
            quotaSectionContainer,
            todayTokensMetric,
            todayTokensDetail,
            usageMetric,
            usageDetail,
            todayRequestsMetric,
            todayRequestsDetail,
            bentoRightStack
        ].compactMap { $0 }
        for target in targets {
            target.wantsLayer = true
            target.layer?.removeAllAnimations()
            target.alphaValue = 0.58
        }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.16
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            for target in targets {
                target.animator().alphaValue = 1.0
            }
        }
    }

    private func applyStableStatusLine(warnings: [String], hasWarning: Bool, forceReserveLine: Bool) {
        let joined = warnings.joined(separator: " · ")
        if !joined.isEmpty {
            self.accountStatusLabel.isHidden = false
            self.accountStatusLabel.stringValue = joined
            self.accountStatusLabel.textColor = hasWarning ? accessibleWarningColor() : Design.secondary
        } else if forceReserveLine {
            self.accountStatusLabel.isHidden = false
            self.accountStatusLabel.stringValue = " "
            self.accountStatusLabel.textColor = Design.secondary
        } else {
            self.accountStatusLabel.isHidden = true
            self.accountStatusLabel.stringValue = ""
        }
        self.accountStatusLabel.toolTip = nil
    }

    private func renderRemoteHeroSection(_ remote: [String: Any], reserveStatusLine: Bool = false) {
        let state = remote["state"] as? String ?? "connected"
        let hostRaw = (remote["hostLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let host = hostRaw.isEmpty ? "SSH" : hostRaw
        let email = (remote["email"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = (remote["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let tierRaw = (remote["subscription_tier"] as? String) ?? (remote["tier"] as? String) ?? ""
        let normalizedTier = AccountIdentity.normalizeTier(tierRaw)
        let lastErr = (remote["lastError"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        self.activeAccountLabel.stringValue = !name.isEmpty ? name : (!email.isEmpty ? email : "SSH: \(host)")
        self.activeEmailLabel.stringValue = email.isEmpty ? L10n.t("ssh.context.remote_switch_hint", fallback: "远程主机账号由远端独立管理，此处仅供只读查看与刷新。") : email
        self.activeEmailLabel.toolTip = nil
        self.tierBadge.title = normalizedTier.isEmpty ? tierRaw : normalizedTier
        self.tierBadge.isHidden = email.isEmpty || (normalizedTier.isEmpty && tierRaw.isEmpty)
        self.currentAccountPill.title = L10n.t("ssh.context.remote_readonly_badge", fallback: "远程只读")
        self.currentAccountPill.tint = Design.blue
        self.currentAccountPill.isHidden = false

        let localEmail = (app.resolvedActiveAccount()?["email"] as? String ?? app.statusValue.liveAccountEmail).trimmingCharacters(in: .whitespacesAndNewlines)
        let matchedLocalId = (remote["matchedLocalAccountId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !email.isEmpty {
            if !localEmail.isEmpty && localEmail.caseInsensitiveCompare(email) == .orderedSame {
                self.contextComparisonPill.title = L10n.t("ssh.context.same_as_local", fallback: "与本机同一账号")
                self.contextComparisonPill.tint = Design.inactivePill
                self.contextComparisonPill.isHidden = false
            } else if !localEmail.isEmpty || matchedLocalId.isEmpty {
                self.contextComparisonPill.title = L10n.t("ssh.context.diff_from_local", fallback: "与本机不同账号")
                self.contextComparisonPill.tint = Design.inactivePill
                self.contextComparisonPill.isHidden = false
            } else {
                self.contextComparisonPill.isHidden = true
            }
        } else {
            self.contextComparisonPill.isHidden = true
        }

        let quotaContract = QuotaPresentation.contract(remote)
        let hasQuotaGroups = !(quotaContract.coreGroups.isEmpty && quotaContract.standaloneGroups.isEmpty)
        if hasQuotaGroups {
            Self.syncCoreGroupBars(quotaContract.coreGroups, into: coreQuotaStack, compact: true)
            let standaloneGroups = quotaContract.standaloneGroups
            standaloneDivider.isHidden = standaloneGroups.isEmpty
            Self.syncStandaloneGroupBars(standaloneGroups, into: standaloneQuotaStack, compact: true)
        } else {
            Self.syncCoreGroupBars(QuotaPresentation.contract([:]).coreGroups, into: coreQuotaStack, compact: true)
            standaloneDivider.isHidden = true
            Self.syncStandaloneGroupBars([], into: standaloneQuotaStack, compact: true)
        }

        var statuses: [String] = []
        var hasWarning = false
        if state == "disconnected" {
            statuses.append(L10n.t("ssh.context.remote_disconnected", fallback: "SSH 连接已断开（暂示上次快照）"))
            hasWarning = true
        } else if state == "auth_expired" {
            statuses.append(L10n.t("ssh.context.remote_auth_expired", fallback: "远端登录态已过期，请在 SSH 窗口重新登录"))
            hasWarning = true
        } else if !lastErr.isEmpty {
            statuses.append(L10n.t("ssh.context.remote_probe_error", fallback: "远端配额刷新失败，暂示上次快照"))
            hasWarning = true
        }
        if !hasQuotaGroups {
            statuses.append(L10n.t("ssh.context.remote_no_quota", fallback: "暂未获取到远端配额"))
            hasWarning = true
        }
        let contractWarn = QuotaPresentation.warningSummary(quotaContract)
        if !contractWarn.isEmpty {
            statuses.append(contractWarn)
            hasWarning = true
        }

        applyStableStatusLine(warnings: statuses, hasWarning: hasWarning, forceReserveLine: reserveStatusLine)

        let quotaTs = QuotaPresentation.number(remote["quotaLastUpdated"])
        let obsMs = QuotaPresentation.number(remote["observedAt"])
        let obsTs = quotaTs ?? (obsMs.map { $0 / 1000.0 }) ?? 0
        if obsTs > 0 {
            let obsDate = Date(timeIntervalSince1970: obsTs)
            dataTimestampLabel.isHidden = false
            dataTimestampLabel.stringValue = L10n.t("accounts.updated_at", ["time": Self.quotaObservedFormatter.string(from: obsDate)])
            dataTimestampLabel.textColor = .secondaryLabelColor
        } else if !contextSwitcherRow.isHidden {
            dataTimestampLabel.isHidden = false
            dataTimestampLabel.stringValue = L10n.t("ssh.context.no_timestamp", fallback: "暂无采样时间")
            dataTimestampLabel.textColor = .tertiaryLabelColor
        } else {
            dataTimestampLabel.isHidden = true
        }
    }

    func fetch() {
        update(force: true)
    }

    func update(force: Bool = false) {
        if force { bentoFingerprint = "" }
        syncDebugPortBanner()
        updateReadinessMatrix()
        let status = app.statusValue
        guard app.reachable else {
            if !app.bridge.isOwnedProcessRunning {
                accountStatusLabel.stringValue = L10n.t("overview.status.offline")
                accountStatusLabel.isHidden = false; accountStatusLabel.textColor = accessibleWarningColor()
            }
            return
        }
        let requestedEnvId = currentOverviewEnvironmentId()
        let activeCache = cachedSummariesByEnv[requestedEnvId] ?? (requestedEnvId == "all" ? lastSuccessfulSummary : nil)
        let hasDashboardBentoData = (activeCache?["usage"] as? [String: Any])?["todayByModel"] != nil
        if activeCache != nil && !hasDashboardBentoData {
            app.fetchUsageSummary(period: "today", environmentId: requestedEnvId == "all" ? nil : requestedEnvId, force: force) { [weak self] _ in
                self?.updateReadinessMatrix()
            }
        }
        if metricsLoading && activeRequestEnvId == requestedEnvId && !force {
            return
        }

        let now = Date()
        let lastAt = cachedSummaryFetchTimeByEnv[requestedEnvId] ?? (requestedEnvId == "all" ? lastMetricsFetchTime : .distantPast)
        let interval = now.timeIntervalSince(lastAt)
        let timeExpired = interval >= 15.0

        let currentKey = "\(app.activeAccountId)_\(status.accountsRevision)_\(status.activeAccountEmail)_\(status.activeFiveHourQuota ?? -1)_\(status.liveAccountEmail)_\(status.remoteObservedVersion)_\(status.remoteSyncRevision)_\(requestedEnvId)"
        if !force && !timeExpired && currentKey == metricsKey { return }
        metricsLoading = true
        activeRequestEnvId = requestedEnvId
        requestGeneration += 1
        let gen = requestGeneration

        var payload: [String: Any] = ["command": "dashboard_summary"]
        if requestedEnvId != "all" {
            payload["environmentId"] = requestedEnvId
        }
        app.bridge.send(payload) { [weak self] response in
            guard let self else { return }
            let isCurrentReq = (gen == self.requestGeneration && self.currentOverviewEnvironmentId() == requestedEnvId)
            if isCurrentReq {
                self.metricsLoading = false
                self.activeRequestEnvId = nil
            }
            switch response {
            case .failure(let error):
                guard isCurrentReq else { return }
                if let old = self.cachedSummariesByEnv[requestedEnvId] ?? (requestedEnvId == "all" ? self.lastSuccessfulSummary : nil) {
                    self.renderSummary(old, isStaleFallback: true)
                } else {
                    self.dataTimestampLabel.isHidden = false
                    self.dataTimestampLabel.stringValue = L10n.t("overview.status.fetch_failed", ["error": error.localizedDescription])
                    self.dataTimestampLabel.textColor = accessibleWarningColor()
                }
            case .success(let result):
                let fetchedAt = Date()
                self.cachedSummariesByEnv[requestedEnvId] = result
                self.cachedSummaryFetchTimeByEnv[requestedEnvId] = fetchedAt
                if let incomingRemotes = result["remoteSessions"] as? [[String: Any]] {
                    if let focusedStr = result["focusedContextKey"] as? String, !focusedStr.isEmpty {
                        self.app.statusValue.focusedContextKey = focusedStr
                    }
                    let focusedKey = (result["focusedContextKey"] as? String) ?? self.app.statusValue.focusedContextKey
                    self.app.syncRemoteSessionsFromPayload(incomingRemotes, focusedKey: focusedKey, notifyUI: false)
                }
                if requestedEnvId == "all" {
                    self.app.cachedDashboardBootstrapSummary = result
                    if let usageDict = result["usage"] as? [String: Any], let periodsMap = usageDict["periods"] as? [String: Any] {
                        self.app.ingestUsagePeriods(from: periodsMap, fetchedAt: fetchedAt)
                    }
                    self.app.scheduleUIBootstrapSave()
                }
                guard isCurrentReq else { return }
                self.lastMetricsFetchTime = fetchedAt
                self.metricsKey = currentKey
                self.lastSuccessfulSummary = result
                if (result["usage"] as? [String: Any])?["todayByModel"] == nil {
                    self.app.fetchUsageSummary(period: "today", environmentId: requestedEnvId == "all" ? nil : requestedEnvId, force: force) { [weak self] _ in
                        self?.updateReadinessMatrix()
                    }
                }
                self.renderSummary(result, isStaleFallback: false)
            }
        }
    }

    private static let quotaObservedFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter

    // B01: dashboard_summary returns stale_groups = [{name, observed_at}] for quota groups whose
    // values were carried over from the previous sample. Surface them as an orange warning without
    // hijacking the mailbox line; observed_at stays available in the tooltip.
    private func staleGroupSummary(_ account: [String: Any]) -> (hint: String, detail: String) {
        let rows = (account["staleGroups"] as? [[String: Any]]) ?? (account["stale_groups"] as? [[String: Any]]) ?? []
        guard !rows.isEmpty else { return ("", "") }
        let names = rows.compactMap { ($0["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let listSep = L10n.shared.isEnglish ? ", " : "、"
        let colonSep = L10n.shared.isEnglish ? ": " : "："
        let detailSep = L10n.shared.isEnglish ? "; " : "；"
        let hint = L10n.t("overview.status.stale_groups", ["count": rows.count]) + (names.isEmpty ? "" : "\(colonSep)\(names.joined(separator: listSep))")
        let details: [String] = rows.compactMap { row in
            guard let name = row["name"] as? String, !name.isEmpty else { return nil }
            let stamp = (row["observed_at"] as? Double) ?? (row["observed_at"] as? Int).map(Double.init) ?? 0
            guard stamp > 0 else { return name }
            return L10n.t("overview.status.stale_sampled", ["name": name, "time": Self.quotaObservedFormatter.string(from: Date(timeIntervalSince1970: stamp))])
        }
        return (hint, details.joined(separator: detailSep))
    }

    // B12: sanitised short message for a partial dashboard failure. The payload may carry a
    // string or an object; an absent section without an explicit error is itself a failure.
    private static func summaryError(_ result: [String: Any], _ keys: [String]) -> String {
        for key in keys {
            if let text = result[key] as? String {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
            if let object = result[key] as? [String: Any] {
                for field in ["message", "error"] {
                    if let text = object[field] as? String {
                        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty { return trimmed }
                    }
                }
            }
        }
        return ""
    }

    private static func shortError(_ text: String, limit: Int = 90) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed.isEmpty ? L10n.t("overview.status.data_read_failed") : trimmed }
        return String(trimmed.prefix(limit)) + "…"
    }

    struct QuotaBarSpec {
        let title: String
        let percentage: Int?
        let resetText: String
        let icon: String
        let placeholder: String
        let stale: Bool
    }

    static func syncQuotaBarRows(_ rows: [[QuotaBarSpec]], into stack: NSStackView, compact: Bool = true, minBarHeight: CGFloat? = nil) {
        guard !rows.isEmpty else {
            stack.arrangedSubviews.forEach {
                stack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            stack.isHidden = true
            return
        }
        stack.isHidden = false

        let existingRows = stack.arrangedSubviews.compactMap { $0 as? NSStackView }
        let canReuse = existingRows.count == rows.count && zip(existingRows, rows).allSatisfy { rowView, rowSpecs in
            let subviews = rowView.arrangedSubviews
            guard subviews.count == 2, subviews[0] is QuotaBarView else { return false }
            if rowSpecs.count == 2 { return subviews[1] is QuotaBarView }
            return !(subviews[1] is QuotaBarView)
        }
        if canReuse {
            for (rowView, rowSpecs) in zip(existingRows, rows) {
                for (idx, spec) in rowSpecs.enumerated() {
                    if let bar = rowView.arrangedSubviews[idx] as? QuotaBarView {
                        bar.update(
                            title: spec.title,
                            percentage: spec.percentage,
                            resetText: spec.resetText,
                            icon: spec.icon,
                            unknownPlaceholder: spec.placeholder,
                            stale: spec.stale
                        )
                    }
                }
            }
            return
        }

        stack.arrangedSubviews.forEach {
            stack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for rowSpecs in rows {
            guard let leftSpec = rowSpecs.first else { continue }
            let leftBar = quotaBar(
                title: leftSpec.title,
                percentage: leftSpec.percentage,
                resetText: leftSpec.resetText,
                icon: leftSpec.icon,
                unknownPlaceholder: leftSpec.placeholder,
                stale: leftSpec.stale
            )
            if compact { leftBar.useCompactLayout() } else { leftBar.useComfortableLayout() }
            if let minBarHeight { leftBar.heightAnchor.constraint(greaterThanOrEqualToConstant: minBarHeight).isActive = true }

            let rightView: NSView
            if rowSpecs.count > 1 {
                let rightSpec = rowSpecs[1]
                let rightBar = quotaBar(
                    title: rightSpec.title,
                    percentage: rightSpec.percentage,
                    resetText: rightSpec.resetText,
                    icon: rightSpec.icon,
                    unknownPlaceholder: rightSpec.placeholder,
                    stale: rightSpec.stale
                )
                if compact { rightBar.useCompactLayout() } else { rightBar.useComfortableLayout() }
                if let minBarHeight { rightBar.heightAnchor.constraint(greaterThanOrEqualToConstant: minBarHeight).isActive = true }
                rightView = rightBar
            } else {
                rightView = NSView()
            }
            let row = horizontal([leftBar, rightView], spacing: 14)
            row.distribution = .fillEqually
            row.alignment = .top
            stack.addArrangedSubview(row)
            fillWidth(row, in: stack)
        }
    }

    static func syncCoreGroupBars(_ groups: [QuotaPresentation.QuotaGroup], into stack: NSStackView, compact: Bool = true, minBarHeight: CGFloat? = nil) {
        let now = Date()
        var rows: [[QuotaBarSpec]] = []
        var pendingSingle: QuotaBarSpec? = nil
        for group in groups {
            let specs = group.windows.map { win in
                QuotaBarSpec(
                    title: group.barTitle(for: win),
                    percentage: win.percentage,
                    resetText: win.percentage == nil ? "" : win.effectiveResetText(at: now),
                    icon: group.iconName(for: win),
                    placeholder: win.placeholder(availability: group.availability),
                    stale: win.effectiveStale(at: now)
                )
            }
            guard !specs.isEmpty else { continue }
            if specs.count == 1 {
                if let first = pendingSingle {
                    rows.append([first, specs[0]])
                    pendingSingle = nil
                } else {
                    pendingSingle = specs[0]
                }
            } else {
                if let first = pendingSingle {
                    rows.append([first])
                    pendingSingle = nil
                }
                var idx = 0
                while idx < specs.count {
                    let end = min(idx + 2, specs.count)
                    rows.append(Array(specs[idx..<end]))
                    idx += 2
                }
            }
        }
        if let remaining = pendingSingle {
            rows.append([remaining])
        }
        syncQuotaBarRows(rows, into: stack, compact: compact, minBarHeight: minBarHeight)
    }

    static func syncStandaloneGroupBars(_ groups: [QuotaPresentation.QuotaGroup], into stack: NSStackView, compact: Bool = true, minBarHeight: CGFloat? = nil) {
        let now = Date()
        var specs: [QuotaBarSpec] = []
        for group in groups {
            if group.windows.isEmpty {
                let ph = group.availability == "disabled" ? L10n.t("common.unavailable") : L10n.t("common.unknown")
                specs.append(QuotaBarSpec(
                    title: group.displayName,
                    percentage: nil,
                    resetText: "",
                    icon: "sparkles",
                    placeholder: ph,
                    stale: group.quotaState == "stale"
                ))
            } else {
                for win in group.windows {
                    specs.append(QuotaBarSpec(
                        title: group.barTitle(for: win),
                        percentage: win.percentage,
                        resetText: win.percentage == nil ? "" : win.effectiveResetText(at: now),
                        icon: group.iconName(for: win),
                        placeholder: win.placeholder(availability: group.availability),
                        stale: win.effectiveStale(at: now)
                    ))
                }
            }
        }
        var rows: [[QuotaBarSpec]] = []
        var idx = 0
        while idx < specs.count {
            let end = min(idx + 2, specs.count)
            rows.append(Array(specs[idx..<end]))
            idx += 2
        }
        syncQuotaBarRows(rows, into: stack, compact: compact, minBarHeight: minBarHeight)
    }

    // B12: account half failed. Keep the retry hint local and never invent a 0% quota or an empty
    // account identity; the usage KPI area is rendered independently below.
    private func renderAccountsError(_ error: String, bothFailed: Bool) {
        let detail = Self.shortError(error)
        self.activeAccountLabel.stringValue = bothFailed ? L10n.t("overview.status.error_both") : L10n.t("overview.status.error_accounts")
        self.tierBadge.isHidden = true
        self.accountStatusLabel.isHidden = false
        self.accountStatusLabel.stringValue = L10n.t("overview.status.retry_later", ["detail": detail])
        self.accountStatusLabel.textColor = accessibleWarningColor()
        self.accountStatusLabel.toolTip = nil
        self.activeEmailLabel.stringValue = L10n.t("overview.status.retry_hint")
        self.activeEmailLabel.toolTip = nil
        let failedTxt = L10n.t("quota.read_failed")
        Self.syncQuotaBarRows([
            [
                QuotaBarSpec(title: L10n.t("quota.bar.gemini_5h"), percentage: nil, resetText: "", icon: "bolt.fill", placeholder: failedTxt, stale: false),
                QuotaBarSpec(title: L10n.t("quota.bar.gemini_weekly"), percentage: nil, resetText: "", icon: "calendar", placeholder: failedTxt, stale: false)
            ],
            [
                QuotaBarSpec(title: L10n.t("quota.bar.claude_5h"), percentage: nil, resetText: "", icon: "cpu", placeholder: failedTxt, stale: false),
                QuotaBarSpec(title: L10n.t("quota.bar.claude_weekly"), percentage: nil, resetText: "", icon: "calendar", placeholder: failedTxt, stale: false)
            ]
        ], into: coreQuotaStack, compact: true)
        standaloneDivider.isHidden = true
        Self.syncStandaloneGroupBars([], into: standaloneQuotaStack, compact: true)
    }
    // B12: usage half failed. Show an explicit error instead of 0 / $0.00 / 0 次.
    private func renderUsageError(_ error: String) {
        let detail = Self.shortError(error)
        let retryDetail = L10n.t("overview.status.retry_later", ["detail": detail])
        usageQualityLabel.isHidden = false
        usageQualityLabel.stringValue = L10n.t("overview.status.usage_error_banner"); usageQualityLabel.textColor = accessibleWarningColor()
        self.todayTokensMetric.stringValue = "—"
        self.todayTokensDetail.stringValue = retryDetail
        self.todayTokensDetail.textColor = accessibleWarningColor()
        self.todayTokensDetail.toolTip = nil
        self.usageMetric.stringValue = "—"
        self.costMetricCard?.setStatusBadge(nil)
        self.usageDetail.stringValue = retryDetail
        self.usageDetail.textColor = accessibleWarningColor()
        self.usageDetail.toolTip = nil
        self.todayRequestsMetric.stringValue = "—"
        self.todayRequestsDetail.stringValue = retryDetail
        self.todayRequestsDetail.textColor = accessibleWarningColor()
        self.todayRequestsDetail.toolTip = nil
        self.tokenMetricCard?.refreshAccessibility()
        self.costMetricCard?.refreshAccessibility()
        self.requestsMetricCard?.refreshAccessibility()
    }

    private static let fetchTimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    func renderSummary(_ result: [String: Any], isStaleFallback: Bool) {
        let signpost = PerformanceSignpost.begin("DashboardRenderSummary")
        defer { PerformanceSignpost.end("DashboardRenderSummary", signpost) }
        let resultEnvId = summaryEnvironmentId(result)
        if !isStaleFallback {
            cachedSummariesByEnv[resultEnvId] = result
        }
        animateContextTransitionIfNeeded()

        let formatter = Self.fetchTimeFormatter
        let fetchTimeStr = formatter.string(from: lastMetricsFetchTime == .distantPast ? Date() : lastMetricsFetchTime)
        // B12: dashboard_summary reports partial failures via accountsError / usageError (snake_case
        // accepted for compatibility) while still returning the other half. A missing section with
        // no explicit error is treated as a failure too, so a backend exception can never render as
        // 0 / empty data.
        let accountsDict = result["accounts"] as? [String: Any]
        let usageDict = result["usage"] as? [String: Any]
        let accountsErrorRaw = Self.summaryError(result, ["accountsError", "accounts_error"])
        let usageErrorRaw = Self.summaryError(result, ["usageError", "usage_error"])
        let accountsFailed = accountsDict == nil || !accountsErrorRaw.isEmpty
        let usageFailed = usageDict == nil || !usageErrorRaw.isEmpty
        let accountsError = accountsErrorRaw.isEmpty ? (accountsFailed ? L10n.t("overview.status.accounts_read_failed") : "") : accountsErrorRaw
        let usageError = usageErrorRaw.isEmpty ? (usageFailed ? L10n.t("overview.status.usage_read_failed") : "") : usageErrorRaw
        let fetchKey = L10n.t("overview.status.fetch_key", ["time": fetchTimeStr])
        var quotaTime = ""
        var quotaUpdateDisplay = ""
        let nestedQuotaTs = ((accountsDict?["quota"] as? [String: Any])?["last_updated"] as? Double) ?? (((accountsDict?["quota"] as? [String: Any])?["last_updated"] as? Int).map(Double.init))
        if !accountsFailed, let acc = accountsDict, let quotaTs = (acc["quotaLastUpdated"] as? Double ?? (acc["quotaLastUpdated"] as? Int).map(Double.init) ?? nestedQuotaTs), quotaTs > 0 {
            let qDate = Date(timeIntervalSince1970: quotaTs)
            quotaTime = L10n.t("overview.status.quota_sampled", ["time": formatter.string(from: qDate)])
            quotaUpdateDisplay = L10n.t("accounts.updated_at", ["time": Self.quotaObservedFormatter.string(from: qDate)])
        }

        // 1. 账号与配额（支持 总计 / 本机 / SSH 远程上下文切换；本机异常与远端异常互相隔离；仅实时 IPC 响应同步 remoteSessions）
        syncContextSwitcher()
        let currentEnvId = currentOverviewEnvironmentId()
        let reserveStatusLine = !contextSwitcherRow.isHidden && anyEnvironmentHasStatusWarning(localAccounts: accountsDict)

        dataTimestampLabel.toolTip = nil
        dataTimestampLabel.setAccessibilityHelp(L10n.t("overview.status.a11y_data_time", ["quota": quotaTime, "fetch": fetchKey]))
        let hasErrorBanner = isStaleFallback || accountsFailed || usageFailed
        if hasErrorBanner {
            dataTimestampLabel.isHidden = false
            dataTimestampLabel.stringValue = isStaleFallback ? L10n.t("overview.status.stale_fallback") : accountsFailed && usageFailed ? L10n.t("overview.status.data_read_failed") : accountsFailed ? L10n.t("overview.status.accounts_short_failed") : L10n.t("overview.status.usage_short_failed")
            dataTimestampLabel.textColor = accessibleWarningColor()
        } else if !quotaUpdateDisplay.isEmpty {
            dataTimestampLabel.isHidden = false
            dataTimestampLabel.stringValue = quotaUpdateDisplay
            dataTimestampLabel.textColor = .secondaryLabelColor
        } else if !contextSwitcherRow.isHidden {
            dataTimestampLabel.isHidden = false
            dataTimestampLabel.stringValue = L10n.t("ssh.context.no_timestamp", fallback: "暂无采样时间")
            dataTimestampLabel.textColor = .tertiaryLabelColor
        } else {
            dataTimestampLabel.isHidden = true
            dataTimestampLabel.stringValue = ""
        }

        if let remote = app.selectedOverviewRemoteSession() {
            self.renderRemoteHeroSection(remote, reserveStatusLine: reserveStatusLine)
        } else if let acc = accountsDict, !accountsFailed {
            let email = acc["activeEmail"] as? String ?? ""
            let name = acc["activeName"] as? String ?? ""
            let tier = acc["activeTier"] as? String ?? "FREE"

            let quotaContract = QuotaPresentation.contract(acc)
            let remoteEnvs = app.overviewRemoteEnvironments()
            let onlineSshCount = remoteEnvs.filter { ($0.session["state"] as? String) != "disconnected" }.count

            if email.isEmpty {
                self.activeAccountLabel.stringValue = L10n.t("overview.account.no_saved")
                applyStableStatusLine(warnings: [], hasWarning: false, forceReserveLine: reserveStatusLine)
                self.activeEmailLabel.stringValue = L10n.t("overview.account.add_hint")
                self.activeEmailLabel.toolTip = nil
                self.currentAccountPill.isHidden = true
                self.contextComparisonPill.isHidden = true
            } else {
                self.activeAccountLabel.stringValue = name.isEmpty ? email : name
                self.currentAccountPill.isHidden = true
                if !contextSwitcherRow.isHidden {
                    if app.overviewEnvironmentKey == "all" && onlineSshCount > 0 {
                        self.contextComparisonPill.title = L10n.t("ssh.context.all_online_badge", ["count": onlineSshCount], fallback: "本机 + \(onlineSshCount) 台 SSH 在线")
                        self.contextComparisonPill.tint = Design.blue
                        self.contextComparisonPill.isHidden = false
                    } else if app.overviewEnvironmentKey == "local" {
                        self.contextComparisonPill.title = L10n.t("ssh.context.local_scope_badge", fallback: "仅本机")
                        self.contextComparisonPill.tint = Design.inactivePill
                        self.contextComparisonPill.isHidden = false
                    } else {
                        self.contextComparisonPill.isHidden = true
                    }
                } else {
                    self.contextComparisonPill.isHidden = true
                }
                let isStale = acc["isStale"] as? Bool == true

                let isConnected = acc["isLiveVerified"] as? Bool == true
                let refreshErr = acc["quotaRefreshError"] as? String ?? ""
                let liveEmail = (acc["liveAccountEmail"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

                // B02: one source of truth for the badge title, its tint and the visible status
                // line; the email is rendered on its own line and is never used to replace it.
                let badgeTint: NSColor
                let statusText: String
                var isSavedOnlyBadge = false
                if !refreshErr.isEmpty {
                    badgeTint = accessibleWarningColor()
                    statusText = InterfaceText.quotaMessage(refreshErr)
                } else if isStale {
                    badgeTint = accessibleWarningColor()
                    statusText = L10n.t("overview.account.status_expired")
                } else if isConnected {
                    if !liveEmail.isEmpty && liveEmail.lowercased() == email.lowercased() {
                        badgeTint = .systemGreen
                        statusText = ""
                    } else if !liveEmail.isEmpty {
                        badgeTint = accessibleWarningColor()
                        statusText = L10n.t("overview.account.status_mismatch")
                    } else {
                        isSavedOnlyBadge = true
                        badgeTint = .secondaryLabelColor
                        statusText = ""
                    }
                } else {
                    isSavedOnlyBadge = true
                    badgeTint = .secondaryLabelColor
                    statusText = ""
                }
                // B01: stale quota groups are a warning of their own; append them to the status
                // line (and tooltip with real sampling times) but never replace the mailbox line.
                let stale = self.staleGroupSummary(acc)
                var finalBadgeTint = badgeTint
                var finalStatus = statusText
                if !stale.hint.isEmpty {
                    if isSavedOnlyBadge { finalBadgeTint = accessibleWarningColor() }
                    finalStatus = finalStatus.isEmpty ? stale.hint : "\(finalStatus) · \(stale.hint)"
                }
                let quotaWarning = QuotaPresentation.warningSummary(quotaContract)
                var warnings: [String] = []
                if !finalStatus.isEmpty { warnings.append(finalStatus) }
                if !quotaWarning.isEmpty { warnings.append(quotaWarning) }
                let hasWarning = !stale.hint.isEmpty || !quotaWarning.isEmpty || (finalBadgeTint != .secondaryLabelColor && !finalStatus.isEmpty)
                applyStableStatusLine(warnings: warnings, hasWarning: hasWarning, forceReserveLine: reserveStatusLine)
                self.activeEmailLabel.stringValue = email
                self.activeEmailLabel.toolTip = nil
            }
            let normalizedTier = AccountIdentity.normalizeTier(tier)
            self.tierBadge.title = normalizedTier.isEmpty ? tier : normalizedTier
            self.tierBadge.isHidden = email.isEmpty || tier.isEmpty

            // F04: titles state that the percentage is the remaining quota, not a share/total.
            Self.syncCoreGroupBars(quotaContract.coreGroups, into: coreQuotaStack, compact: true)
            let standaloneGroups = quotaContract.standaloneGroups
            standaloneDivider.isHidden = standaloneGroups.isEmpty
            Self.syncStandaloneGroupBars(standaloneGroups, into: standaloneQuotaStack, compact: true)
        } else {
            self.contextComparisonPill.isHidden = true
            self.renderAccountsError(accountsError, bothFailed: usageFailed)
        }
        syncLockedQuotaHeight()

        // 2. 用量与账单（严格匹配 currentEnvId，禁止跨环境串读旧合计数值）
        let matchedUsageDict: [String: Any]? = (resultEnvId == currentEnvId)
            ? usageDict
            : (cachedSummariesByEnv[currentEnvId]?["usage"] as? [String: Any])
                ?? (syntheticSummaryFromUsageCache(for: currentEnvId)?["usage"] as? [String: Any])

        if !contextSwitcherRow.isHidden {
            if currentEnvId == "all" {
                let bd = (matchedUsageDict?["environmentBreakdown"] as? [String: Any])
                    ?? (matchedUsageDict?["environment_breakdown"] as? [String: Any])
                if let shareNote = UsageFilterSupport.environmentShareNote(breakdown: bd, selectedEnvironmentId: "all") {
                    envSharePill.title = shareNote
                    envSharePill.tint = Design.inactivePill
                    envSharePill.isHidden = false
                } else {
                    envSharePill.isHidden = true
                }
            } else if currentEnvId == "local" {
                envSharePill.title = L10n.t("ssh.context.local_scope_badge", fallback: "仅本机")
                envSharePill.tint = Design.inactivePill
                envSharePill.isHidden = false
            } else {
                envSharePill.isHidden = true
            }
        } else {
            envSharePill.isHidden = true
        }

        if let usg = matchedUsageDict, !(resultEnvId == currentEnvId && usageFailed) {
            // B12: reset the warning styling left behind by a previous failure before rendering.
            self.todayTokensDetail.textColor = Design.secondary
            self.usageDetail.textColor = Design.secondary
            self.todayRequestsDetail.textColor = Design.secondary
            let todayTokens = intVal(usg, "todayTokens")
            let totalTokens = intVal(usg, "totalTokens")
            let todayUsd = doubleVal(usg, "estimatedUsd")
            let allUsd = doubleVal(usg, "allTimeEstimatedUsd", fallback: todayUsd)
            let todayRequests = intVal(usg, "requestCount")
            let totalRequests = intVal(usg, "totalRequestCount", fallback: todayRequests)
            let dbScanned = intVal(usg, "databasesScanned")
            let dbDiscovered = intVal(usg, "databasesDiscovered", fallback: dbScanned)
            let unpriced = intVal(usg, "unpricedModels")
            let hasErr = (usg["hasError"] as? Bool == true) || intVal(usg, "failedDatabasesCount") > 0

            let availability = usg["availability"] as? String ?? "complete"
            let unknown = intVal(usg, "unknownTimeRecords")
            let failed = intVal(usg, "failedDatabasesCount")
            let skipped = intVal(usg, "skippedLargeRecords")
            let showAuditScope = hasErr || failed > 0 || skipped > 0 || unknown > 0 || dbScanned < dbDiscovered || availability == "unavailable"
            self.usageQualityLabel.stringValue = InterfaceText.usageScope(scanned: dbScanned, discovered: dbDiscovered, failed: failed, skipped: skipped, unknown: unknown)
            self.usageQualityLabel.isHidden = !showAuditScope
            self.usageQualityLabel.textColor = (hasErr || failed > 0 || skipped > 0 || unknown > 0) ? accessibleWarningColor() : .secondaryLabelColor
            if availability == "unavailable" {
                self.renderUsageError(L10n.t("overview.usage.db_unavailable"))
                self.usageQualityLabel.stringValue = L10n.t("overview.usage.stats_unavailable")
                return
            }
            for label in [todayTokensDetail, usageDetail, todayRequestsDetail] { label.textColor = .secondaryLabelColor }
            let todayK = InterfaceText.formatCompactTokens(todayTokens)
            let totalK = InterfaceText.formatCompactTokens(totalTokens)

            self.todayTokensMetric.stringValue = todayK
            self.todayTokensDetail.stringValue = L10n.t("overview.metric.total_tokens", ["tokens": totalK])

            let todayUnpriced = intVal(usg, "todayUnpricedModels")
            let todayPriced = intVal(usg, "todayPricedModels")
            let allPriced = intVal(usg, "pricedModels")
            let isAllTodayUnpriced = todayUnpriced > 0 && todayPriced == 0 && todayUsd == 0
            let isPartialToday = todayUnpriced > 0 && !isAllTodayUnpriced
            self.usageMetric.stringValue = isAllTodayUnpriced
                ? L10n.t("menu_panel.usage.unpriced")
                : InterfaceText.formatUsd(todayUsd)
            self.costMetricCard?.setStatusBadge(
                isPartialToday ? L10n.t("overview.cost.partial_badge") : nil,
                tint: accessibleWarningColor()
            )
            let totalCostSummary: String
            if unpriced > 0 && allPriced == 0 && allUsd == 0 {
                totalCostSummary = L10n.t("overview.metric.total_unpriced")
            } else if unpriced > 0 {
                totalCostSummary = L10n.t("overview.metric.total_partial_cost", ["cost": InterfaceText.formatUsd(allUsd)])
            } else {
                totalCostSummary = L10n.t("overview.metric.total_cost", ["cost": InterfaceText.formatUsd(allUsd)])
            }
            self.usageDetail.stringValue = todayUnpriced > 0
                ? L10n.t("overview.metric.today_unpriced_with_total", ["count": todayUnpriced, "total": totalCostSummary])
                : totalCostSummary
            self.usageDetail.toolTip = nil
            self.costMetricCard?.titleField?.stringValue = L10n.t("overview.metric.today_cost")

            self.todayRequestsMetric.stringValue = InterfaceText.formatInteger(todayRequests)
            self.todayRequestsDetail.stringValue = L10n.t("overview.metric.total_requests", ["count": InterfaceText.formatInteger(totalRequests)])

            self.tokenMetricCard?.refreshAccessibility()
            self.costMetricCard?.refreshAccessibility()
            self.requestsMetricCard?.refreshAccessibility()
        } else if resultEnvId != currentEnvId && !usageFailed {
            self.todayTokensMetric.stringValue = "—"
            self.todayTokensDetail.stringValue = L10n.t("overview.metric.total_tokens_placeholder")
            self.usageMetric.stringValue = "—"
            self.costMetricCard?.setStatusBadge(nil)
            self.usageDetail.stringValue = L10n.t("overview.metric.total_cost_placeholder")
            self.todayRequestsMetric.stringValue = "—"
            self.todayRequestsDetail.stringValue = L10n.t("overview.metric.total_requests_placeholder")
        } else {
            self.renderUsageError(usageError)
        }
        self.syncBentoModelLimitForViewport()
        self.updateReadinessMatrix()
    }
}
