# Centrypto module index

Generated from the current working tree: **385 first-party source/config/test files**.

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
| [middleware.ts](../middleware.ts) | 106 | — |
| [next.config.mjs](../next.config.mjs) | 34 | — |
| [package.json](../package.json) | 95 | — |
| [postcss.config.js](../postcss.config.js) | 6 | — |
| [puppeteer-logs.js](../puppeteer-logs.js) | 42 | — |
| [screenshot-ui.js](../screenshot-ui.js) | 25 | — |
| [tailwind.config.ts](../tailwind.config.ts) | 98 | — |
| [test-devstral.js](../test-devstral.js) | 115 | — |
| [test-ollama.js](../test-ollama.js) | 92 | — |
| [test-prompt-generation.mjs](../test-prompt-generation.mjs) | 345 | — |
| [test-prompt-manual.mjs](../test-prompt-manual.mjs) | 140 | — |
| [test-snapshot.mjs](../test-snapshot.mjs) | 17 | — |
| [test_prompt.ts](../test_prompt.ts) | 84 | [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts) |
| [tsconfig.json](../tsconfig.json) | 46 | — |

## __tests__

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [__tests__/AccountStateService.test.ts](../__tests__/AccountStateService.test.ts) | 68 | [lib/agent-config.ts](../lib/agent-config.ts), [services/AccountStateService.ts](../services/AccountStateService.ts) |
| [__tests__/AppDatabase.test.ts](../__tests__/AppDatabase.test.ts) | 68 | [lib/db.ts](../lib/db.ts) |
| [__tests__/CandidatePromotionPriors.test.ts](../__tests__/CandidatePromotionPriors.test.ts) | 47 | [lib/candidate-promotion-priors.ts](../lib/candidate-promotion-priors.ts) |
| [__tests__/CodexProvider.test.ts](../__tests__/CodexProvider.test.ts) | 33 | [lib/llm/provider.ts](../lib/llm/provider.ts) |
| [__tests__/CodexQueue.test.ts](../__tests__/CodexQueue.test.ts) | 80 | [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [__tests__/CodexRunner.test.ts](../__tests__/CodexRunner.test.ts) | 68 | [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts) |
| [__tests__/CollectorRunner.test.ts](../__tests__/CollectorRunner.test.ts) | 101 | [services/CollectorRunner.ts](../services/CollectorRunner.ts) |
| [__tests__/DeskActivity.test.ts](../__tests__/DeskActivity.test.ts) | 60 | [lib/desk/activity-state.ts](../lib/desk/activity-state.ts) |
| [__tests__/DeskActivityRoutes.test.ts](../__tests__/DeskActivityRoutes.test.ts) | 40 | [app/api/desk/activity/route.ts](../app/api/desk/activity/route.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [__tests__/DeskAnalytics.test.ts](../__tests__/DeskAnalytics.test.ts) | 235 | [lib/desk/analytics.ts](../lib/desk/analytics.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts) |
| [__tests__/DeskArtifacts.test.ts](../__tests__/DeskArtifacts.test.ts) | 39 | [lib/desk/artifacts.ts](../lib/desk/artifacts.ts) |
| [__tests__/DeskAssessment.test.ts](../__tests__/DeskAssessment.test.ts) | 65 | [lib/desk/assessment.ts](../lib/desk/assessment.ts), [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [__tests__/DeskCollaboration.test.ts](../__tests__/DeskCollaboration.test.ts) | 448 | [lib/desk/proposals.ts](../lib/desk/proposals.ts), [lib/desk/roundtable.ts](../lib/desk/roundtable.ts), [lib/desk/runtime.ts](../lib/desk/runtime.ts), [lib/desk/work-routing.ts](../lib/desk/work-routing.ts) |
| [__tests__/DeskCycle.integration.test.ts](../__tests__/DeskCycle.integration.test.ts) | 1197 | [lib/app-database-provider.ts](../lib/app-database-provider.ts), [lib/db.ts](../lib/db.ts), [lib/desk/backtest/jobs.ts](../lib/desk/backtest/jobs.ts), [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/catalyst-memory.ts](../lib/desk/catalyst-memory.ts), [lib/desk/execution-lease.ts](../lib/desk/execution-lease.ts), [lib/desk/execution.ts](../lib/desk/execution.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/journal.ts](../lib/desk/journal.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts), [lib/desk/market.ts](../lib/desk/market.ts), [lib/desk/proposals.ts](../lib/desk/proposals.ts), [lib/desk/review-schedule.ts](../lib/desk/review-schedule.ts), [lib/desk/roles.ts](../lib/desk/roles.ts), [lib/desk/routine-work.ts](../lib/desk/routine-work.ts), [lib/desk/runtime.ts](../lib/desk/runtime.ts), [lib/desk/shifts.ts](../lib/desk/shifts.ts), [lib/desk/tools.ts](../lib/desk/tools.ts), [lib/desk/triggers.ts](../lib/desk/triggers.ts), [lib/news/desk-routing.ts](../lib/news/desk-routing.ts), [services/DeskResearchWorker.ts](../services/DeskResearchWorker.ts), [services/TradingDeskWorker.ts](../services/TradingDeskWorker.ts) |
| [__tests__/DeskDerivatives.test.ts](../__tests__/DeskDerivatives.test.ts) | 108 | [lib/desk/derivatives.ts](../lib/desk/derivatives.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/roles.ts](../lib/desk/roles.ts), [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [__tests__/DeskExecution.test.ts](../__tests__/DeskExecution.test.ts) | 323 | [lib/desk/execution-types.ts](../lib/desk/execution-types.ts), [lib/desk/execution.ts](../lib/desk/execution.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts) |
| [__tests__/DeskFundingTools.test.ts](../__tests__/DeskFundingTools.test.ts) | 88 | [lib/desk/derivatives.ts](../lib/desk/derivatives.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/market.ts](../lib/desk/market.ts), [lib/desk/tools.ts](../lib/desk/tools.ts) |
| [__tests__/DeskNewsRouting.test.ts](../__tests__/DeskNewsRouting.test.ts) | 97 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/news/desk-routing.ts](../lib/news/desk-routing.ts), [types/news.ts](../types/news.ts) |
| [__tests__/DeskNewsSentiment.test.ts](../__tests__/DeskNewsSentiment.test.ts) | 45 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/news-sentiment.ts](../lib/desk/news-sentiment.ts), [types/news.ts](../types/news.ts) |
| [__tests__/DeskOffice.test.tsx](../__tests__/DeskOffice.test.tsx) | 89 | [components/desk/DeskOffice.tsx](../components/desk/DeskOffice.tsx), [lib/desk/activity-types.ts](../lib/desk/activity-types.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts), [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [__tests__/DeskReadCache.test.ts](../__tests__/DeskReadCache.test.ts) | 195 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/public-cache.ts](../lib/desk/public-cache.ts), [lib/desk/read-cache.ts](../lib/desk/read-cache.ts), [lib/desk/research.ts](../lib/desk/research.ts), [lib/desk/roundtable.ts](../lib/desk/roundtable.ts), [lib/desk/runtime.ts](../lib/desk/runtime.ts) |
| [__tests__/DeskReplay.test.ts](../__tests__/DeskReplay.test.ts) | 323 | [lib/desk/backtest/engine.ts](../lib/desk/backtest/engine.ts), [lib/desk/backtest/request.ts](../lib/desk/backtest/request.ts), [lib/desk/backtest/types.ts](../lib/desk/backtest/types.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts) |
| [__tests__/DeskResearchAdapter.test.ts](../__tests__/DeskResearchAdapter.test.ts) | 135 | [lib/desk/backtest/data.ts](../lib/desk/backtest/data.ts), [lib/desk/backtest/types.ts](../lib/desk/backtest/types.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts) |
| [__tests__/DeskResearchData.test.ts](../__tests__/DeskResearchData.test.ts) | 56 | [lib/desk/research-data.ts](../lib/desk/research-data.ts) |
| [__tests__/DeskResearchUI.test.tsx](../__tests__/DeskResearchUI.test.tsx) | 113 | [components/Backtester.tsx](../components/Backtester.tsx) |
| [__tests__/DeskRoundtable.test.ts](../__tests__/DeskRoundtable.test.ts) | 161 | [lib/desk/activity-types.ts](../lib/desk/activity-types.ts), [lib/desk/research.ts](../lib/desk/research.ts), [lib/desk/roles.ts](../lib/desk/roles.ts), [lib/desk/roundtable.ts](../lib/desk/roundtable.ts), [lib/desk/runtime.ts](../lib/desk/runtime.ts) |
| [__tests__/DeskRoutes.test.ts](../__tests__/DeskRoutes.test.ts) | 59 | [app/api/desk/route.ts](../app/api/desk/route.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/desk/books.ts](../lib/desk/books.ts) |
| [__tests__/DeskTokenUsage.test.ts](../__tests__/DeskTokenUsage.test.ts) | 158 | [lib/desk/runtime.ts](../lib/desk/runtime.ts), [lib/desk/token-usage.ts](../lib/desk/token-usage.ts) |
| [__tests__/DeskTurnDeadline.test.ts](../__tests__/DeskTurnDeadline.test.ts) | 39 | [lib/desk/turn-deadline.ts](../lib/desk/turn-deadline.ts) |
| [__tests__/DeskUsagePanel.test.tsx](../__tests__/DeskUsagePanel.test.tsx) | 50 | [components/desk/DeskUsage.tsx](../components/desk/DeskUsage.tsx) |
| [__tests__/HyperliquidAccountRoute.test.ts](../__tests__/HyperliquidAccountRoute.test.ts) | 96 | [app/api/hyperliquid/account/route.ts](../app/api/hyperliquid/account/route.ts) |
| [__tests__/HyperliquidApiWallet.test.ts](../__tests__/HyperliquidApiWallet.test.ts) | 170 | [app/api/hyperliquid/api-wallet/route.ts](../app/api/hyperliquid/api-wallet/route.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts) |
| [__tests__/HyperliquidApiWalletSettings.test.tsx](../__tests__/HyperliquidApiWalletSettings.test.tsx) | 92 | [components/HyperliquidApiWalletSettings.tsx](../components/HyperliquidApiWalletSettings.tsx) |
| [__tests__/HyperliquidExecution.test.ts](../__tests__/HyperliquidExecution.test.ts) | 138 | [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts) |
| [__tests__/HyperliquidLimiter.test.ts](../__tests__/HyperliquidLimiter.test.ts) | 81 | [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [__tests__/HyperliquidWs.test.ts](../__tests__/HyperliquidWs.test.ts) | 77 | [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts) |
| [__tests__/KillSwitchFailClosed.test.ts](../__tests__/KillSwitchFailClosed.test.ts) | 34 | [lib/risk/execution-safety.ts](../lib/risk/execution-safety.ts) |
| [__tests__/MainnetScreenerSimulation.test.ts](../__tests__/MainnetScreenerSimulation.test.ts) | 80 | [lib/market-db.ts](../lib/market-db.ts) |
| [__tests__/MarketCollectorBuffer.test.ts](../__tests__/MarketCollectorBuffer.test.ts) | 74 | [services/MarketCollectorService.ts](../services/MarketCollectorService.ts) |
| [__tests__/MarketStructureService.test.ts](../__tests__/MarketStructureService.test.ts) | 55 | [services/MarketStructureService.ts](../services/MarketStructureService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [__tests__/MarketUniverse.test.ts](../__tests__/MarketUniverse.test.ts) | 51 | [services/MarketUniverse.ts](../services/MarketUniverse.ts) |
| [__tests__/NewsAnalysisBatch.test.ts](../__tests__/NewsAnalysisBatch.test.ts) | 25 | [lib/news/analysis-batch.ts](../lib/news/analysis-batch.ts) |
| [__tests__/NewsBrowserRestart.test.ts](../__tests__/NewsBrowserRestart.test.ts) | 63 | — |
| [__tests__/NewsExtractor.test.ts](../__tests__/NewsExtractor.test.ts) | 166 | — |
| [__tests__/NewsFeedCollection.test.ts](../__tests__/NewsFeedCollection.test.ts) | 48 | — |
| [__tests__/NewsIntelligence.test.ts](../__tests__/NewsIntelligence.test.ts) | 103 | [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) |
| [__tests__/NewsIntelligencePanel.test.tsx](../__tests__/NewsIntelligencePanel.test.tsx) | 81 | [components/NewsIntelligencePanel.tsx](../components/NewsIntelligencePanel.tsx) |
| [__tests__/NewsObservation.test.ts](../__tests__/NewsObservation.test.ts) | 33 | [lib/news/observation.ts](../lib/news/observation.ts) |
| [__tests__/NewsRoutes.test.ts](../__tests__/NewsRoutes.test.ts) | 53 | [app/api/news/[...path]/route.ts](../app/api/news/[...path]/route.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [__tests__/NewsSchema.test.ts](../__tests__/NewsSchema.test.ts) | 13 | [lib/llm/schemas.ts](../lib/llm/schemas.ts) |
| [__tests__/NewsValidation.test.ts](../__tests__/NewsValidation.test.ts) | 89 | [lib/news/source-catalog.ts](../lib/news/source-catalog.ts), [lib/news/validation.ts](../lib/news/validation.ts), [types/news.ts](../types/news.ts) |
| [__tests__/OpenPositions.test.tsx](../__tests__/OpenPositions.test.tsx) | 82 | [components/OpenPositions.tsx](../components/OpenPositions.tsx) |
| [__tests__/RegimeService.test.ts](../__tests__/RegimeService.test.ts) | 92 | [services/RegimeService.ts](../services/RegimeService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [__tests__/RiskPlan.test.ts](../__tests__/RiskPlan.test.ts) | 131 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/risk/shared.ts](../lib/risk/shared.ts), [types/trading.ts](../types/trading.ts) |
| [__tests__/SafeLogger.test.ts](../__tests__/SafeLogger.test.ts) | 20 | [lib/log/safeLogger.ts](../lib/log/safeLogger.ts) |
| [__tests__/ScreenerDiscovery.test.ts](../__tests__/ScreenerDiscovery.test.ts) | 145 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/ScreenerService.ts](../services/ScreenerService.ts) |
| [__tests__/TechnicalChart.test.tsx](../__tests__/TechnicalChart.test.tsx) | 35 | [components/TechnicalChart.tsx](../components/TechnicalChart.tsx) |
| [__tests__/TradeForm.test.tsx](../__tests__/TradeForm.test.tsx) | 151 | [components/TradeForm.tsx](../components/TradeForm.tsx) |
| [__tests__/TradeHistoryService.test.ts](../__tests__/TradeHistoryService.test.ts) | 68 | [services/TradeHistoryService.ts](../services/TradeHistoryService.ts) |
| [__tests__/TradingAndRisk.test.tsx](../__tests__/TradingAndRisk.test.tsx) | 59 | [components/TradingAndRisk.tsx](../components/TradingAndRisk.tsx) |
| [__tests__/TradingDesk.test.tsx](../__tests__/TradingDesk.test.tsx) | 68 | [components/desk/TradingDesk.tsx](../components/desk/TradingDesk.tsx), [components/desk/desk-view.ts](../components/desk/desk-view.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts) |
| [__tests__/WalletConnect.test.tsx](../__tests__/WalletConnect.test.tsx) | 176 | [components/WalletConnect.tsx](../components/WalletConnect.tsx) |
| [__tests__/WalletSessionAuth.test.ts](../__tests__/WalletSessionAuth.test.ts) | 144 | [app/api/alerts/route.ts](../app/api/alerts/route.ts), [app/api/auth/session/route.ts](../app/api/auth/session/route.ts), [app/api/backtest/run/route.ts](../app/api/backtest/run/route.ts), [app/api/hyperliquid/api-wallet/route.ts](../app/api/hyperliquid/api-wallet/route.ts), [app/api/risk/kill-switch/route.ts](../app/api/risk/kill-switch/route.ts), [app/api/trades/route.ts](../app/api/trades/route.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [__tests__/execution-cost.test.ts](../__tests__/execution-cost.test.ts) | 131 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [lib/trading/execution-cost.ts](../lib/trading/execution-cost.ts), [services/MarketDerivedMetricsService.ts](../services/MarketDerivedMetricsService.ts), [services/ScreenerService.ts](../services/ScreenerService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [__tests__/server-only.ts](../__tests__/server-only.ts) | 1 | — |
| [__tests__/setup.ts](../__tests__/setup.ts) | 46 | — |
| [__tests__/test_recover_backtest_archive.py](../__tests__/test_recover_backtest_archive.py) | 58 | — |

## app

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [app/actions/trade.ts](../app/actions/trade.ts) | 131 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/db.ts](../lib/db.ts), [lib/desk/execution-lease.ts](../lib/desk/execution-lease.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts), [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts), [lib/log/safeLogger.ts](../lib/log/safeLogger.ts), [lib/risk/execution-safety.ts](../lib/risk/execution-safety.ts) |
| [app/api/ai/models/route.ts](../app/api/ai/models/route.ts) | 47 | [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [app/api/alerts/route.ts](../app/api/alerts/route.ts) | 159 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [services/PriceAlertsService.ts](../services/PriceAlertsService.ts) |
| [app/api/auth/challenge/route.ts](../app/api/auth/challenge/route.ts) | 19 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [app/api/auth/logout/route.ts](../app/api/auth/logout/route.ts) | 8 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [app/api/auth/session/route.ts](../app/api/auth/session/route.ts) | 40 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [app/api/auth/verify/route.ts](../app/api/auth/verify/route.ts) | 34 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) |
| [app/api/backtest/run/route.ts](../app/api/backtest/run/route.ts) | 101 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/db.ts](../lib/db.ts), [lib/desk/artifacts.ts](../lib/desk/artifacts.ts), [lib/desk/backtest/data.ts](../lib/desk/backtest/data.ts), [lib/desk/backtest/jobs.ts](../lib/desk/backtest/jobs.ts), [lib/desk/books.ts](../lib/desk/books.ts) |
| [app/api/candles/route.ts](../app/api/candles/route.ts) | 136 | [lib/market-db.ts](../lib/market-db.ts) |
| [app/api/desk/activity/route.ts](../app/api/desk/activity/route.ts) | 55 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/db.ts](../lib/db.ts), [lib/desk/activity-state.ts](../lib/desk/activity-state.ts), [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [app/api/desk/route.ts](../app/api/desk/route.ts) | 149 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/db.ts](../lib/db.ts), [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/execution.ts](../lib/desk/execution.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts), [lib/risk/kill-switch.ts](../lib/risk/kill-switch.ts) |
| [app/api/desk/usage/route.ts](../app/api/desk/usage/route.ts) | 26 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/token-usage.ts](../lib/desk/token-usage.ts) |
| [app/api/hyperliquid/account/route.ts](../app/api/hyperliquid/account/route.ts) | 113 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [app/api/hyperliquid/api-wallet/route.ts](../app/api/hyperliquid/api-wallet/route.ts) | 79 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts) |
| [app/api/indicators/route.ts](../app/api/indicators/route.ts) | 82 | [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts) |
| [app/api/news/[...path]/route.ts](../app/api/news/[...path]/route.ts) | 59 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/news/account.ts](../lib/news/account.ts), [lib/news-db.ts](../lib/news-db.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts), [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) |
| [app/api/risk/kill-switch/route.ts](../app/api/risk/kill-switch/route.ts) | 28 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/risk/kill-switch.ts](../lib/risk/kill-switch.ts) |
| [app/api/screener/route.ts](../app/api/screener/route.ts) | 275 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/CollectorRunner.ts](../services/CollectorRunner.ts), [services/ScreenerService.ts](../services/ScreenerService.ts) |
| [app/api/trade/execute/route.ts](../app/api/trade/execute/route.ts) | 10 | — |
| [app/api/trades/route.ts](../app/api/trades/route.ts) | 136 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [services/TradeHistoryService.ts](../services/TradeHistoryService.ts) |
| [app/backtester/page.tsx](../app/backtester/page.tsx) | 31 | [components/Backtester.tsx](../components/Backtester.tsx), [components/LeftNavigation.tsx](../components/LeftNavigation.tsx), [components/TopHeader.tsx](../components/TopHeader.tsx), [components/ui/button.tsx](../components/ui/button.tsx) |
| [app/desk/desk.css](../app/desk/desk.css) | 42 | — |
| [app/desk/office.css](../app/desk/office.css) | 292 | — |
| [app/desk/page.tsx](../app/desk/page.tsx) | 20 | [app/desk/desk.css](../app/desk/desk.css), [app/desk/office.css](../app/desk/office.css), [components/TopHeader.tsx](../components/TopHeader.tsx), [components/desk/TradingDesk.tsx](../components/desk/TradingDesk.tsx) |
| [app/globals.css](../app/globals.css) | 203 | — |
| [app/layout.tsx](../app/layout.tsx) | 29 | [app/globals.css](../app/globals.css), [components/Providers.tsx](../components/Providers.tsx) |
| [app/page.tsx](../app/page.tsx) | 51 | [components/AdvancedIndicators.tsx](../components/AdvancedIndicators.tsx), [components/HyperliquidFeed.tsx](../components/HyperliquidFeed.tsx), [components/LeftNavigation.tsx](../components/LeftNavigation.tsx), [components/NewsIntelligencePanel.tsx](../components/NewsIntelligencePanel.tsx), [components/PositionsTable.tsx](../components/PositionsTable.tsx), [components/TechnicalChart.tsx](../components/TechnicalChart.tsx), [components/TopHeader.tsx](../components/TopHeader.tsx), [components/TradingAndRisk.tsx](../components/TradingAndRisk.tsx) |

