# Centrypto module index

Generated from the current working tree: **393 first-party source/config/test files**.

See [architecture](architecture.md) for runtime graphs and [operations](news-intelligence-operations.md) for the deployed VPS/local split.

Dependencies list direct static first-party imports, including type-only imports. This is a navigation index; HTTP calls, dynamic dispatch, database relationships and UI mounting are described in the architecture. Installed/generated files, data, virtual environments, lockfiles and bundled upstream RSSHub internals are excluded.

## .github

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [.github/workflows/ci.yml](../.github/workflows/ci.yml) | 22 | — |

## Root tooling

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [components.json](../components.json) | 22 | — |
| [debug-console.js](../debug-console.js) | 72 | — |
| [ecosystem.config.js](../ecosystem.config.js) | 11 | — |
| [eslint.config.mjs](../eslint.config.mjs) | 28 | — |
| [meta_response.json](../meta_response.json) | 1 | — |
| [middleware.ts](../middleware.ts) | 112 | — |
| [next.config.mjs](../next.config.mjs) | 32 | — |
| [package.json](../package.json) | 106 | — |
| [postcss.config.js](../postcss.config.js) | 6 | — |
| [puppeteer-logs.js](../puppeteer-logs.js) | 42 | — |
| [reproduce_increase.ts](../reproduce_increase.ts) | 81 | [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts), [services/SnapshotBuilder.ts](../services/SnapshotBuilder.ts) |
| [reproduce_reduce.ts](../reproduce_reduce.ts) | 75 | [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts), [services/SnapshotBuilder.ts](../services/SnapshotBuilder.ts) |
| [screenshot-ui.js](../screenshot-ui.js) | 25 | — |
| [tailwind.config.ts](../tailwind.config.ts) | 98 | — |
| [test-devstral.js](../test-devstral.js) | 115 | — |
| [test-ollama.js](../test-ollama.js) | 92 | — |
| [test-prompt-generation.mjs](../test-prompt-generation.mjs) | 345 | — |
| [test-prompt-manual.mjs](../test-prompt-manual.mjs) | 140 | — |
| [test-snapshot.mjs](../test-snapshot.mjs) | 17 | — |
| [test_prompt.ts](../test_prompt.ts) | 84 | [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [services/OrchestratorService.ts](../services/OrchestratorService.ts) |
| [tsconfig.json](../tsconfig.json) | 45 | — |

## __tests__

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [__tests__/AIAdvisor.test.tsx](../__tests__/AIAdvisor.test.tsx) | 560 | [components/AIAdvisor.tsx](../components/AIAdvisor.tsx), [lib/agent-config.ts](../lib/agent-config.ts), [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [lib/screener-config.ts](../lib/screener-config.ts) |
| [__tests__/AccountStateService.test.ts](../__tests__/AccountStateService.test.ts) | 68 | [lib/agent-config.ts](../lib/agent-config.ts), [services/AccountStateService.ts](../services/AccountStateService.ts) |
| [__tests__/AutoTraderConfig.test.ts](../__tests__/AutoTraderConfig.test.ts) | 139 | [lib/auto-trader-activity-report.ts](../lib/auto-trader-activity-report.ts), [lib/auto-trader-config.ts](../lib/auto-trader-config.ts), [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [lib/screener-config.ts](../lib/screener-config.ts) |
| [__tests__/AutoTraderReview.test.ts](../__tests__/AutoTraderReview.test.ts) | 296 | [lib/auto-trader-review/review-utils.ts](../lib/auto-trader-review/review-utils.ts), [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts) |
| [__tests__/AutoTraderService.test.ts](../__tests__/AutoTraderService.test.ts) | 176 | [services/AutoTraderService.ts](../services/AutoTraderService.ts) |
| [__tests__/AutoTraderSymbolDiagnosticsRoute.test.ts](../__tests__/AutoTraderSymbolDiagnosticsRoute.test.ts) | 70 | [app/api/auto-trader/diagnostics/symbol/route.ts](../app/api/auto-trader/diagnostics/symbol/route.ts) |
| [__tests__/BacktestStack.test.ts](../__tests__/BacktestStack.test.ts) | 1578 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts), [src/backtest/BacktestDataSource.ts](../src/backtest/BacktestDataSource.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestHydration.ts](../src/backtest/BacktestHydration.ts), [src/backtest/BacktestPortfolio.ts](../src/backtest/BacktestPortfolio.ts), [src/backtest/BacktestRunner.ts](../src/backtest/BacktestRunner.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/ExecutionBookStore.ts](../src/backtest/ExecutionBookStore.ts), [src/backtest/ExecutionSimulator.ts](../src/backtest/ExecutionSimulator.ts), [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts), [src/backtest/L2FeatureBuilder.ts](../src/backtest/L2FeatureBuilder.ts), [src/backtest/MetricsReporter.ts](../src/backtest/MetricsReporter.ts), [src/backtest/RealCandleHydrator.ts](../src/backtest/RealCandleHydrator.ts), [src/backtest/TraderPolicies.ts](../src/backtest/TraderPolicies.ts), [src/backtest/WalkForwardOptimizer.ts](../src/backtest/WalkForwardOptimizer.ts), [types/trading.ts](../types/trading.ts) |
| [__tests__/Backtester.test.tsx](../__tests__/Backtester.test.tsx) | 51 | [components/Backtester.tsx](../components/Backtester.tsx) |
| [__tests__/CandidatePromotionPolicy.test.ts](../__tests__/CandidatePromotionPolicy.test.ts) | 185 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [lib/trader/CandidatePromotionPolicy.ts](../lib/trader/CandidatePromotionPolicy.ts), [services/MarketStructureService.ts](../services/MarketStructureService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [__tests__/CandidatePromotionPriors.test.ts](../__tests__/CandidatePromotionPriors.test.ts) | 47 | [lib/candidate-promotion-priors.ts](../lib/candidate-promotion-priors.ts) |
| [__tests__/CodexProvider.test.ts](../__tests__/CodexProvider.test.ts) | 33 | [lib/llm/provider.ts](../lib/llm/provider.ts) |
| [__tests__/CodexQueue.test.ts](../__tests__/CodexQueue.test.ts) | 80 | [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [__tests__/CodexRunner.test.ts](../__tests__/CodexRunner.test.ts) | 68 | [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts) |
| [__tests__/CollectorRunner.test.ts](../__tests__/CollectorRunner.test.ts) | 49 | [services/CollectorRunner.ts](../services/CollectorRunner.ts) |
| [__tests__/ConfigEditor.test.tsx](../__tests__/ConfigEditor.test.tsx) | 162 | [components/ui/ConfigEditor.tsx](../components/ui/ConfigEditor.tsx), [lib/agent-config.ts](../lib/agent-config.ts) |
| [__tests__/ExecutionSafety.test.ts](../__tests__/ExecutionSafety.test.ts) | 215 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [__tests__/HyperliquidAccountRoute.test.ts](../__tests__/HyperliquidAccountRoute.test.ts) | 96 | [app/api/hyperliquid/account/route.ts](../app/api/hyperliquid/account/route.ts) |
| [__tests__/HyperliquidApiWallet.test.ts](../__tests__/HyperliquidApiWallet.test.ts) | 170 | [app/api/hyperliquid/api-wallet/route.ts](../app/api/hyperliquid/api-wallet/route.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts) |
| [__tests__/HyperliquidApiWalletSettings.test.tsx](../__tests__/HyperliquidApiWalletSettings.test.tsx) | 63 | [components/HyperliquidApiWalletSettings.tsx](../components/HyperliquidApiWalletSettings.tsx) |
| [__tests__/HyperliquidExecution.test.ts](../__tests__/HyperliquidExecution.test.ts) | 138 | [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts) |
| [__tests__/HyperliquidLimiter.test.ts](../__tests__/HyperliquidLimiter.test.ts) | 81 | [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [__tests__/HyperliquidWs.test.ts](../__tests__/HyperliquidWs.test.ts) | 77 | [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts) |
| [__tests__/InPlayScorer.test.ts](../__tests__/InPlayScorer.test.ts) | 78 | [lib/trader/InPlayScorer.ts](../lib/trader/InPlayScorer.ts), [services/MarketStructureService.ts](../services/MarketStructureService.ts) |
| [__tests__/KillSwitchFailClosed.test.ts](../__tests__/KillSwitchFailClosed.test.ts) | 34 | [lib/risk/execution-safety.ts](../lib/risk/execution-safety.ts) |
| [__tests__/MainnetScreenerSimulation.test.ts](../__tests__/MainnetScreenerSimulation.test.ts) | 80 | [lib/market-db.ts](../lib/market-db.ts) |
| [__tests__/MarketStructureService.test.ts](../__tests__/MarketStructureService.test.ts) | 56 | [services/MarketStructureService.ts](../services/MarketStructureService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [__tests__/MarketUniverse.test.ts](../__tests__/MarketUniverse.test.ts) | 51 | [services/MarketUniverse.ts](../services/MarketUniverse.ts) |
| [__tests__/NewsBrowserRestart.test.ts](../__tests__/NewsBrowserRestart.test.ts) | 26 | — |
| [__tests__/NewsExtractor.test.ts](../__tests__/NewsExtractor.test.ts) | 63 | — |
| [__tests__/NewsIntelligence.test.ts](../__tests__/NewsIntelligence.test.ts) | 43 | [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) |
| [__tests__/NewsIntelligencePanel.test.tsx](../__tests__/NewsIntelligencePanel.test.tsx) | 50 | [components/NewsIntelligencePanel.tsx](../components/NewsIntelligencePanel.tsx) |
| [__tests__/NewsObservation.test.ts](../__tests__/NewsObservation.test.ts) | 33 | [lib/news/observation.ts](../lib/news/observation.ts) |
| [__tests__/NewsRoutes.test.ts](../__tests__/NewsRoutes.test.ts) | 35 | [app/api/news/[...path]/route.ts](../app/api/news/[...path]/route.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [__tests__/NewsSchema.test.ts](../__tests__/NewsSchema.test.ts) | 13 | [lib/llm/schemas.ts](../lib/llm/schemas.ts) |
| [__tests__/NewsValidation.test.ts](../__tests__/NewsValidation.test.ts) | 65 | [lib/news/validation.ts](../lib/news/validation.ts), [types/news.ts](../types/news.ts) |
| [__tests__/OpenPositions.test.tsx](../__tests__/OpenPositions.test.tsx) | 82 | [components/OpenPositions.tsx](../components/OpenPositions.tsx) |
| [__tests__/OpportunityEngine.test.ts](../__tests__/OpportunityEngine.test.ts) | 82 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/trader/OpportunityEngine.ts](../lib/trader/OpportunityEngine.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [__tests__/OpportunityJournal.test.ts](../__tests__/OpportunityJournal.test.ts) | 335 | [services/OpportunityJournalService.ts](../services/OpportunityJournalService.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [__tests__/OrchestratorService.test.ts](../__tests__/OrchestratorService.test.ts) | 498 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/db.ts](../lib/db.ts), [services/OrchestratorService.ts](../services/OrchestratorService.ts) |
| [__tests__/PositionManagementMath.test.ts](../__tests__/PositionManagementMath.test.ts) | 44 | [lib/trader/position-management-math.ts](../lib/trader/position-management-math.ts) |
| [__tests__/PositionManager.test.ts](../__tests__/PositionManager.test.ts) | 386 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/trader/PositionManager.ts](../lib/trader/PositionManager.ts), [lib/trader/position-management-policy.ts](../lib/trader/position-management-policy.ts), [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [__tests__/PositionManagerOrchestrator.test.ts](../__tests__/PositionManagerOrchestrator.test.ts) | 269 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts), [services/OrchestratorService.ts](../services/OrchestratorService.ts) |
| [__tests__/PublicSentimentPrivacy.test.ts](../__tests__/PublicSentimentPrivacy.test.ts) | 27 | [app/api/sentiment/[symbol]/route.ts](../app/api/sentiment/[symbol]/route.ts), [app/api/sentiment/route.ts](../app/api/sentiment/route.ts) |
| [__tests__/RegimeService.test.ts](../__tests__/RegimeService.test.ts) | 98 | [services/RegimeService.ts](../services/RegimeService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [__tests__/ResponseParsing.test.ts](../__tests__/ResponseParsing.test.ts) | 72 | [lib/llm/LlmResponseParser.ts](../lib/llm/LlmResponseParser.ts) |
| [__tests__/RiskPlan.test.ts](../__tests__/RiskPlan.test.ts) | 131 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/risk/shared.ts](../lib/risk/shared.ts), [types/trading.ts](../types/trading.ts) |
| [__tests__/SafeLogger.test.ts](../__tests__/SafeLogger.test.ts) | 20 | [lib/log/safeLogger.ts](../lib/log/safeLogger.ts) |
| [__tests__/ScreenerDiscovery.test.ts](../__tests__/ScreenerDiscovery.test.ts) | 146 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/ScreenerService.ts](../services/ScreenerService.ts) |
| [__tests__/SentimentPanel.test.tsx](../__tests__/SentimentPanel.test.tsx) | 59 | [components/SentimentPanel.tsx](../components/SentimentPanel.tsx) |
| [__tests__/SentimentService.test.ts](../__tests__/SentimentService.test.ts) | 78 | [services/SentimentService.ts](../services/SentimentService.ts) |
| [__tests__/SetupClassifier.test.ts](../__tests__/SetupClassifier.test.ts) | 78 | [lib/trader/SetupClassifier.ts](../lib/trader/SetupClassifier.ts), [services/MarketStructureService.ts](../services/MarketStructureService.ts) |
| [__tests__/TechnicalChart.test.tsx](../__tests__/TechnicalChart.test.tsx) | 35 | [components/TechnicalChart.tsx](../components/TechnicalChart.tsx) |
| [__tests__/TradeForm.test.tsx](../__tests__/TradeForm.test.tsx) | 151 | [components/TradeForm.tsx](../components/TradeForm.tsx) |
| [__tests__/TradeHistoryService.test.ts](../__tests__/TradeHistoryService.test.ts) | 101 | [services/TradeHistoryService.ts](../services/TradeHistoryService.ts) |
| [__tests__/TraderAgent.test.ts](../__tests__/TraderAgent.test.ts) | 167 | [lib/agent-config.ts](../lib/agent-config.ts), [services/OrchestratorService.ts](../services/OrchestratorService.ts) |
| [__tests__/TraderOnlyRefactor.test.ts](../__tests__/TraderOnlyRefactor.test.ts) | 436 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [lib/trader/TraderDecisionValidator.ts](../lib/trader/TraderDecisionValidator.ts), [services/MarketDerivedMetricsService.ts](../services/MarketDerivedMetricsService.ts), [services/TraderContextBuilder.ts](../services/TraderContextBuilder.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [__tests__/TraderWorkflow.test.ts](../__tests__/TraderWorkflow.test.ts) | 290 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts), [lib/trader/TraderWorkflow.ts](../lib/trader/TraderWorkflow.ts), [src/backtest/TraderPolicies.ts](../src/backtest/TraderPolicies.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [__tests__/TradingAndRisk.test.tsx](../__tests__/TradingAndRisk.test.tsx) | 62 | [components/TradingAndRisk.tsx](../components/TradingAndRisk.tsx) |
| [__tests__/WalletConnect.test.tsx](../__tests__/WalletConnect.test.tsx) | 176 | [components/WalletConnect.tsx](../components/WalletConnect.tsx) |
| [__tests__/WalletSessionAuth.test.ts](../__tests__/WalletSessionAuth.test.ts) | 150 | [app/api/ai/analyze/route.ts](../app/api/ai/analyze/route.ts), [app/api/ai/cancel/route.ts](../app/api/ai/cancel/route.ts), [app/api/ai/job-status/route.ts](../app/api/ai/job-status/route.ts), [app/api/alerts/route.ts](../app/api/alerts/route.ts), [app/api/auth/session/route.ts](../app/api/auth/session/route.ts), [app/api/auto-trader/route.ts](../app/api/auto-trader/route.ts), [app/api/hyperliquid/api-wallet/route.ts](../app/api/hyperliquid/api-wallet/route.ts), [app/api/risk/kill-switch/route.ts](../app/api/risk/kill-switch/route.ts), [app/api/trades/route.ts](../app/api/trades/route.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [__tests__/aggregation.test.ts](../__tests__/aggregation.test.ts) | 51 | [sentiment/aggregation.ts](../sentiment/aggregation.ts), [sentiment/config.ts](../sentiment/config.ts) |
| [__tests__/execution-cost.test.ts](../__tests__/execution-cost.test.ts) | 133 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [lib/trading/execution-cost.ts](../lib/trading/execution-cost.ts), [services/MarketDerivedMetricsService.ts](../services/MarketDerivedMetricsService.ts), [services/ScreenerService.ts](../services/ScreenerService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [__tests__/scorer.test.ts](../__tests__/scorer.test.ts) | 20 | [sentiment/scorer.ts](../sentiment/scorer.ts) |
| [__tests__/server-only.ts](../__tests__/server-only.ts) | 1 | — |
| [__tests__/setup.ts](../__tests__/setup.ts) | 46 | — |
| [__tests__/symbolMapper.test.ts](../__tests__/symbolMapper.test.ts) | 21 | [sentiment/symbolMapper.ts](../sentiment/symbolMapper.ts) |

## app

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [app/actions/trade.ts](../app/actions/trade.ts) | 122 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts), [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts), [lib/log/safeLogger.ts](../lib/log/safeLogger.ts), [lib/risk/execution-safety.ts](../lib/risk/execution-safety.ts) |
| [app/api/ai/analyze/route.ts](../app/api/ai/analyze/route.ts) | 83 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [services/CollectorRunner.ts](../services/CollectorRunner.ts), [services/OrchestratorService.ts](../services/OrchestratorService.ts) |
| [app/api/ai/cancel/route.ts](../app/api/ai/cancel/route.ts) | 54 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/db.ts](../lib/db.ts), [services/OrchestratorService.ts](../services/OrchestratorService.ts) |
| [app/api/ai/cleanup-jobs/route.ts](../app/api/ai/cleanup-jobs/route.ts) | 54 | [lib/auth/internal.ts](../lib/auth/internal.ts), [lib/db.ts](../lib/db.ts) |
| [app/api/ai/job-status/route.ts](../app/api/ai/job-status/route.ts) | 44 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/db.ts](../lib/db.ts) |
| [app/api/ai/models/route.ts](../app/api/ai/models/route.ts) | 47 | [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [app/api/alerts/route.ts](../app/api/alerts/route.ts) | 159 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [services/PriceAlertsService.ts](../services/PriceAlertsService.ts) |
| [app/api/auth/challenge/route.ts](../app/api/auth/challenge/route.ts) | 19 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [app/api/auth/logout/route.ts](../app/api/auth/logout/route.ts) | 8 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [app/api/auth/session/route.ts](../app/api/auth/session/route.ts) | 40 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [app/api/auth/verify/route.ts](../app/api/auth/verify/route.ts) | 34 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [app/api/auto-trader/diagnostics/outcomes/route.ts](../app/api/auto-trader/diagnostics/outcomes/route.ts) | 20 | [lib/auth/internal.ts](../lib/auth/internal.ts), [services/OpportunityJournalService.ts](../services/OpportunityJournalService.ts) |
| [app/api/auto-trader/diagnostics/symbol/route.ts](../app/api/auto-trader/diagnostics/symbol/route.ts) | 34 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/auto-trader-review/review-utils.ts](../lib/auto-trader-review/review-utils.ts), [services/OpportunityJournalService.ts](../services/OpportunityJournalService.ts) |
| [app/api/auto-trader/prior-buckets/route.ts](../app/api/auto-trader/prior-buckets/route.ts) | 40 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/candidate-promotion-priors.ts](../lib/candidate-promotion-priors.ts), [services/AutoTraderService.ts](../services/AutoTraderService.ts) |
| [app/api/auto-trader/review/route.ts](../app/api/auto-trader/review/route.ts) | 38 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/auto-trader-review/review-utils.ts](../lib/auto-trader-review/review-utils.ts), [services/AutoTraderReviewService.ts](../services/AutoTraderReviewService.ts) |
| [app/api/auto-trader/review/sync/route.ts](../app/api/auto-trader/review/sync/route.ts) | 36 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts), [services/AutoTraderReviewService.ts](../services/AutoTraderReviewService.ts) |
| [app/api/auto-trader/route.ts](../app/api/auto-trader/route.ts) | 50 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [services/AutoTraderService.ts](../services/AutoTraderService.ts) |
| [app/api/backtest/run/route.ts](../app/api/backtest/run/route.ts) | 117 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/auth/internal.ts](../lib/auth/internal.ts), [lib/screener-config.ts](../lib/screener-config.ts), [src/backtest/BacktestRunner.ts](../src/backtest/BacktestRunner.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |
| [app/api/candles/route.ts](../app/api/candles/route.ts) | 136 | [lib/market-db.ts](../lib/market-db.ts) |
| [app/api/cron/sentiment/route.ts](../app/api/cron/sentiment/route.ts) | 36 | [lib/auth/internal.ts](../lib/auth/internal.ts), [services/SentimentService.ts](../services/SentimentService.ts) |
| [app/api/hyperliquid/account/route.ts](../app/api/hyperliquid/account/route.ts) | 113 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [app/api/hyperliquid/api-wallet/route.ts](../app/api/hyperliquid/api-wallet/route.ts) | 79 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts) |
| [app/api/indicators/route.ts](../app/api/indicators/route.ts) | 82 | [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts) |
| [app/api/llm/history/route.ts](../app/api/llm/history/route.ts) | 150 | [lib/auth/internal.ts](../lib/auth/internal.ts), [lib/db.ts](../lib/db.ts) |
| [app/api/news/[...path]/route.ts](../app/api/news/[...path]/route.ts) | 57 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/news-db.ts](../lib/news-db.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts), [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) |
| [app/api/risk/kill-switch/route.ts](../app/api/risk/kill-switch/route.ts) | 28 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/risk/kill-switch.ts](../lib/risk/kill-switch.ts) |
| [app/api/screener/route.ts](../app/api/screener/route.ts) | 275 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/CollectorRunner.ts](../services/CollectorRunner.ts), [services/ScreenerService.ts](../services/ScreenerService.ts) |
| [app/api/sentiment/[symbol]/route.ts](../app/api/sentiment/[symbol]/route.ts) | 22 | [sentiment/config.ts](../sentiment/config.ts), [services/SentimentService.ts](../services/SentimentService.ts) |
| [app/api/sentiment/model/route.ts](../app/api/sentiment/model/route.ts) | 24 | [sentiment/config.ts](../sentiment/config.ts), [services/SentimentService.ts](../services/SentimentService.ts) |
| [app/api/sentiment/route.ts](../app/api/sentiment/route.ts) | 59 | [lib/db.ts](../lib/db.ts), [sentiment/config.ts](../sentiment/config.ts), [services/SentimentService.ts](../services/SentimentService.ts) |
| [app/api/trade/execute/route.ts](../app/api/trade/execute/route.ts) | 10 | — |
| [app/api/trades/route.ts](../app/api/trades/route.ts) | 136 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [services/TradeHistoryService.ts](../services/TradeHistoryService.ts) |
| [app/backtester/page.tsx](../app/backtester/page.tsx) | 27 | [components/Backtester.tsx](../components/Backtester.tsx), [components/ui/button.tsx](../components/ui/button.tsx) |
| [app/globals.css](../app/globals.css) | 203 | — |
| [app/layout.tsx](../app/layout.tsx) | 29 | [app/globals.css](../app/globals.css), [components/Providers.tsx](../components/Providers.tsx) |
| [app/page.tsx](../app/page.tsx) | 49 | [components/AdvancedIndicators.tsx](../components/AdvancedIndicators.tsx), [components/HyperliquidFeed.tsx](../components/HyperliquidFeed.tsx), [components/LeftNavigation.tsx](../components/LeftNavigation.tsx), [components/NewsIntelligencePanel.tsx](../components/NewsIntelligencePanel.tsx), [components/PositionsTable.tsx](../components/PositionsTable.tsx), [components/TechnicalChart.tsx](../components/TechnicalChart.tsx), [components/TopHeader.tsx](../components/TopHeader.tsx), [components/TradingAndRisk.tsx](../components/TradingAndRisk.tsx) |