## backtest_py

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [backtest_py/__init__.py](../backtest_py/__init__.py) | 2 | — |
| [backtest_py/parquet_store.py](../backtest_py/parquet_store.py) | 451 | — |

## collector

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [collector/browser.ts](../collector/browser.ts) | 35 | — |
| [collector/deploy/activate.py](../collector/deploy/activate.py) | 89 | — |
| [collector/deploy/grants.sql](../collector/deploy/grants.sql) | 11 | — |
| [collector/deploy/install.sh](../collector/deploy/install.sh) | 64 | — |
| [collector/deploy/interactive_chrome.sh](../collector/deploy/interactive_chrome.sh) | 19 | — |
| [collector/deploy/pair_owner.py](../collector/deploy/pair_owner.py) | 19 | — |
| [collector/extension/background.js](../collector/extension/background.js) | 134 | — |
| [collector/extension/extractor.js](../collector/extension/extractor.js) | 163 | — |
| [collector/extension/manifest.json](../collector/extension/manifest.json) | 11 | — |
| [collector/extension/options.html](../collector/extension/options.html) | 3 | — |
| [collector/extension/options.js](../collector/extension/options.js) | 16 | — |
| [collector/extension/rss-parser.html](../collector/extension/rss-parser.html) | 3 | — |
| [collector/extension/rss-parser.js](../collector/extension/rss-parser.js) | 7 | — |
| [collector/server.ts](../collector/server.ts) | 128 | [lib/news/observation.ts](../lib/news/observation.ts), [lib/news/source-catalog.ts](../lib/news/source-catalog.ts), [lib/news/validation.ts](../lib/news/validation.ts), [lib/news-db.ts](../lib/news-db.ts), [types/news.ts](../types/news.ts) |

## components

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [components/AdvancedIndicators.tsx](../components/AdvancedIndicators.tsx) | 247 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/Backtester.tsx](../components/Backtester.tsx) | 682 | [context/TradingContext.tsx](../context/TradingContext.tsx), [lib/desk/backtest/types.ts](../lib/desk/backtest/types.ts) |
| [components/Dashboard.tsx](../components/Dashboard.tsx) | 112 | [components/ui/card.tsx](../components/ui/card.tsx), [hooks/useAccountData.ts](../hooks/useAccountData.ts) |
| [components/HyperliquidApiWalletSettings.tsx](../components/HyperliquidApiWalletSettings.tsx) | 214 | [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/label.tsx](../components/ui/label.tsx) |
| [components/HyperliquidFeed.tsx](../components/HyperliquidFeed.tsx) | 329 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx), [lib/screening-storage.ts](../lib/screening-storage.ts), [lib/utils.ts](../lib/utils.ts) |
| [components/LeftNavigation.tsx](../components/LeftNavigation.tsx) | 288 | [components/ScreeningParameters.tsx](../components/ScreeningParameters.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/popover.tsx](../components/ui/popover.tsx), [components/ui/sheet.tsx](../components/ui/sheet.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx), [lib/screening-storage.ts](../lib/screening-storage.ts) |
| [components/NewsIntelligencePanel.tsx](../components/NewsIntelligencePanel.tsx) | 214 | [context/TradingContext.tsx](../context/TradingContext.tsx), [types/news.ts](../types/news.ts) |
| [components/OpenPositions.tsx](../components/OpenPositions.tsx) | 371 | [app/actions/trade.ts](../app/actions/trade.ts), [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/tabs.tsx](../components/ui/tabs.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/PositionsTable.tsx](../components/PositionsTable.tsx) | 874 | [app/actions/trade.ts](../app/actions/trade.ts), [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/table.tsx](../components/ui/table.tsx), [components/ui/tabs.tsx](../components/ui/tabs.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx), [lib/trade-utils.ts](../lib/trade-utils.ts) |
| [components/PriceAlerts.tsx](../components/PriceAlerts.tsx) | 250 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/select.tsx](../components/ui/select.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/Providers.tsx](../components/Providers.tsx) | 14 | [components/Web3Provider.tsx](../components/Web3Provider.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/ScreeningParameters.tsx](../components/ScreeningParameters.tsx) | 434 | [components/ui/badge.tsx](../components/ui/badge.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/label-with-tooltip.tsx](../components/ui/label-with-tooltip.tsx), [components/ui/switch.tsx](../components/ui/switch.tsx), [components/ui/tooltip.tsx](../components/ui/tooltip.tsx), [lib/screener-config.ts](../lib/screener-config.ts), [lib/screening-storage.ts](../lib/screening-storage.ts) |
| [components/TechnicalChart.tsx](../components/TechnicalChart.tsx) | 292 | [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [components/ui/select.tsx](../components/ui/select.tsx), [components/ui/toggle.tsx](../components/ui/toggle.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/TopHeader.tsx](../components/TopHeader.tsx) | 104 | [components/WalletConnect.tsx](../components/WalletConnect.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx), [hooks/useAccountData.ts](../hooks/useAccountData.ts) |
| [components/TradeForm.tsx](../components/TradeForm.tsx) | 343 | [app/actions/trade.ts](../app/actions/trade.ts), [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/input.tsx](../components/ui/input.tsx), [components/ui/label.tsx](../components/ui/label.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/TradingAndRisk.tsx](../components/TradingAndRisk.tsx) | 33 | [components/HyperliquidApiWalletSettings.tsx](../components/HyperliquidApiWalletSettings.tsx), [components/TradeForm.tsx](../components/TradeForm.tsx), [components/ui/card.tsx](../components/ui/card.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/WalletConnect.tsx](../components/WalletConnect.tsx) | 221 | [components/ui/button.tsx](../components/ui/button.tsx), [components/ui/label.tsx](../components/ui/label.tsx), [components/ui/switch.tsx](../components/ui/switch.tsx), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/Web3Provider.tsx](../components/Web3Provider.tsx) | 47 | — |
| [components/desk/AnalystStation.tsx](../components/desk/AnalystStation.tsx) | 75 | [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [components/desk/DeskBlotter.tsx](../components/desk/DeskBlotter.tsx) | 294 | [components/desk/DeskUsage.tsx](../components/desk/DeskUsage.tsx), [components/desk/desk-view.ts](../components/desk/desk-view.ts), [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [components/desk/DeskControls.tsx](../components/desk/DeskControls.tsx) | 246 | [components/desk/desk-view.ts](../components/desk/desk-view.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts) |
| [components/desk/DeskOffice.tsx](../components/desk/DeskOffice.tsx) | 222 | [components/desk/AnalystStation.tsx](../components/desk/AnalystStation.tsx), [components/desk/desk-view.ts](../components/desk/desk-view.ts), [components/desk/useDeskActivity.ts](../components/desk/useDeskActivity.ts), [lib/desk/activity-types.ts](../lib/desk/activity-types.ts), [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [components/desk/DeskUsage.tsx](../components/desk/DeskUsage.tsx) | 176 | [lib/desk/token-usage.ts](../lib/desk/token-usage.ts) |
| [components/desk/TradingDesk.tsx](../components/desk/TradingDesk.tsx) | 322 | [components/desk/DeskBlotter.tsx](../components/desk/DeskBlotter.tsx), [components/desk/DeskControls.tsx](../components/desk/DeskControls.tsx), [components/desk/DeskOffice.tsx](../components/desk/DeskOffice.tsx), [components/desk/DeskUsage.tsx](../components/desk/DeskUsage.tsx), [components/desk/desk-view.ts](../components/desk/desk-view.ts), [context/TradingContext.tsx](../context/TradingContext.tsx) |
| [components/desk/desk-view.ts](../components/desk/desk-view.ts) | 129 | [lib/desk/mandate.ts](../lib/desk/mandate.ts) |
| [components/desk/useDeskActivity.ts](../components/desk/useDeskActivity.ts) | 67 | [lib/desk/activity-types.ts](../lib/desk/activity-types.ts) |
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
| [config/news-rss-sources.json](../config/news-rss-sources.json) | 5 | — |
| [config/news-sources.json](../config/news-sources.json) | 28 | — |

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
| [lib/agent-config.ts](../lib/agent-config.ts) | 941 | [lib/candidate-promotion.ts](../lib/candidate-promotion.ts) |
| [lib/app-database-provider.ts](../lib/app-database-provider.ts) | 5 | — |
| [lib/auth/internal.ts](../lib/auth/internal.ts) | 30 | — |
| [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts) | 217 | — |
| [lib/candidate-promotion-priors.ts](../lib/candidate-promotion-priors.ts) | 153 | [lib/candidate-promotion.ts](../lib/candidate-promotion.ts) |
| [lib/candidate-promotion.ts](../lib/candidate-promotion.ts) | 299 | [services/MarketStructureService.ts](../services/MarketStructureService.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [lib/db.ts](../lib/db.ts) | 60 | [lib/app-database-provider.ts](../lib/app-database-provider.ts) |
| [lib/desk/activity-state.ts](../lib/desk/activity-state.ts) | 81 | [lib/desk/activity-types.ts](../lib/desk/activity-types.ts), [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [lib/desk/activity-types.ts](../lib/desk/activity-types.ts) | 28 | [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [lib/desk/analytics.ts](../lib/desk/analytics.ts) | 637 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/db.ts](../lib/db.ts), [lib/desk/backtest-tools.ts](../lib/desk/backtest-tools.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts), [lib/desk/market.ts](../lib/desk/market.ts), [lib/desk/news-sentiment.ts](../lib/desk/news-sentiment.ts), [lib/desk/read-cache.ts](../lib/desk/read-cache.ts), [lib/desk/research-data.ts](../lib/desk/research-data.ts), [lib/desk/runtime.ts](../lib/desk/runtime.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [services/MarketDerivedMetricsService.ts](../services/MarketDerivedMetricsService.ts), [services/MarketSnapshotAssembler.ts](../services/MarketSnapshotAssembler.ts), [services/MarketStructureService.ts](../services/MarketStructureService.ts), [services/RegimeService.ts](../services/RegimeService.ts), [services/RegimeUniverseService.ts](../services/RegimeUniverseService.ts), [services/ScreenerService.ts](../services/ScreenerService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [lib/desk/artifacts.ts](../lib/desk/artifacts.ts) | 74 | — |
| [lib/desk/assessment.ts](../lib/desk/assessment.ts) | 85 | — |
| [lib/desk/backtest/data.ts](../lib/desk/backtest/data.ts) | 374 | [lib/desk/backtest/types.ts](../lib/desk/backtest/types.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) |
| [lib/desk/backtest/engine.ts](../lib/desk/backtest/engine.ts) | 478 | [lib/desk/backtest/request.ts](../lib/desk/backtest/request.ts), [lib/desk/backtest/types.ts](../lib/desk/backtest/types.ts), [lib/desk/execution-risk.ts](../lib/desk/execution-risk.ts), [lib/desk/execution-types.ts](../lib/desk/execution-types.ts) |
| [lib/desk/backtest/jobs.ts](../lib/desk/backtest/jobs.ts) | 210 | [lib/desk/artifacts.ts](../lib/desk/artifacts.ts), [lib/desk/backtest/request.ts](../lib/desk/backtest/request.ts), [lib/desk/backtest/types.ts](../lib/desk/backtest/types.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts), [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [lib/desk/backtest/process.ts](../lib/desk/backtest/process.ts) | 97 | — |
| [lib/desk/backtest/request.ts](../lib/desk/backtest/request.ts) | 233 | [lib/desk/backtest/types.ts](../lib/desk/backtest/types.ts), [lib/desk/execution-risk.ts](../lib/desk/execution-risk.ts) |
| [lib/desk/backtest/types.ts](../lib/desk/backtest/types.ts) | 106 | [lib/desk/execution-types.ts](../lib/desk/execution-types.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts) |
| [lib/desk/backtest-tools.ts](../lib/desk/backtest-tools.ts) | 35 | [lib/db.ts](../lib/db.ts), [lib/desk/artifacts.ts](../lib/desk/artifacts.ts), [lib/desk/backtest/data.ts](../lib/desk/backtest/data.ts), [lib/desk/backtest/jobs.ts](../lib/desk/backtest/jobs.ts), [lib/desk/backtest/request.ts](../lib/desk/backtest/request.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/runtime.ts](../lib/desk/runtime.ts) |
| [lib/desk/books.ts](../lib/desk/books.ts) | 179 | [lib/db.ts](../lib/db.ts), [lib/desk/execution-lease.ts](../lib/desk/execution-lease.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [lib/desk/catalyst-memory.ts](../lib/desk/catalyst-memory.ts) | 72 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/public-cache.ts](../lib/desk/public-cache.ts), [lib/desk/research.ts](../lib/desk/research.ts), [lib/desk/review-schedule.ts](../lib/desk/review-schedule.ts), [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [lib/desk/derivatives.ts](../lib/desk/derivatives.ts) | 117 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [lib/desk/errors.ts](../lib/desk/errors.ts) | 17 | — |
| [lib/desk/execution-lease.ts](../lib/desk/execution-lease.ts) | 113 | — |
| [lib/desk/execution-ledger.ts](../lib/desk/execution-ledger.ts) | 246 | [lib/desk/execution-risk.ts](../lib/desk/execution-risk.ts), [lib/desk/execution-types.ts](../lib/desk/execution-types.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts) |
| [lib/desk/execution-risk.ts](../lib/desk/execution-risk.ts) | 201 | [lib/desk/execution-types.ts](../lib/desk/execution-types.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts) |
| [lib/desk/execution-types.ts](../lib/desk/execution-types.ts) | 101 | [lib/desk/instruments.ts](../lib/desk/instruments.ts) |
| [lib/desk/execution.ts](../lib/desk/execution.ts) | 1084 | [lib/db.ts](../lib/db.ts), [lib/desk/execution-ledger.ts](../lib/desk/execution-ledger.ts), [lib/desk/execution-risk.ts](../lib/desk/execution-risk.ts), [lib/desk/execution-types.ts](../lib/desk/execution-types.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts), [lib/desk/venue.ts](../lib/desk/venue.ts) |
| [lib/desk/instruments.ts](../lib/desk/instruments.ts) | 81 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [lib/desk/journal.ts](../lib/desk/journal.ts) | 69 | [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/errors.ts](../lib/desk/errors.ts), [lib/desk/roles.ts](../lib/desk/roles.ts), [lib/desk/routine-work.ts](../lib/desk/routine-work.ts) |
| [lib/desk/mandate.ts](../lib/desk/mandate.ts) | 33 | — |
| [lib/desk/market.ts](../lib/desk/market.ts) | 73 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [lib/desk/news-exposure.ts](../lib/desk/news-exposure.ts) | 67 | [lib/db.ts](../lib/db.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/market.ts](../lib/desk/market.ts) |
| [lib/desk/news-sentiment.ts](../lib/desk/news-sentiment.ts) | 37 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/news/account.ts](../lib/news/account.ts), [lib/news/desk-routing.ts](../lib/news/desk-routing.ts), [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) |
| [lib/desk/pass-review.ts](../lib/desk/pass-review.ts) | 129 | [lib/db.ts](../lib/db.ts), [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/execution-risk.ts](../lib/desk/execution-risk.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/mandate.ts](../lib/desk/mandate.ts), [lib/desk/market.ts](../lib/desk/market.ts), [lib/desk/news-exposure.ts](../lib/desk/news-exposure.ts) |
| [lib/desk/proposals.ts](../lib/desk/proposals.ts) | 458 | [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/journal.ts](../lib/desk/journal.ts), [lib/desk/roles.ts](../lib/desk/roles.ts), [lib/desk/roundtable.ts](../lib/desk/roundtable.ts) |
| [lib/desk/public-cache.ts](../lib/desk/public-cache.ts) | 118 | [lib/app-database-provider.ts](../lib/app-database-provider.ts), [lib/desk/research.ts](../lib/desk/research.ts) |
| [lib/desk/read-cache.ts](../lib/desk/read-cache.ts) | 72 | — |
| [lib/desk/research-data.ts](../lib/desk/research-data.ts) | 148 | — |
| [lib/desk/research.ts](../lib/desk/research.ts) | 328 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/runtime.ts](../lib/desk/runtime.ts) |
| [lib/desk/review-schedule.ts](../lib/desk/review-schedule.ts) | 49 | [lib/desk/execution-risk.ts](../lib/desk/execution-risk.ts), [lib/desk/market.ts](../lib/desk/market.ts) |
| [lib/desk/roles.ts](../lib/desk/roles.ts) | 112 | — |
| [lib/desk/roundtable.ts](../lib/desk/roundtable.ts) | 669 | [lib/desk/activity-types.ts](../lib/desk/activity-types.ts), [lib/desk/proposals.ts](../lib/desk/proposals.ts), [lib/desk/roles.ts](../lib/desk/roles.ts), [lib/desk/routine-work.ts](../lib/desk/routine-work.ts), [lib/desk/runtime.ts](../lib/desk/runtime.ts), [lib/desk/work-routing.ts](../lib/desk/work-routing.ts) |
| [lib/desk/routine-work.ts](../lib/desk/routine-work.ts) | 134 | [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [lib/desk/runtime.ts](../lib/desk/runtime.ts) | 467 | [lib/desk/roles.ts](../lib/desk/roles.ts), [lib/desk/token-usage.ts](../lib/desk/token-usage.ts), [lib/desk/turn-deadline.ts](../lib/desk/turn-deadline.ts), [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts) |
| [lib/desk/shifts.ts](../lib/desk/shifts.ts) | 457 | [lib/db.ts](../lib/db.ts), [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/catalyst-memory.ts](../lib/desk/catalyst-memory.ts), [lib/desk/errors.ts](../lib/desk/errors.ts), [lib/desk/journal.ts](../lib/desk/journal.ts), [lib/desk/proposals.ts](../lib/desk/proposals.ts), [lib/desk/review-schedule.ts](../lib/desk/review-schedule.ts), [lib/desk/roles.ts](../lib/desk/roles.ts), [lib/desk/roundtable.ts](../lib/desk/roundtable.ts), [lib/desk/routine-work.ts](../lib/desk/routine-work.ts), [lib/desk/tools.ts](../lib/desk/tools.ts), [lib/desk/work-routing.ts](../lib/desk/work-routing.ts) |
| [lib/desk/token-usage.ts](../lib/desk/token-usage.ts) | 182 | [lib/db.ts](../lib/db.ts) |
| [lib/desk/tools.ts](../lib/desk/tools.ts) | 863 | [lib/db.ts](../lib/db.ts), [lib/desk/analytics.ts](../lib/desk/analytics.ts), [lib/desk/artifacts.ts](../lib/desk/artifacts.ts), [lib/desk/assessment.ts](../lib/desk/assessment.ts), [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/derivatives.ts](../lib/desk/derivatives.ts), [lib/desk/execution.ts](../lib/desk/execution.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/journal.ts](../lib/desk/journal.ts), [lib/desk/market.ts](../lib/desk/market.ts), [lib/desk/public-cache.ts](../lib/desk/public-cache.ts), [lib/desk/read-cache.ts](../lib/desk/read-cache.ts), [lib/desk/research.ts](../lib/desk/research.ts), [lib/desk/roundtable.ts](../lib/desk/roundtable.ts), [lib/desk/routine-work.ts](../lib/desk/routine-work.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/news/account.ts](../lib/news/account.ts), [lib/news/desk-events.ts](../lib/news/desk-events.ts), [lib/news/market-observation.ts](../lib/news/market-observation.ts), [lib/news-db.ts](../lib/news-db.ts), [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) |
| [lib/desk/triggers.ts](../lib/desk/triggers.ts) | 368 | [lib/app-database-provider.ts](../lib/app-database-provider.ts), [lib/db.ts](../lib/db.ts), [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/execution-risk.ts](../lib/desk/execution-risk.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/desk/market.ts](../lib/desk/market.ts), [lib/desk/news-exposure.ts](../lib/desk/news-exposure.ts), [lib/desk/pass-review.ts](../lib/desk/pass-review.ts), [lib/desk/routine-work.ts](../lib/desk/routine-work.ts), [lib/news/desk-events.ts](../lib/news/desk-events.ts) |
| [lib/desk/turn-deadline.ts](../lib/desk/turn-deadline.ts) | 38 | — |
| [lib/desk/venue.ts](../lib/desk/venue.ts) | 165 | [lib/desk/execution-types.ts](../lib/desk/execution-types.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [lib/desk/work-routing.ts](../lib/desk/work-routing.ts) | 19 | [lib/desk/roles.ts](../lib/desk/roles.ts) |
| [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts) | 285 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/db.ts](../lib/db.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts) | 299 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/log/safeLogger.ts](../lib/log/safeLogger.ts), [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) | 279 | [lib/log/safeLogger.ts](../lib/log/safeLogger.ts), [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts) | 219 | — |
| [lib/hyperliquid.ts](../lib/hyperliquid.ts) | 1 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [lib/hyperliquidExecution.ts](../lib/hyperliquidExecution.ts) | 109 | [lib/hyperliquid-execution.ts](../lib/hyperliquid-execution.ts), [types/trading.ts](../types/trading.ts) |
| [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts) | 120 | — |
| [lib/llm/provider.ts](../lib/llm/provider.ts) | 80 | [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [lib/llm/schemas.ts](../lib/llm/schemas.ts) | 43 | — |
| [lib/log/safeLogger.ts](../lib/log/safeLogger.ts) | 82 | — |
| [lib/log/traderLog.ts](../lib/log/traderLog.ts) | 21 | — |
| [lib/log/tradingLogger.ts](../lib/log/tradingLogger.ts) | 37 | — |
| [lib/market-db.ts](../lib/market-db.ts) | 26 | — |
| [lib/news/account.ts](../lib/news/account.ts) | 7 | — |
| [lib/news/analysis-batch.ts](../lib/news/analysis-batch.ts) | 33 | [lib/news/source-catalog.ts](../lib/news/source-catalog.ts) |
| [lib/news/desk-events.ts](../lib/news/desk-events.ts) | 72 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/news/account.ts](../lib/news/account.ts), [lib/news/desk-routing.ts](../lib/news/desk-routing.ts), [lib/news-db.ts](../lib/news-db.ts) |
| [lib/news/desk-routing.ts](../lib/news/desk-routing.ts) | 330 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/news/source-catalog.ts](../lib/news/source-catalog.ts), [lib/news/validation.ts](../lib/news/validation.ts), [types/news.ts](../types/news.ts) |
| [lib/news/market-observation.ts](../lib/news/market-observation.ts) | 88 | [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) |
| [lib/news/observation.ts](../lib/news/observation.ts) | 11 | [lib/news/validation.ts](../lib/news/validation.ts) |
| [lib/news/source-catalog.ts](../lib/news/source-catalog.ts) | 24 | [config/news-sources.json](../config/news-sources.json) |
| [lib/news/validation.ts](../lib/news/validation.ts) | 98 | [lib/llm/schemas.ts](../lib/llm/schemas.ts), [lib/news/source-catalog.ts](../lib/news/source-catalog.ts), [types/news.ts](../types/news.ts) |
| [lib/news-db.ts](../lib/news-db.ts) | 6 | — |
| [lib/rate-limit/hyperliquid-limiter.ts](../lib/rate-limit/hyperliquid-limiter.ts) | 200 | — |
| [lib/risk/execution-safety.ts](../lib/risk/execution-safety.ts) | 26 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/risk/kill-switch.ts](../lib/risk/kill-switch.ts), [services/AccountStateService.ts](../services/AccountStateService.ts) |
| [lib/risk/kill-switch.ts](../lib/risk/kill-switch.ts) | 59 | [lib/db.ts](../lib/db.ts), [lib/log/safeLogger.ts](../lib/log/safeLogger.ts) |
| [lib/risk/shared.ts](../lib/risk/shared.ts) | 299 | [lib/agent-config.ts](../lib/agent-config.ts), [types/snapshot.ts](../types/snapshot.ts), [types/trading.ts](../types/trading.ts) |
| [lib/screener-config.ts](../lib/screener-config.ts) | 217 | — |
| [lib/screener-normalization.ts](../lib/screener-normalization.ts) | 91 | [lib/screener-config.ts](../lib/screener-config.ts) |
| [lib/screening-storage.ts](../lib/screening-storage.ts) | 121 | [lib/screener-config.ts](../lib/screener-config.ts), [lib/screener-normalization.ts](../lib/screener-normalization.ts) |
| [lib/trade-utils.ts](../lib/trade-utils.ts) | 39 | — |
| [lib/trading/execution-cost.ts](../lib/trading/execution-cost.ts) | 29 | — |
| [lib/utils.ts](../lib/utils.ts) | 6 | — |

## prisma

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [prisma/app-postgres/migrations/20261104000000_application_baseline/migration.sql](../prisma/app-postgres/migrations/20261104000000_application_baseline/migration.sql) | 1121 | — |
| [prisma/app-postgres/migrations/20261106000000_remove_legacy_sentiment/migration.sql](../prisma/app-postgres/migrations/20261106000000_remove_legacy_sentiment/migration.sql) | 4 | — |
| [prisma/app-postgres/migrations/20261106120000_desk_research_remove_legacy/migration.sql](../prisma/app-postgres/migrations/20261106120000_desk_research_remove_legacy/migration.sql) | 121 | — |
| [prisma/app-postgres/migrations/migration_lock.toml](../prisma/app-postgres/migrations/migration_lock.toml) | 1 | — |
| [prisma/local-intelligence/schema.prisma](../prisma/local-intelligence/schema.prisma) | 53 | — |
| [prisma/market/migrations/20251125081655_init/migration.sql](../prisma/market/migrations/20251125081655_init/migration.sql) | 40 | — |
| [prisma/market/migrations/20260523000000_add_market_candle_source/migration.sql](../prisma/market/migrations/20260523000000_add_market_candle_source/migration.sql) | 2 | — |
| [prisma/market/migrations/20260531000000_add_market_candle_readiness_index/migration.sql](../prisma/market/migrations/20260531000000_add_market_candle_readiness_index/migration.sql) | 3 | — |
| [prisma/market/migrations/migration_lock.toml](../prisma/market/migrations/migration_lock.toml) | 3 | — |
| [prisma/market/schema.prisma](../prisma/market/schema.prisma) | 48 | — |
| [prisma/migrate_data.sql](../prisma/migrate_data.sql) | 20 | — |
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
| [prisma/migrations/20261102000000_desk_books/migration.sql](../prisma/migrations/20261102000000_desk_books/migration.sql) | 126 | — |
| [prisma/migrations/20261102010000_desk_execution/migration.sql](../prisma/migrations/20261102010000_desk_execution/migration.sql) | 124 | — |
| [prisma/migrations/20261103000000_desk_token_usage/migration.sql](../prisma/migrations/20261103000000_desk_token_usage/migration.sql) | 25 | — |
| [prisma/migrations/20261103010000_desk_public_cache/migration.sql](../prisma/migrations/20261103010000_desk_public_cache/migration.sql) | 14 | — |
| [prisma/migrations/20261106000000_remove_legacy_sentiment/migration.sql](../prisma/migrations/20261106000000_remove_legacy_sentiment/migration.sql) | 4 | — |
| [prisma/migrations/20261106120000_desk_research_remove_legacy/migration.sql](../prisma/migrations/20261106120000_desk_research_remove_legacy/migration.sql) | 117 | — |
| [prisma/migrations/migration_lock.toml](../prisma/migrations/migration_lock.toml) | 3 | — |
| [prisma/news/migrations/20261031000000_news_intelligence/migration.sql](../prisma/news/migrations/20261031000000_news_intelligence/migration.sql) | 144 | — |
| [prisma/news/migrations/20261102000000_desk_event_revisions/migration.sql](../prisma/news/migrations/20261102000000_desk_event_revisions/migration.sql) | 22 | — |
| [prisma/news/migrations/migration_lock.toml](../prisma/news/migrations/migration_lock.toml) | 1 | — |
| [prisma/news/schema.prisma](../prisma/news/schema.prisma) | 125 | — |
| [prisma/runtime-market/migrations/20261031000000_vps_market/migration.sql](../prisma/runtime-market/migrations/20261031000000_vps_market/migration.sql) | 49 | — |
| [prisma/runtime-market/migrations/migration_lock.toml](../prisma/runtime-market/migrations/migration_lock.toml) | 1 | — |
| [prisma/runtime-market/schema.prisma](../prisma/runtime-market/schema.prisma) | 48 | — |
| [prisma/schema.dev.prisma](../prisma/schema.dev.prisma) | 66 | — |
| [prisma/schema.prisma](../prisma/schema.prisma) | 402 | — |

## prompts

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [prompts/NewsAnalyst.ts](../prompts/NewsAnalyst.ts) | 19 | — |

## scripts

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [scripts/adhoc_backfill_48h.ts](../scripts/adhoc_backfill_48h.ts) | 87 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/audit_derivatives.ts](../scripts/audit_derivatives.ts) | 49 | [lib/db.ts](../lib/db.ts) |
| [scripts/backfill_24h.ts](../scripts/backfill_24h.ts) | 78 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/backfill_testnet_only.ts](../scripts/backfill_testnet_only.ts) | 74 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/backtest_candles.ts](../scripts/backtest_candles.ts) | 116 | [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts), [src/backtest/RealCandleHydrator.ts](../src/backtest/RealCandleHydrator.ts) |
| [scripts/backtest_features.ts](../scripts/backtest_features.ts) | 102 | [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts), [src/backtest/L2FeatureBuilder.ts](../src/backtest/L2FeatureBuilder.ts) |
| [scripts/backtest_parquet.py](../scripts/backtest_parquet.py) | 11 | [backtest_py/parquet_store.py](../backtest_py/parquet_store.py) |
| [scripts/build_collectors.mjs](../scripts/build_collectors.mjs) | 16 | — |
| [scripts/check_db_counts.ts](../scripts/check_db_counts.ts) | 17 | [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/check_vol.ts](../scripts/check_vol.ts) | 28 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/configure_news_sources.ts](../scripts/configure_news_sources.ts) | 25 | [config/news-sources.json](../config/news-sources.json), [lib/db.ts](../lib/db.ts), [lib/news-db.ts](../lib/news-db.ts), [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) |
| [scripts/configure_vps.mjs](../scripts/configure_vps.mjs) | 37 | — |
| [scripts/debug-hyperliquid.ts](../scripts/debug-hyperliquid.ts) | 51 | — |
| [scripts/debug_analytics.ts](../scripts/debug_analytics.ts) | 81 | [services/TradeHistoryService.ts](../services/TradeHistoryService.ts) |
| [scripts/debug_backfill.ts](../scripts/debug_backfill.ts) | 23 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [services/MarketCollectorService.ts](../services/MarketCollectorService.ts) |
| [scripts/debug_ftm.ts](../scripts/debug_ftm.ts) | 18 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/debug_ohlcv.ts](../scripts/debug_ohlcv.ts) | 16 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/debug_testnet.ts](../scripts/debug_testnet.ts) | 25 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/desk_architecture_rollout.ts](../scripts/desk_architecture_rollout.ts) | 47 | [lib/db.ts](../lib/db.ts), [lib/desk/books.ts](../lib/desk/books.ts), [lib/hyperliquid-api-wallet.ts](../lib/hyperliquid-api-wallet.ts) |
| [scripts/desk_research_backtest.ts](../scripts/desk_research_backtest.ts) | 84 | [lib/db.ts](../lib/db.ts), [lib/desk/artifacts.ts](../lib/desk/artifacts.ts), [lib/desk/backtest/data.ts](../lib/desk/backtest/data.ts), [lib/desk/backtest/engine.ts](../lib/desk/backtest/engine.ts), [lib/desk/backtest/jobs.ts](../lib/desk/backtest/jobs.ts), [lib/desk/backtest/request.ts](../lib/desk/backtest/request.ts), [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/diagnose_news.ts](../scripts/diagnose_news.ts) | 23 | [lib/db.ts](../lib/db.ts), [lib/news/validation.ts](../lib/news/validation.ts), [lib/news-db.ts](../lib/news-db.ts) |
| [scripts/download_hl_l2.ts](../scripts/download_hl_l2.ts) | 293 | — |
| [scripts/enable_wal.ts](../scripts/enable_wal.ts) | 26 | [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/evaluate_news.ts](../scripts/evaluate_news.ts) | 32 | [lib/db.ts](../lib/db.ts), [lib/llm/schemas.ts](../lib/llm/schemas.ts), [lib/news/validation.ts](../lib/news/validation.ts), [prompts/NewsAnalyst.ts](../prompts/NewsAnalyst.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [scripts/generate_module_index.py](../scripts/generate_module_index.py) | 54 | — |
| [scripts/inspect_api.ts](../scripts/inspect_api.ts) | 11 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/inspect_fills.ts](../scripts/inspect_fills.ts) | 33 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/install_local_runtime.ps1](../scripts/install_local_runtime.ps1) | 13 | — |
| [scripts/install_trading_desk.mjs](../scripts/install_trading_desk.mjs) | 97 | — |
| [scripts/manual_backfill.ts](../scripts/manual_backfill.ts) | 53 | [lib/market-db.ts](../lib/market-db.ts), [services/MarketCollectorService.ts](../services/MarketCollectorService.ts) |
| [scripts/migrate-db.js](../scripts/migrate-db.js) | 85 | — |
| [scripts/migrate_app.mjs](../scripts/migrate_app.mjs) | 9 | [scripts/prepare_app_postgres.mjs](../scripts/prepare_app_postgres.mjs) |
| [scripts/migrate_app_to_postgres.py](../scripts/migrate_app_to_postgres.py) | 96 | — |
| [scripts/migrate_market_to_vps.py](../scripts/migrate_market_to_vps.py) | 76 | — |
| [scripts/prepare_app_postgres.mjs](../scripts/prepare_app_postgres.mjs) | 7 | — |
| [scripts/prepare_backtest_storage.sh](../scripts/prepare_backtest_storage.sh) | 13 | — |
| [scripts/purge_db.ts](../scripts/purge_db.ts) | 19 | [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/rate_limit_probe.ts](../scripts/rate_limit_probe.ts) | 138 | — |
| [scripts/recover_backtest_archive.py](../scripts/recover_backtest_archive.py) | 105 | — |
| [scripts/resume_market_import.py](../scripts/resume_market_import.py) | 28 | — |
| [scripts/runtime_status.ts](../scripts/runtime_status.ts) | 39 | [lib/db.ts](../lib/db.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/news-db.ts](../lib/news-db.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts) |
| [scripts/start_collector.ts](../scripts/start_collector.ts) | 17 | [services/CollectorRunner.ts](../services/CollectorRunner.ts) |
| [scripts/start_intelligence_worker.ts](../scripts/start_intelligence_worker.ts) | 69 | [lib/db.ts](../lib/db.ts), [lib/news/account.ts](../lib/news/account.ts), [lib/news-db.ts](../lib/news-db.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts), [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) |
| [scripts/start_local_runtime.py](../scripts/start_local_runtime.py) | 85 | — |
| [scripts/start_research_worker.ts](../scripts/start_research_worker.ts) | 29 | [lib/db.ts](../lib/db.ts), [services/DeskResearchWorker.ts](../services/DeskResearchWorker.ts) |
| [scripts/start_trading_desk.ts](../scripts/start_trading_desk.ts) | 47 | [lib/db.ts](../lib/db.ts), [services/TradingDeskWorker.ts](../services/TradingDeskWorker.ts) |
| [scripts/test-rate-limit.ts](../scripts/test-rate-limit.ts) | 50 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/test_backfill_limit.ts](../scripts/test_backfill_limit.ts) | 22 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/test_screener_logic.ts](../scripts/test_screener_logic.ts) | 93 | [lib/screener-config.ts](../lib/screener-config.ts), [services/ScreenerService.ts](../services/ScreenerService.ts) |
| [scripts/tmp_backfill_asset_ctx_universe.ts](../scripts/tmp_backfill_asset_ctx_universe.ts) | 257 | [lib/market-db.ts](../lib/market-db.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) |
| [scripts/tmp_backfill_main_from_backtest_hour.ts](../scripts/tmp_backfill_main_from_backtest_hour.ts) | 176 | [lib/market-db.ts](../lib/market-db.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) |
| [scripts/trigger_analysis.ts](../scripts/trigger_analysis.ts) | 65 | — |
| [scripts/updateSymbols.ts](../scripts/updateSymbols.ts) | 67 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [scripts/update_live_market_window.ts](../scripts/update_live_market_window.ts) | 171 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) |
| [scripts/verify_backfill.ts](../scripts/verify_backfill.ts) | 20 | [lib/market-db.ts](../lib/market-db.ts) |
| [scripts/verify_desk_research.ts](../scripts/verify_desk_research.ts) | 41 | [lib/auth/wallet-session.ts](../lib/auth/wallet-session.ts), [lib/db.ts](../lib/db.ts), [lib/desk/backtest/jobs.ts](../lib/desk/backtest/jobs.ts), [lib/desk/books.ts](../lib/desk/books.ts) |
| [scripts/verify_market_db.ts](../scripts/verify_market_db.ts) | 22 | [lib/market-db.ts](../lib/market-db.ts) |