## backtest_py

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [backtest_py/__init__.py](../backtest_py/__init__.py) | 2 | — |
| [backtest_py/export_recorded_backend.py](../backtest_py/export_recorded_backend.py) | 934 | — |
| [backtest_py/export_recorded_backend_test.py](../backtest_py/export_recorded_backend_test.py) | 446 | [backtest_py/__init__.py](../backtest_py/__init__.py), [backtest_py/export_recorded_backend.py](../backtest_py/export_recorded_backend.py) |
| [backtest_py/investigate_momentum_short.py](../backtest_py/investigate_momentum_short.py) | 1333 | — |
| [backtest_py/optimizer.py](../backtest_py/optimizer.py) | 8904 | — |
| [backtest_py/optimizer_hardening_test.py](../backtest_py/optimizer_hardening_test.py) | 1781 | [backtest_py/__init__.py](../backtest_py/__init__.py) |
| [backtest_py/parquet_store.py](../backtest_py/parquet_store.py) | 451 | — |
| [backtest_py/tests/test_momentum_short_investigation.py](../backtest_py/tests/test_momentum_short_investigation.py) | 220 | [backtest_py/__init__.py](../backtest_py/__init__.py) |

## collector

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [collector/browser.ts](../collector/browser.ts) | 35 | — |
| [collector/deploy/activate.py](../collector/deploy/activate.py) | 89 | — |
| [collector/deploy/grants.sql](../collector/deploy/grants.sql) | 10 | — |
| [collector/deploy/install.sh](../collector/deploy/install.sh) | 64 | — |
| [collector/deploy/interactive_chrome.sh](../collector/deploy/interactive_chrome.sh) | 19 | — |
| [collector/deploy/pair_owner.py](../collector/deploy/pair_owner.py) | 19 | — |
| [collector/extension/background.js](../collector/extension/background.js) | 66 | — |
| [collector/extension/extractor.js](../collector/extension/extractor.js) | 89 | — |
| [collector/extension/manifest.json](../collector/extension/manifest.json) | 11 | — |
| [collector/extension/options.html](../collector/extension/options.html) | 3 | — |
| [collector/extension/options.js](../collector/extension/options.js) | 16 | — |
| [collector/server.ts](../collector/server.ts) | 106 | [lib/news/observation.ts](../lib/news/observation.ts), [lib/news/validation.ts](../lib/news/validation.ts), [lib/news-db.ts](../lib/news-db.ts), [types/news.ts](../types/news.ts) |

## components

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [components/AIAdvisor.tsx](../components/AIAdvisor.tsx) | 1143 | [app/actions/trade.ts](../app/actions/trade.ts), [components/ui/ConfigEditor.tsx](../components/ui/ConfigEditor.tsx), [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/select.tsx](../components/ui/select.tsx), [components/ui/sheet.tsx](../components/ui/sheet.tsx), [components/ui/switch.tsx](../components/ui/switch.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx), [lib/agent-config.ts](../lib/agent-config.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/screening-storage.ts](../lib/screening-storage.ts), [lib/trade-utils.ts](../lib/trade-utils.ts), [types/trading.ts](../types/trading.ts) |
| [components/AdvancedIndicators.tsx](../components/AdvancedIndicators.tsx) | 247 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/AutoTraderReview.tsx](../components/AutoTraderReview.tsx) | 310 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/Backtester.tsx](../components/Backtester.tsx) | 222 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/label.tsx](../components/ui/label.tsx) |
| [components/CandidatePromotionRulesPanel.tsx](../components/CandidatePromotionRulesPanel.tsx) | 826 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/select.tsx](../components/ui/select.tsx), [components/ui/sheet.tsx](../components/ui/sheet.tsx), [components/ui/switch.tsx](../components/ui/switch.tsx), [components/ui/table.tsx](../components/ui/table.tsx), [lib/agent-config.ts](../lib/agent-config.ts), [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [types/trading.ts](../types/trading.ts) |
| [components/Dashboard.tsx](../components/Dashboard.tsx) | 112 | [components/ui/card.tsx](../components/ui/card.tsx), [hooks/useAccountData.ts](../hooks/useAccountData.ts) |
| [components/ExecutionPanel.tsx](../components/ExecutionPanel.tsx) | 62 | [components/AIAdvisor.tsx](../components/AIAdvisor.tsx), [components/LlmDecisionsLog.tsx](../components/LlmDecisionsLog.tsx), [components/TradeForm.tsx](../components/TradeForm.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/tabs.tsx](../components/ui/tabs.tsx) |
| [components/HyperliquidApiWalletSettings.tsx](../components/HyperliquidApiWalletSettings.tsx) | 210 | [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/label.tsx](../components/ui/label.tsx) |
| [components/HyperliquidFeed.tsx](../components/HyperliquidFeed.tsx) | 329 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx), [lib/screening-storage.ts](../lib/screening-storage.ts), [lib/utils.ts](../lib/utils.ts) |
| [components/LeftNavigation.tsx](../components/LeftNavigation.tsx) | 288 | [components/ScreeningParameters.tsx](../components/ScreeningParameters.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/popover.tsx](../components/ui/popover.tsx), [components/ui/sheet.tsx](../components/ui/sheet.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx), [lib/screening-storage.ts](../lib/screening-storage.ts) |
| [components/LlmDecisionsLog.tsx](../components/LlmDecisionsLog.tsx) | 250 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/NewsIntelligencePanel.tsx](../components/NewsIntelligencePanel.tsx) | 147 | [context/TradingContext.tsx](../context/TradingContext.tsx), [types/news.ts](../types/news.ts) |
| [components/OpenPositions.tsx](../components/OpenPositions.tsx) | 371 | [app/actions/trade.ts](../app/actions/trade.ts), [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/tabs.tsx](../components/ui/tabs.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/PositionsTable.tsx](../components/PositionsTable.tsx) | 874 | [app/actions/trade.ts](../app/actions/trade.ts), [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/table.tsx](../components/ui/table.tsx), [components/ui/tabs.tsx](../components/ui/tabs.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx), [lib/trade-utils.ts](../lib/trade-utils.ts) |
| [components/PriceAlerts.tsx](../components/PriceAlerts.tsx) | 250 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/select.tsx](../components/ui/select.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/Providers.tsx](../components/Providers.tsx) | 14 | [components/Web3Provider.tsx](../components/Web3Provider.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/ScreeningParameters.tsx](../components/ScreeningParameters.tsx) | 434 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/label-with-tooltip.tsx](../components/ui/label-with-tooltip.tsx), [components/ui/switch.tsx](../components/ui/switch.tsx), [components/ui/tooltip.tsx](../components/ui/tooltip.tsx), [lib/screener-config.ts](../lib/screener-config.ts), [lib/screening-storage.ts](../lib/screening-storage.ts) |
| [components/SentimentPanel.tsx](../components/SentimentPanel.tsx) | 211 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/TechnicalChart.tsx](../components/TechnicalChart.tsx) | 292 | [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/select.tsx](../components/ui/select.tsx), [components/ui/toggle.tsx](../components/ui/toggle.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/TopHeader.tsx](../components/TopHeader.tsx) | 104 | [components/WalletConnect.tsx](../components/WalletConnect.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx), [hooks/useAccountData.ts](../hooks/useAccountData.ts) |
| [components/TradeForm.tsx](../components/TradeForm.tsx) | 343 | [app/actions/trade.ts](../app/actions/trade.ts), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/label.tsx](../components/ui/label.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/TradingAndRisk.tsx](../components/TradingAndRisk.tsx) | 82 | [components/AIAdvisor.tsx](../components/AIAdvisor.tsx), [components/AutoTraderReview.tsx](../components/AutoTraderReview.tsx), [components/HyperliquidApiWalletSettings.tsx](../components/HyperliquidApiWalletSettings.tsx), [components/LlmDecisionsLog.tsx](../components/LlmDecisionsLog.tsx), [components/TradeForm.tsx](../components/TradeForm.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/tabs.tsx](../components/ui/tabs.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/WalletConnect.tsx](../components/WalletConnect.tsx) | 221 | [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/label.tsx](../components/ui/label.tsx), [components/ui/switch.tsx](../components/ui/switch.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/Web3Provider.tsx](../components/Web3Provider.tsx) | 47 | — |
| [components/ui/ConfigEditor.tsx](../components/ui/ConfigEditor.tsx) | 1205 | [components/CandidatePromotionRulesPanel.tsx](../components/CandidatePromotionRulesPanel.tsx), [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/label-with-tooltip.tsx](../components/ui/label-with-tooltip.tsx), [components/ui/switch.tsx](../components/ui/switch.tsx), [components/ui/tabs.tsx](../components/ui/tabs.tsx), [components/ui/tooltip.tsx](../components/ui/tooltip.tsx), [lib/agent-config.ts](../lib/agent-config.ts), [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [types/trading.ts](../types/trading.ts) |
| [components/ui/badge.tsx](../components/ui/badge.tsx) | 36 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/button.tsx](../components/ui/button.tsx) | 57 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/card.tsx](../components/ui/card.tsx) | 76 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/input.tsx](../components/ui/input.tsx) | 22 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/label-with-tooltip.tsx](../components/ui/label-with-tooltip.tsx) | 43 | [components/ui/tooltip.tsx](../components/ui/tooltip.tsx), [lib/utils.ts](../lib/utils.ts) |
| [components/ui/label.tsx](../components/ui/label.tsx) | 26 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/popover.tsx](../components/ui/popover.tsx) | 33 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/select.tsx](../components/ui/select.tsx) | 159 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/sheet.tsx](../components/ui/sheet.tsx) | 144 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/switch.tsx](../components/ui/switch.tsx) | 29 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/table.tsx](../components/ui/table.tsx) | 120 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/tabs.tsx](../components/ui/tabs.tsx) | 54 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/toggle.tsx](../components/ui/toggle.tsx) | 45 | [lib/utils.ts](../lib/utils.ts) |
| [components/ui/tooltip.tsx](../components/ui/tooltip.tsx) | 39 | [lib/utils.ts](../lib/utils.ts) |