## services

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [services/AccountStateService.ts](../services/AccountStateService.ts) | 130 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/log/traderLog.ts](../lib/log/traderLog.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/CodexQueueService.ts](../services/CodexQueueService.ts) | 114 | [lib/db.ts](../lib/db.ts), [lib/llm/codex-runner.ts](../lib/llm/codex-runner.ts) |
| [services/CollectorRunner.ts](../services/CollectorRunner.ts) | 731 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts), [services/MarketCollectorService.ts](../services/MarketCollectorService.ts), [services/MarketUniverse.ts](../services/MarketUniverse.ts) |
| [services/DeskResearchWorker.ts](../services/DeskResearchWorker.ts) | 211 | [lib/db.ts](../lib/db.ts), [lib/desk/backtest/process.ts](../lib/desk/backtest/process.ts), [lib/desk/books.ts](../lib/desk/books.ts) |
| [services/HeldPositionMarketResolver.ts](../services/HeldPositionMarketResolver.ts) | 110 | [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts) | 642 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/screener-config.ts](../lib/screener-config.ts) |
| [services/MarketCollectorService.ts](../services/MarketCollectorService.ts) | 307 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts), [lib/market-db.ts](../lib/market-db.ts), [services/MarketUniverse.ts](../services/MarketUniverse.ts) |
| [services/MarketDerivedMetricsService.ts](../services/MarketDerivedMetricsService.ts) | 295 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/trading/execution-cost.ts](../lib/trading/execution-cost.ts), [services/MarketStructureService.ts](../services/MarketStructureService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/MarketSnapshotAssembler.ts](../services/MarketSnapshotAssembler.ts) | 72 | [services/ScreenerService.ts](../services/ScreenerService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/MarketStructureService.ts](../services/MarketStructureService.ts) | 151 | [types/snapshot.ts](../types/snapshot.ts) |
| [services/MarketUniverse.ts](../services/MarketUniverse.ts) | 99 | — |
| [services/NewsIntelligenceService.ts](../services/NewsIntelligenceService.ts) | 328 | [lib/db.ts](../lib/db.ts), [lib/desk/instruments.ts](../lib/desk/instruments.ts), [lib/llm/provider.ts](../lib/llm/provider.ts), [lib/llm/schemas.ts](../lib/llm/schemas.ts), [lib/news/account.ts](../lib/news/account.ts), [lib/news/analysis-batch.ts](../lib/news/analysis-batch.ts), [lib/news/desk-routing.ts](../lib/news/desk-routing.ts), [lib/news/source-catalog.ts](../lib/news/source-catalog.ts), [lib/news/validation.ts](../lib/news/validation.ts), [lib/news-db.ts](../lib/news-db.ts), [prompts/NewsAnalyst.ts](../prompts/NewsAnalyst.ts), [services/CodexQueueService.ts](../services/CodexQueueService.ts), [types/news.ts](../types/news.ts) |
| [services/OrderBookManager.ts](../services/OrderBookManager.ts) | 159 | [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts) |
| [services/PriceAlertsService.ts](../services/PriceAlertsService.ts) | 223 | [lib/db.ts](../lib/db.ts) |
| [services/RegimeService.ts](../services/RegimeService.ts) | 316 | [types/snapshot.ts](../types/snapshot.ts) |
| [services/RegimeUniverseService.ts](../services/RegimeUniverseService.ts) | 233 | [lib/market-db.ts](../lib/market-db.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [types/snapshot.ts](../types/snapshot.ts) |
| [services/ScreenerService.ts](../services/ScreenerService.ts) | 803 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/hyperliquid-ws.ts](../lib/hyperliquid-ws.ts), [lib/market-db.ts](../lib/market-db.ts), [lib/screener-config.ts](../lib/screener-config.ts), [lib/trading/execution-cost.ts](../lib/trading/execution-cost.ts), [services/MarketAnalysisService.ts](../services/MarketAnalysisService.ts), [services/OrderBookManager.ts](../services/OrderBookManager.ts) |
| [services/TradeHistoryService.ts](../services/TradeHistoryService.ts) | 296 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts) |
| [services/TradingDeskWorker.ts](../services/TradingDeskWorker.ts) | 211 | [lib/app-database-provider.ts](../lib/app-database-provider.ts), [lib/db.ts](../lib/db.ts), [lib/desk/books.ts](../lib/desk/books.ts), [lib/desk/errors.ts](../lib/desk/errors.ts), [lib/desk/execution.ts](../lib/desk/execution.ts), [lib/desk/runtime.ts](../lib/desk/runtime.ts), [lib/desk/shifts.ts](../lib/desk/shifts.ts), [lib/desk/triggers.ts](../lib/desk/triggers.ts) |