## config

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [config/aggregation.json](../config/aggregation.json) | 9 | — |
| [config/feeds.json](../config/feeds.json) | 27 | — |
| [config/lexicon.json](../config/lexicon.json) | 199 | — |
| [config/lexicon_zh.json](../config/lexicon_zh.json) | 101 | — |
| [config/news-sources.json](../config/news-sources.json) | 10 | — |
| [config/symbols.json](../config/symbols.json) | 755 | — |

## context

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [context/TradingContext.tsx](../context/TradingContext.tsx) | 109 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |

## examples

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [examples/backtest_runner_demo.py](../examples/backtest_runner_demo.py) | 122 | — |

## hooks

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [hooks/useAccountData.ts](../hooks/useAccountData.ts) | 105 | [context/TradingContext.tsx](../context/TradingContext.tsx) |

## lib

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [lib/activeNetwork.ts](../lib/activeNetwork.ts) | 14 | — |
| [lib/agent-config.ts](../lib/agent-config.ts) | 1372 | [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [lib/trader/position-management-policy.ts](../lib/trader/position-management-policy.ts), [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts) |
| [lib/auth/internal.ts](../lib/auth/internal.ts) | 30 | — |
| [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) | 217 | — |
| [lib/auto-trader-activity-report.ts](../lib/auto-trader-activity-report.ts) | 63 | [lib/auto-trader-config.ts](../lib/auto-trader-config.ts) |
| [lib/auto-trader-config.ts](../lib/auto-trader-config.ts) | 122 | [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [lib/screener-config.ts](../lib/screener-config.ts) |
| [lib/auto-trader-review/review-utils.ts](../lib/auto-trader-review/review-utils.ts) | 602 | [types/auto-trader-review.ts](../types/auto-trader-review.ts) |
| [lib/candidate-promotion-priors.ts](../lib/candidate-promotion-priors.ts) | 153 | [lib/candidate-promotion.ts](../lib/candidate-promotion.ts) |
| [lib/candidate-promotion.ts](../lib/candidate-promotion.ts) | 299 | [services/MarketStructureService.ts](../services/MarketStructureService.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [lib/db.ts](../lib/db.ts) | 20 | — |
| [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts) | 285 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/db.ts](../lib/db.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts) | 299 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/log/safeLogger.ts](../lib/log/safeLogger.ts), [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) | 279 | [lib/log/safeLogger.ts](../lib/log/safeLogger.ts), [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts) | 219 | — |
| [lib/hyperliquid.ts](../lib/hyperliquid.ts) | 1 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [lib/hyperliquidExecution.ts](../lib/hyperliquidExecution.ts) | 109 | [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts), [types/trading.ts](../types/trading.ts) |
| [lib/llm/LlmResponseParser.ts](../lib/llm/LlmResponseParser.ts) | 235 | [types/trading.ts](../types/trading.ts) |
| [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts) | 120 | — |
| [lib/llm/provider.ts](../lib/llm/provider.ts) | 80 | [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [lib/llm/schemas.ts](../lib/llm/schemas.ts) | 28 | — |
| [lib/log/safeLogger.ts](../lib/log/safeLogger.ts) | 82 | — |
| [lib/log/traderLog.ts](../lib/log/traderLog.ts) | 21 | — |
| [lib/log/tradingLogger.ts](../lib/log/tradingLogger.ts) | 37 | — |
| [lib/market-db.ts](../lib/market-db.ts) | 26 | — |
| [lib/news/observation.ts](../lib/news/observation.ts) | 11 | [lib/news/validation.ts](../lib/news/validation.ts) |
| [lib/news/validation.ts](../lib/news/validation.ts) | 76 | [types/news.ts](../types/news.ts) |
| [lib/news-db.ts](../lib/news-db.ts) | 6 | — |
| [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) | 198 | — |
| [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts) | 379 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/risk/shared.ts](../lib/risk/shared.ts), [services/SnapshotBuilder.ts](../services/SnapshotBuilder.ts), [types/trading.ts](../types/trading.ts) |
| [lib/risk/execution-safety.ts](../lib/risk/execution-safety.ts) | 26 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/risk/kill-switch.ts](../lib/risk/kill-switch.ts), [services/AccountStateService.ts](../services/AccountStateService.ts) |
| [lib/risk/kill-switch.ts](../lib/risk/kill-switch.ts) | 59 | [lib/db.ts](../lib/db.ts), [lib/log/safeLogger.ts](../lib/log/safeLogger.ts) |
| [lib/risk/shared.ts](../lib/risk/shared.ts) | 299 | [lib/agent-config.ts](../lib/agent-config.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [lib/screener-config.ts](../lib/screener-config.ts) | 217 | — |
| [lib/screening-storage.ts](../lib/screening-storage.ts) | 121 | [lib/auto-trader-config.ts](../lib/auto-trader-config.ts), [lib/screener-config.ts](../lib/screener-config.ts) |
| [lib/trade-utils.ts](../lib/trade-utils.ts) | 39 | — |
| [lib/trader/CandidatePromotionPolicy.ts](../lib/trader/CandidatePromotionPolicy.ts) | 141 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [lib/trader/InPlayScorer.ts](../lib/trader/InPlayScorer.ts) | 85 | [services/MarketStructureService.ts](../services/MarketStructureService.ts) |
| [lib/trader/OpportunityEngine.ts](../lib/trader/OpportunityEngine.ts) | 111 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/trader/InPlayScorer.ts](../lib/trader/InPlayScorer.ts), [lib/trader/SetupClassifier.ts](../lib/trader/SetupClassifier.ts), [services/MarketStructureService.ts](../services/MarketStructureService.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [lib/trader/PositionManager.ts](../lib/trader/PositionManager.ts) | 523 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/trader/position-management-math.ts](../lib/trader/position-management-math.ts), [lib/trader/position-management-policy.ts](../lib/trader/position-management-policy.ts), [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [lib/trader/SetupClassifier.ts](../lib/trader/SetupClassifier.ts) | 156 | [services/MarketStructureService.ts](../services/MarketStructureService.ts), [types/trading.ts](../types/trading.ts) |
| [lib/trader/TraderDecisionValidator.ts](../lib/trader/TraderDecisionValidator.ts) | 93 | [lib/trader/playbook-utils.ts](../lib/trader/playbook-utils.ts), [types/trading.ts](../types/trading.ts) |
| [lib/trader/TraderWorkflow.ts](../lib/trader/TraderWorkflow.ts) | 291 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts), [lib/trader/playbook-utils.ts](../lib/trader/playbook-utils.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [lib/trader/playbook-utils.ts](../lib/trader/playbook-utils.ts) | 33 | [types/trading.ts](../types/trading.ts) |
| [lib/trader/position-management-math.ts](../lib/trader/position-management-math.ts) | 86 | [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts) |
| [lib/trader/position-management-policy.ts](../lib/trader/position-management-policy.ts) | 271 | [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts) |
| [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts) | 261 | [lib/agent-config.ts](../lib/agent-config.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [lib/trading/execution-cost.ts](../lib/trading/execution-cost.ts) | 29 | — |
| [lib/utils.ts](../lib/utils.ts) | 6 | — |

## prisma

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [prisma/local-intelligence/schema.prisma](../prisma/local-intelligence/schema.prisma) | 53 | — |
| [prisma/market/migrations/20251125081655_init/migration.sql](../prisma/market/migrations/20251125081655_init/migration.sql) | 40 | — |
| [prisma/market/migrations/20260523000000_add_market_candle_source/migration.sql](../prisma/market/migrations/20260523000000_add_market_candle_source/migration.sql) | 2 | — |
| [prisma/market/migrations/20260531000000_add_market_candle_readiness_index/migration.sql](../prisma/market/migrations/20260531000000_add_market_candle_readiness_index/migration.sql) | 3 | — |
| [prisma/market/migrations/migration_lock.toml](../prisma/market/migrations/migration_lock.toml) | 3 | — |
| [prisma/market/schema.prisma](../prisma/market/schema.prisma) | 48 | — |
| [prisma/migrate_data.sql](../prisma/migrate_data.sql) | 29 | — |
| [prisma/migrations/20251127075739_init_with_analysis_job/migration.sql](../prisma/migrations/20251127075739_init_with_analysis_job/migration.sql) | 163 | — |
| [prisma/migrations/20260427000000_add_candidate_journal/migration.sql](../prisma/migrations/20260427000000_add_candidate_journal/migration.sql) | 37 | — |
| [prisma/migrations/20260430000000_add_wallet_risk_control/migration.sql](../prisma/migrations/20260430000000_add_wallet_risk_control/migration.sql) | 15 | — |
| [prisma/migrations/20260430001000_add_user_hyperliquid_api_wallet/migration.sql](../prisma/migrations/20260430001000_add_user_hyperliquid_api_wallet/migration.sql) | 25 | — |
| [prisma/migrations/20260430002000_limit_analysis_jobs_per_wallet/migration.sql](../prisma/migrations/20260430002000_limit_analysis_jobs_per_wallet/migration.sql) | 33 | — |
| [prisma/migrations/20260524000000_add_auto_trader_settings/migration.sql](../prisma/migrations/20260524000000_add_auto_trader_settings/migration.sql) | 19 | — |
| [prisma/migrations/20260525000000_add_auto_trader_review/migration.sql](../prisma/migrations/20260525000000_add_auto_trader_review/migration.sql) | 197 | — |
| [prisma/migrations/20260525001000_auto_trader_position_protection/migration.sql](../prisma/migrations/20260525001000_auto_trader_position_protection/migration.sql) | 86 | — |
| [prisma/migrations/20260601000000_add_opportunity_journal/migration.sql](../prisma/migrations/20260601000000_add_opportunity_journal/migration.sql) | 36 | — |
| [prisma/migrations/20260605000000_candidate_promotion_rules/migration.sql](../prisma/migrations/20260605000000_candidate_promotion_rules/migration.sql) | 16 | — |
| [prisma/migrations/20261031000000_local_intelligence/migration.sql](../prisma/migrations/20261031000000_local_intelligence/migration.sql) | 56 | — |
| [prisma/migrations/migration_lock.toml](../prisma/migrations/migration_lock.toml) | 3 | — |
| [prisma/news/migrations/20261031000000_news_intelligence/migration.sql](../prisma/news/migrations/20261031000000_news_intelligence/migration.sql) | 144 | — |
| [prisma/news/migrations/migration_lock.toml](../prisma/news/migrations/migration_lock.toml) | 1 | — |
| [prisma/news/schema.prisma](../prisma/news/schema.prisma) | 112 | — |
| [prisma/runtime-market/migrations/20261031000000_vps_market/migration.sql](../prisma/runtime-market/migrations/20261031000000_vps_market/migration.sql) | 49 | — |
| [prisma/runtime-market/migrations/migration_lock.toml](../prisma/runtime-market/migrations/migration_lock.toml) | 1 | — |
| [prisma/runtime-market/schema.prisma](../prisma/runtime-market/schema.prisma) | 48 | — |
| [prisma/schema.dev.prisma](../prisma/schema.dev.prisma) | 115 | — |
| [prisma/schema.prisma](../prisma/schema.prisma) | 597 | — |

## prompts

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [prompts/NewsAnalyst.ts](../prompts/NewsAnalyst.ts) | 12 | — |
| [prompts/TraderAgent.ts](../prompts/TraderAgent.ts) | 107 | — |

## scripts

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [scripts/adhoc_backfill_48h.ts](../scripts/adhoc_backfill_48h.ts) | 87 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/aggregateSentiment.ts](../scripts/aggregateSentiment.ts) | 12 | [lib/db.ts](../lib/db.ts), [sentiment/pipeline.ts](../sentiment/pipeline.ts) |
| [scripts/backfill_24h.ts](../scripts/backfill_24h.ts) | 78 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/backfill_testnet_only.ts](../scripts/backfill_testnet_only.ts) | 74 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/backtest_candles.ts](../scripts/backtest_candles.ts) | 116 | [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts), [src/backtest/RealCandleHydrator.ts](../src/backtest/RealCandleHydrator.ts) |
| [scripts/backtest_features.ts](../scripts/backtest_features.ts) | 102 | [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts), [src/backtest/L2FeatureBuilder.ts](../src/backtest/L2FeatureBuilder.ts) |
| [scripts/backtest_optimize.ts](../scripts/backtest_optimize.ts) | 376 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts), [src/backtest/BacktestHydration.ts](../src/backtest/BacktestHydration.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/WalkForwardOptimizer.ts](../src/backtest/WalkForwardOptimizer.ts) |
| [scripts/backtest_optimize_polars.py](../scripts/backtest_optimize_polars.py) | 12 | [backtest_py/optimizer.py](../backtest_py/optimizer.py) |
| [scripts/backtest_optimize_py.ts](../scripts/backtest_optimize_py.ts) | 504 | [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts), [src/backtest/BacktestHydration.ts](../src/backtest/BacktestHydration.ts) |
| [scripts/backtest_parquet.py](../scripts/backtest_parquet.py) | 11 | [backtest_py/parquet_store.py](../backtest_py/parquet_store.py) |
| [scripts/backtest_run.ts](../scripts/backtest_run.ts) | 167 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts), [src/backtest/BacktestHydration.ts](../src/backtest/BacktestHydration.ts), [src/backtest/BacktestRunner.ts](../src/backtest/BacktestRunner.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |
| [scripts/backtest_walkforward.ts](../scripts/backtest_walkforward.ts) | 309 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts), [src/backtest/BacktestHydration.ts](../src/backtest/BacktestHydration.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/WalkForwardOptimizer.ts](../src/backtest/WalkForwardOptimizer.ts) |
| [scripts/build_collectors.mjs](../scripts/build_collectors.mjs) | 16 | — |
| [scripts/check_db_counts.ts](../scripts/check_db_counts.ts) | 17 | [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/check_rescore_status.ts](../scripts/check_rescore_status.ts) | 54 | [lib/db.ts](../lib/db.ts) |
| [scripts/check_vol.ts](../scripts/check_vol.ts) | 28 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/compare_screener_live_vs_s3.ts](../scripts/compare_screener_live_vs_s3.ts) | 647 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [services/ScreenerService.ts](../services/ScreenerService.ts), [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts) |
| [scripts/configure_vps.mjs](../scripts/configure_vps.mjs) | 36 | — |
| [scripts/debug-hyperliquid.ts](../scripts/debug-hyperliquid.ts) | 51 | — |
| [scripts/debug_analytics.ts](../scripts/debug_analytics.ts) | 81 | [services/TradeHistoryService.ts](../services/TradeHistoryService.ts) |
| [scripts/debug_backfill.ts](../scripts/debug_backfill.ts) | 23 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [services/MarketCollectorService.ts](../services/MarketCollectorService.ts) |
| [scripts/debug_ftm.ts](../scripts/debug_ftm.ts) | 18 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/debug_llm_history.ts](../scripts/debug_llm_history.ts) | 39 | [lib/db.ts](../lib/db.ts) |
| [scripts/debug_ohlcv.ts](../scripts/debug_ohlcv.ts) | 16 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/debug_testnet.ts](../scripts/debug_testnet.ts) | 25 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/diagnose_news.ts](../scripts/diagnose_news.ts) | 23 | [lib/db.ts](../lib/db.ts), [lib/news/validation.ts](../lib/news/validation.ts), [lib/news-db.ts](../lib/news-db.ts) |
| [scripts/download_hl_l2.ts](../scripts/download_hl_l2.ts) | 293 | — |
| [scripts/enable_wal.ts](../scripts/enable_wal.ts) | 26 | [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/evaluate_news.ts](../scripts/evaluate_news.ts) | 32 | [lib/db.ts](../lib/db.ts), [lib/llm/schemas.ts](../lib/llm/schemas.ts), [lib/news/validation.ts](../lib/news/validation.ts), [prompts/NewsAnalyst.ts](../prompts/NewsAnalyst.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [scripts/export_auto_trader_activity_report.ts](../scripts/export_auto_trader_activity_report.ts) | 35 | [lib/auto-trader-activity-report.ts](../lib/auto-trader-activity-report.ts), [lib/db.ts](../lib/db.ts) |
| [scripts/generate_module_index.py](../scripts/generate_module_index.py) | 54 | — |
| [scripts/ingestRss.ts](../scripts/ingestRss.ts) | 12 | [lib/db.ts](../lib/db.ts), [sentiment/pipeline.ts](../sentiment/pipeline.ts) |
| [scripts/ingestTwitter.ts](../scripts/ingestTwitter.ts) | 12 | [lib/db.ts](../lib/db.ts), [sentiment/pipeline.ts](../sentiment/pipeline.ts) |
| [scripts/inspect_api.ts](../scripts/inspect_api.ts) | 11 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/inspect_fills.ts](../scripts/inspect_fills.ts) | 33 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/install_local_runtime.ps1](../scripts/install_local_runtime.ps1) | 13 | — |
| [scripts/manual_backfill.ts](../scripts/manual_backfill.ts) | 53 | [lib/market-db.ts](../lib/market-db.ts), [services/MarketCollectorService.ts](../services/MarketCollectorService.ts) |
| [scripts/migrate-db.js](../scripts/migrate-db.js) | 131 | — |
| [scripts/migrate_market_to_vps.py](../scripts/migrate_market_to_vps.py) | 76 | — |
| [scripts/purge_db.ts](../scripts/purge_db.ts) | 19 | [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/rate_limit_probe.ts](../scripts/rate_limit_probe.ts) | 138 | — |
| [scripts/reproduce_execution.ts](../scripts/reproduce_execution.ts) | 76 | [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts) |
| [scripts/rescore_messages.ts](../scripts/rescore_messages.ts) | 65 | [lib/db.ts](../lib/db.ts), [sentiment/scorer.ts](../sentiment/scorer.ts), [sentiment/tagger.ts](../sentiment/tagger.ts) |
| [scripts/resume_market_import.py](../scripts/resume_market_import.py) | 28 | — |
| [scripts/run_sentiment.ts](../scripts/run_sentiment.ts) | 34 | [lib/db.ts](../lib/db.ts), [sentiment/pipeline.ts](../sentiment/pipeline.ts) |
| [scripts/runtime_status.ts](../scripts/runtime_status.ts) | 36 | [lib/db.ts](../lib/db.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/news-db.ts](../lib/news-db.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [scripts/scoreMessages.ts](../scripts/scoreMessages.ts) | 12 | [lib/db.ts](../lib/db.ts), [sentiment/pipeline.ts](../sentiment/pipeline.ts) |
| [scripts/start_auto_trader.ts](../scripts/start_auto_trader.ts) | 36 | [services/AutoTraderService.ts](../services/AutoTraderService.ts) |
| [scripts/start_collector.ts](../scripts/start_collector.ts) | 17 | [services/CollectorRunner.ts](../services/CollectorRunner.ts) |
| [scripts/start_intelligence_worker.ts](../scripts/start_intelligence_worker.ts) | 68 | [lib/db.ts](../lib/db.ts), [lib/news-db.ts](../lib/news-db.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts), [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) |
| [scripts/start_local_runtime.py](../scripts/start_local_runtime.py) | 81 | — |
| [scripts/start_sentiment_service.sh](../scripts/start_sentiment_service.sh) | 21 | — |
| [scripts/test-advisor.ts](../scripts/test-advisor.ts) | 92 | [services/OrchestratorService.ts](../services/OrchestratorService.ts) |
| [scripts/test-chinese.ts](../scripts/test-chinese.ts) | 37 | [sentiment/scorer.ts](../sentiment/scorer.ts) |
| [scripts/test-models.ts](../scripts/test-models.ts) | 62 | [sentiment/scorer.ts](../sentiment/scorer.ts) |
| [scripts/test-rate-limit.ts](../scripts/test-rate-limit.ts) | 50 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/test_backfill_limit.ts](../scripts/test_backfill_limit.ts) | 22 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/test_risk_logic.ts](../scripts/test_risk_logic.ts) | 151 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [scripts/test_screener_logic.ts](../scripts/test_screener_logic.ts) | 94 | [lib/screener-config.ts](../lib/screener-config.ts), [services/ScreenerService.ts](../services/ScreenerService.ts) |
| [scripts/tmp_backfill_asset_ctx_universe.ts](../scripts/tmp_backfill_asset_ctx_universe.ts) | 257 | [lib/market-db.ts](../lib/market-db.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) |
| [scripts/tmp_backfill_main_from_backtest_hour.ts](../scripts/tmp_backfill_main_from_backtest_hour.ts) | 176 | [lib/market-db.ts](../lib/market-db.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) |
| [scripts/trigger_analysis.ts](../scripts/trigger_analysis.ts) | 65 | — |
| [scripts/updateSymbols.ts](../scripts/updateSymbols.ts) | 67 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/update_live_market_window.ts](../scripts/update_live_market_window.ts) | 171 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) |
| [scripts/verify_backfill.ts](../scripts/verify_backfill.ts) | 20 | [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/verify_market_db.ts](../scripts/verify_market_db.ts) | 22 | [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/verify_refactor.ts](../scripts/verify_refactor.ts) | 44 | [lib/db.ts](../lib/db.ts), [services/ScreenerService.ts](../services/ScreenerService.ts) |
| [scripts/verify_scores.ts](../scripts/verify_scores.ts) | 23 | [lib/db.ts](../lib/db.ts) |
| [scripts/verify_standalone.ts](../scripts/verify_standalone.ts) | 42 | [lib/db.ts](../lib/db.ts), [services/ScreenerService.ts](../services/ScreenerService.ts), [services/SentimentService.ts](../services/SentimentService.ts), [services/SnapshotBuilder.ts](../services/SnapshotBuilder.ts) |