## src

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [src/backtest/ArchiveHydrator.ts](../src/backtest/ArchiveHydrator.ts) | 1426 | [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts), [src/backtest/ExecutionBookStore.ts](../src/backtest/ExecutionBookStore.ts), [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts), [src/backtest/L2FeatureBuilder.ts](../src/backtest/L2FeatureBuilder.ts) |
| [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) | 168 | — |
| [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) | 72 | — |
| [src/backtest/ExecutionBookStore.ts](../src/backtest/ExecutionBookStore.ts) | 314 | [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |
| [src/backtest/FeatureStore.ts](../src/backtest/FeatureStore.ts) | 310 | [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |
| [src/backtest/L2FeatureBuilder.ts](../src/backtest/L2FeatureBuilder.ts) | 418 | [lib/agent-config.ts](../lib/agent-config.ts), [src/backtest/BacktestTypes.ts](../src/backtest/BacktestTypes.ts) |
| [src/backtest/RealCandleHydrator.ts](../src/backtest/RealCandleHydrator.ts) | 960 | [lib/hyperliquid-info.ts](../lib/hyperliquid-info.ts), [src/backtest/BacktestDb.ts](../src/backtest/BacktestDb.ts) |

## types

| File | Lines | Direct first-party dependencies |
| --- | ---: | --- |
| [types/news.ts](../types/news.ts) | 67 | — |
| [types/snapshot.ts](../types/snapshot.ts) | 209 | [lib/agent-config.ts](../lib/agent-config.ts), [lib/screener-config.ts](../lib/screener-config.ts), [services/MarketStructureService.ts](../services/MarketStructureService.ts), [services/ScreenerService.ts](../services/ScreenerService.ts) |
| [types/trading.ts](../types/trading.ts) | 299 | [types/news.ts](../types/news.ts) |