## sentiment

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [sentiment/aggregation.ts](../sentiment/aggregation.ts) | 122 | [sentiment/config.ts](../sentiment/config.ts) |
| [sentiment/config.ts](../sentiment/config.ts) | 279 | — |
| [sentiment/pipeline.ts](../sentiment/pipeline.ts) | 492 | [lib/db.ts](../lib/db.ts), [lib/market-db.ts](../lib/market-db.ts), [sentiment/aggregation.ts](../sentiment/aggregation.ts), [sentiment/config.ts](../sentiment/config.ts), [sentiment/scorer.ts](../sentiment/scorer.ts), [sentiment/symbolMapper.ts](../sentiment/symbolMapper.ts), [sentiment/tagger.ts](../sentiment/tagger.ts) |
| [sentiment/scorer.ts](../sentiment/scorer.ts) | 128 | [sentiment/config.ts](../sentiment/config.ts) |
| [sentiment/service.py](../sentiment/service.py) | 170 | — |
| [sentiment/symbolMapper.ts](../sentiment/symbolMapper.ts) | 43 | [sentiment/config.ts](../sentiment/config.ts) |
| [sentiment/tagger.ts](../sentiment/tagger.ts) | 45 | — |

## services

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [services/AccountStateService.ts](../services/AccountStateService.ts) | 130 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/log/traderLog.ts](../lib/log/traderLog.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/AutoTraderOrderManagementService.ts](../services/AutoTraderOrderManagementService.ts) | 324 | [lib/db.ts](../lib/db.ts), [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts), [types/auto-trader-review.ts](../types/auto-trader-review.ts) |
| [services/AutoTraderReviewService.ts](../services/AutoTraderReviewService.ts) | 1887 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/auto-trader-review/review-utils.ts](../lib/auto-trader-review/review-utils.ts), [lib/db.ts](../lib/db.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/trader/position-management-math.ts](../lib/trader/position-management-math.ts), [lib/trader/position-management-policy.ts](../lib/trader/position-management-policy.ts), [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts), [types/auto-trader-review.ts](../types/auto-trader-review.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [services/AutoTraderService.ts](../services/AutoTraderService.ts) | 309 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/auto-trader-config.ts](../lib/auto-trader-config.ts), [lib/candidate-promotion-priors.ts](../lib/candidate-promotion-priors.ts), [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [lib/db.ts](../lib/db.ts), [services/CollectorRunner.ts](../services/CollectorRunner.ts), [services/OrchestratorService.ts](../services/OrchestratorService.ts) |
| [services/CodexQueueService.ts](../services/CodexQueueService.ts) | 114 | [lib/db.ts](../lib/db.ts), [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts) |
| [services/CollectorRunner.ts](../services/CollectorRunner.ts) | 718 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts), [services/MarketCollectorService.ts](../services/MarketCollectorService.ts), [services/MarketUniverse.ts](../services/MarketUniverse.ts) |
| [services/HeldPositionMarketResolver.ts](../services/HeldPositionMarketResolver.ts) | 121 | [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [services/SentimentService.ts](../services/SentimentService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts) | 637 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/screener-config.ts](../lib/screener-config.ts) |
| [services/MarketCollectorService.ts](../services/MarketCollectorService.ts) | 277 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts), [lib/market-db.ts](../lib/market-db.ts), [services/MarketUniverse.ts](../services/MarketUniverse.ts) |
| [services/MarketDataService.ts](../services/MarketDataService.ts) | 28 | [lib/db.ts](../lib/db.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [services/SentimentService.ts](../services/SentimentService.ts) |
| [services/MarketDerivedMetricsService.ts](../services/MarketDerivedMetricsService.ts) | 295 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/trading/execution-cost.ts](../lib/trading/execution-cost.ts), [services/MarketStructureService.ts](../services/MarketStructureService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/MarketSnapshotAssembler.ts](../services/MarketSnapshotAssembler.ts) | 78 | [services/ScreenerService.ts](../services/ScreenerService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/MarketStructureService.ts](../services/MarketStructureService.ts) | 151 | [types/snapshot.ts](../types/snapshot.ts) |
| [services/MarketUniverse.ts](../services/MarketUniverse.ts) | 99 | — |
| [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) | 234 | [lib/db.ts](../lib/db.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/llm/provider.ts](../lib/llm/provider.ts), [lib/llm/schemas.ts](../lib/llm/schemas.ts), [lib/news/validation.ts](../lib/news/validation.ts), [lib/news-db.ts](../lib/news-db.ts), [prompts/NewsAnalyst.ts](../prompts/NewsAnalyst.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts), [types/news.ts](../types/news.ts) |
| [services/OpportunityJournalService.ts](../services/OpportunityJournalService.ts) | 696 | [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [lib/db.ts](../lib/db.ts), [lib/market-db.ts](../lib/market-db.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [services/OrchestratorService.ts](../services/OrchestratorService.ts) | 1933 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/auto-trader-config.ts](../lib/auto-trader-config.ts), [lib/auto-trader-review/review-utils.ts](../lib/auto-trader-review/review-utils.ts), [lib/candidate-promotion.ts](../lib/candidate-promotion.ts), [lib/db.ts](../lib/db.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts), [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts), [lib/llm/LlmResponseParser.ts](../lib/llm/LlmResponseParser.ts), [lib/llm/provider.ts](../lib/llm/provider.ts), [lib/llm/schemas.ts](../lib/llm/schemas.ts), [lib/log/safeLogger.ts](../lib/log/safeLogger.ts), [lib/log/traderLog.ts](../lib/log/traderLog.ts), [lib/log/tradingLogger.ts](../lib/log/tradingLogger.ts), [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts), [lib/risk/execution-safety.ts](../lib/risk/execution-safety.ts), [lib/risk/shared.ts](../lib/risk/shared.ts), [lib/screener-config.ts](../lib/screener-config.ts), [lib/trader/PositionManager.ts](../lib/trader/PositionManager.ts), [lib/trader/TraderDecisionValidator.ts](../lib/trader/TraderDecisionValidator.ts), [lib/trader/TraderWorkflow.ts](../lib/trader/TraderWorkflow.ts), [lib/trader/position-management-types.ts](../lib/trader/position-management-types.ts), [prompts/TraderAgent.ts](../prompts/TraderAgent.ts), [services/AutoTraderOrderManagementService.ts](../services/AutoTraderOrderManagementService.ts), [services/AutoTraderReviewService.ts](../services/AutoTraderReviewService.ts), [services/OpportunityJournalService.ts](../services/OpportunityJournalService.ts), [services/SnapshotBuilder.ts](../services/SnapshotBuilder.ts), [services/TraderContextBuilder.ts](../services/TraderContextBuilder.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [services/OrderBookManager.ts](../services/OrderBookManager.ts) | 159 | [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts) |
| [services/PriceAlertsService.ts](../services/PriceAlertsService.ts) | 223 | [lib/db.ts](../lib/db.ts) |
| [services/RegimeService.ts](../services/RegimeService.ts) | 316 | [types/snapshot.ts](../types/snapshot.ts) |
| [services/RegimeUniverseService.ts](../services/RegimeUniverseService.ts) | 239 | [lib/market-db.ts](../lib/market-db.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/ScreenerService.ts](../services/ScreenerService.ts) | 822 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/screener-config.ts](../lib/screener-config.ts), [lib/trading/execution-cost.ts](../lib/trading/execution-cost.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [services/OrderBookManager.ts](../services/OrderBookManager.ts), [services/SentimentService.ts](../services/SentimentService.ts) |
| [services/SentimentService.ts](../services/SentimentService.ts) | 280 | [lib/db.ts](../lib/db.ts), [sentiment/config.ts](../sentiment/config.ts), [sentiment/symbolMapper.ts](../sentiment/symbolMapper.ts) |
| [services/SnapshotBuilder.ts](../services/SnapshotBuilder.ts) | 144 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/log/traderLog.ts](../lib/log/traderLog.ts), [lib/risk/kill-switch.ts](../lib/risk/kill-switch.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/AccountStateService.ts](../services/AccountStateService.ts), [services/HeldPositionMarketResolver.ts](../services/HeldPositionMarketResolver.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [services/MarketDerivedMetricsService.ts](../services/MarketDerivedMetricsService.ts), [services/MarketSnapshotAssembler.ts](../services/MarketSnapshotAssembler.ts), [services/RegimeService.ts](../services/RegimeService.ts), [services/RegimeUniverseService.ts](../services/RegimeUniverseService.ts), [services/ScreenerService.ts](../services/ScreenerService.ts), [services/SentimentService.ts](../services/SentimentService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/TradeHistoryService.ts](../services/TradeHistoryService.ts) | 385 | [lib/db.ts](../lib/db.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [services/TraderContextBuilder.ts](../services/TraderContextBuilder.ts) | 1137 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/db.ts](../lib/db.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/risk/shared.ts](../lib/risk/shared.ts), [lib/trader/CandidatePromotionPolicy.ts](../lib/trader/CandidatePromotionPolicy.ts), [lib/trader/OpportunityEngine.ts](../lib/trader/OpportunityEngine.ts), [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |

## src

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts) | 1426 | [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/ExecutionBookStore.ts](../src/backtest/ExecutionBookStore.ts), [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts), [src/backtest/L2FeatureBuilder.ts](../src/backtest/L2FeatureBuilder.ts) |
| [src/backtest/BacktestDataSource.ts](../src/backtest/BacktestDataSource.ts) | 954 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/ScreenerService.ts](../services/ScreenerService.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/ExecutionBookStore.ts](../src/backtest/ExecutionBookStore.ts), [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) | 168 | — |
| [src/backtest/BacktestHydration.ts](../src/backtest/BacktestHydration.ts) | 106 | [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts), [src/backtest/RealCandleHydrator.ts](../src/backtest/RealCandleHydrator.ts), [src/backtest/WalkForwardOptimizer.ts](../src/backtest/WalkForwardOptimizer.ts) |
| [src/backtest/BacktestPortfolio.ts](../src/backtest/BacktestPortfolio.ts) | 201 | [lib/agent-config.ts](../lib/agent-config.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [src/backtest/BacktestRunner.ts](../src/backtest/BacktestRunner.ts) | 408 | [lib/risk/RiskCheckModule.ts](../lib/risk/RiskCheckModule.ts), [lib/trader/TraderDecisionValidator.ts](../lib/trader/TraderDecisionValidator.ts), [lib/trader/TraderWorkflow.ts](../lib/trader/TraderWorkflow.ts), [services/MarketDerivedMetricsService.ts](../services/MarketDerivedMetricsService.ts), [services/RegimeService.ts](../services/RegimeService.ts), [services/TraderContextBuilder.ts](../services/TraderContextBuilder.ts), [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts), [src/backtest/BacktestDataSource.ts](../src/backtest/BacktestDataSource.ts), [src/backtest/BacktestPortfolio.ts](../src/backtest/BacktestPortfolio.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/ExecutionSimulator.ts](../src/backtest/ExecutionSimulator.ts), [src/backtest/MetricsReporter.ts](../src/backtest/MetricsReporter.ts), [src/backtest/TraderPolicies.ts](../src/backtest/TraderPolicies.ts), [types/trading.ts](../types/trading.ts) |
| [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) | 299 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [src/backtest/ExecutionBookStore.ts](../src/backtest/ExecutionBookStore.ts) | 314 | [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |
| [src/backtest/ExecutionSimulator.ts](../src/backtest/ExecutionSimulator.ts) | 394 | [lib/agent-config.ts](../lib/agent-config.ts), [src/backtest/BacktestDataSource.ts](../src/backtest/BacktestDataSource.ts), [src/backtest/BacktestPortfolio.ts](../src/backtest/BacktestPortfolio.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts) | 310 | [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |
| [src/backtest/L2FeatureBuilder.ts](../src/backtest/L2FeatureBuilder.ts) | 418 | [lib/agent-config.ts](../lib/agent-config.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |
| [src/backtest/MetricsReporter.ts](../src/backtest/MetricsReporter.ts) | 201 | [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |
| [src/backtest/OptimizerTrialWorker.cjs](../src/backtest/OptimizerTrialWorker.cjs) | 2 | [src/backtest/OptimizerTrialWorker.ts](../src/backtest/OptimizerTrialWorker.ts) |
| [src/backtest/OptimizerTrialWorker.ts](../src/backtest/OptimizerTrialWorker.ts) | 44 | [src/backtest/BacktestRunner.ts](../src/backtest/BacktestRunner.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/WalkForwardOptimizer.ts](../src/backtest/WalkForwardOptimizer.ts) |
| [src/backtest/RealCandleHydrator.ts](../src/backtest/RealCandleHydrator.ts) | 960 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) |
| [src/backtest/TraderPolicies.ts](../src/backtest/TraderPolicies.ts) | 400 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/llm/LlmResponseParser.ts](../lib/llm/LlmResponseParser.ts), [lib/trader/TraderWorkflow.ts](../lib/trader/TraderWorkflow.ts), [prompts/TraderAgent.ts](../prompts/TraderAgent.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [types/trading.ts](../types/trading.ts) |
| [src/backtest/WalkForwardOptimizer.ts](../src/backtest/WalkForwardOptimizer.ts) | 1490 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [src/backtest/BacktestRunner.ts](../src/backtest/BacktestRunner.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |

## types

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [types/auto-trader-review.ts](../types/auto-trader-review.ts) | 108 | — |
| [types/news.ts](../types/news.ts) | 56 | — |
| [types/snapshot.ts](../types/snapshot.ts) | 217 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/MarketStructureService.ts](../services/MarketStructureService.ts), [services/ScreenerService.ts](../services/ScreenerService.ts) |
| [types/trading.ts](../types/trading.ts) | 299 | [types/news.ts](../types/news.ts) |
| [types/vader-sentiment.d.ts](../types/vader-sentiment.d.ts) | 1 | — |
