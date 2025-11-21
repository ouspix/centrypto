#!/usr/bin/env node
/**
 * Test script for TraderAgent prompt generation subsystems
 * 
 * This script tests:
 * 1. Hyperliquid API data fetching (market data, account state)
 * 2. Sentiment analysis service
 * 3. Snapshot builder (data aggregation)
 * 4. Final prompt generation
 */

import fetch from 'node-fetch';

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

function log(color, symbol, message) {
    console.log(`${color}${symbol} ${message}${colors.reset}`);
}

function section(title) {
    console.log(`\n${colors.cyan}${'='.repeat(80)}`);
    console.log(`${title}`);
    console.log(`${'='.repeat(80)}${colors.reset}\n`);
}

// Test 1: Hyperliquid Meta & Asset Contexts
async function testHyperliquidMeta() {
    section('TEST 1: Hyperliquid Meta & Asset Contexts');

    try {
        const response = await fetch('https://api.hyperliquid-testnet.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'metaAndAssetCtxs' })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        // Handle both array and object response formats
        let universe, assetCtxs;
        if (Array.isArray(data)) {
            if (data.length >= 2 && data[0]?.universe && Array.isArray(data[1])) {
                // Newer API shape: [ { universe, marginTables... }, assetCtxs ]
                universe = data[0].universe;
                assetCtxs = data[1];
            } else if (data.length >= 2) {
                // Legacy shape: [universeArray, assetCtxsArray]
                [universe, assetCtxs] = data;
            }
        } else if (data.universe && data.assetCtxs) {
            universe = data.universe;
            assetCtxs = data.assetCtxs;
        }

        if (!universe || !assetCtxs) {
            throw new Error('Unexpected response format');
        }

        log(colors.green, '✅', `Fetched ${universe.length} assets from Hyperliquid Testnet`);

        // Show first few assets
        const majorAssets = ['BTC', 'ETH', 'SOL', 'ARB'];
        console.log('\nMajor Assets:');
        universe.forEach((asset, i) => {
            if (majorAssets.includes(asset.name)) {
                const ctx = assetCtxs[i];
                console.log(`  ${asset.name}: Price=$${parseFloat(ctx.markPx).toFixed(2)}, Funding=${parseFloat(ctx.funding).toFixed(6)}, OI=$${(parseFloat(ctx.openInterest) * parseFloat(ctx.markPx)).toFixed(0)}`);
            }
        });

        return { success: true, data: { universe, assetCtxs } };
    } catch (error) {
        log(colors.red, '❌', `Failed to fetch meta: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Test 2: OHLCV Data
async function testOHLCV() {
    section('TEST 2: OHLCV Data Fetching');

    try {
        const response = await fetch('https://api.hyperliquid-testnet.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'candleSnapshot',
                req: {
                    coin: 'BTC',
                    interval: '1h',
                    startTime: Date.now() - 24 * 60 * 60 * 1000,
                    endTime: Date.now()
                }
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        log(colors.green, '✅', `Fetched ${data.length} candles for BTC`);

        if (data.length > 0) {
            const latest = data[data.length - 1];
            console.log(`\nLatest BTC Candle:`);
            console.log(`  Open: $${latest.o}`);
            console.log(`  High: $${latest.h}`);
            console.log(`  Low: $${latest.l}`);
            console.log(`  Close: $${latest.c}`);
            console.log(`  Volume: ${latest.v}`);

            // Calculate simple return
            const hourlyReturn = ((latest.c - latest.o) / latest.o * 100).toFixed(2);
            console.log(`  1h Return: ${hourlyReturn}%`);
        }

        return { success: true, data };
    } catch (error) {
        log(colors.red, '❌', `Failed to fetch OHLCV: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Test 3: Sentiment Service
async function testSentiment() {
    section('TEST 3: Sentiment Analysis');

    try {
        const response = await fetch('http://localhost:3000/api/cron/sentiment?coin=BTC');

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        log(colors.green, '✅', `Sentiment service responded`);
        console.log(`\nBTC Sentiment:`);
        console.log(`  Score: ${data.score?.toFixed(3) || 'N/A'}`);
        console.log(`  Mentions: ${data.mentions || 0}`);
        console.log(`  Attention vs baseline: ${data.mentions_vs_baseline?.toFixed(2) || 'N/A'}x`);
        console.log(`  Tags: ${(data.tags || []).join(', ') || 'none'}`);

        return { success: true, data };
    } catch (error) {
        log(colors.yellow, '⚠️', `Sentiment service unavailable: ${error.message}`);
        log(colors.blue, 'ℹ️', 'This is expected if the dev server is not running');
        return { success: false, skipped: true, error: error.message };
    }
}

// Test 4: Account State (if address provided)
async function testAccountState(address) {
    section('TEST 4: Account State');

    if (!address) {
        log(colors.yellow, '⚠️', 'No address provided, skipping account state test');
        return { success: false, skipped: true };
    }

    try {
        const response = await fetch('https://api.hyperliquid-testnet.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'clearinghouseState',
                user: address
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        log(colors.green, '✅', `Fetched account state for ${address.substring(0, 10)}...`);

        console.log(`\nAccount Summary:`);
        console.log(`  Account Value: $${parseFloat(data.marginSummary.accountValue).toFixed(2)}`);
        console.log(`  Total Raw USD: $${parseFloat(data.marginSummary.totalRawUsd).toFixed(2)}`);
        console.log(`  Open Positions: ${data.assetPositions.filter(p => parseFloat(p.position.szi) !== 0).length}`);

        return { success: true, data };
    } catch (error) {
        log(colors.red, '❌', `Failed to fetch account state: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Test 5: Full Snapshot Generation
async function testSnapshotGeneration(address) {
    section('TEST 5: Full Snapshot Generation (via API)');

    try {
        const response = await fetch('http://localhost:3000/api/ai/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userAddress: address || null,
                autoTrading: false,
                model: 'llama3.1:8b'
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        log(colors.green, '✅', 'Successfully generated full snapshot and prompt');

        console.log(`\nSnapshot Summary:`);
        console.log(`  Timestamp: ${new Date(data.snapshot.timestamp * 1000).toISOString()}`);
        console.log(`  Account Equity: $${data.snapshot.account.equity_usd.toFixed(2)}`);
        console.log(`  Markets: ${Object.keys(data.snapshot.markets).join(', ')}`);

        // Show details for first market
        const firstMarket = Object.values(data.snapshot.markets)[0];
        console.log(`\n  First Market (${Object.keys(data.snapshot.markets)[0]}) Details:`);
        console.log(`    Price: $${firstMarket.price}`);
        console.log(`    Spread: ${firstMarket.spread_bps.toFixed(2)} bps`);
        console.log(`    Depth (1%): Bid=$${(firstMarket.depth_usd.bid_1pct / 1000).toFixed(0)}k, Ask=$${(firstMarket.depth_usd.ask_1pct / 1000).toFixed(0)}k`);
        console.log(`    Returns: m1=${(firstMarket.returns.m1 * 100).toFixed(4)}%, m5=${(firstMarket.returns.m5 * 100).toFixed(4)}%`);
        console.log(`    Vol Z-Scores: Vol=${firstMarket.vol_zscores.vol_5m_vs_1h.toFixed(2)}, Ret=${firstMarket.vol_zscores.ret_5m_vs_1h.toFixed(2)}`);
        console.log(`    Regime Tags: ${firstMarket.regime_tags.join(', ') || 'none'}`);

        console.log(`  Constraints: Max Leverage=${data.snapshot.constraints.max_leverage}x`);

        console.log(`\nDecision:`);
        console.log(`  Action: ${data.decision.action}`);
        console.log(`  Confidence: ${(data.decision.confidence * 100).toFixed(0)}%`);
        console.log(`  Reason: ${data.decision.reason_code}`);
        console.log(`  Notes: ${data.decision.notes}`);

        console.log(`\nPrompt Stats:`);
        console.log(`  Length: ${data.prompt.length} characters`);
        console.log(`  Lines: ${data.prompt.split('\n').length}`);
        console.log(`  Contains snapshot: ${data.prompt.includes('MARKET SNAPSHOT') ? 'Yes' : 'No'}`);
        console.log(`  Contains guidelines: ${data.prompt.includes('ANALYSIS GUIDELINES') ? 'Yes' : 'No'}`);

        // Show first 500 chars of prompt
        console.log(`\nPrompt Preview (first 500 chars):`);
        console.log(colors.blue + '─'.repeat(80));
        console.log(data.prompt.substring(0, 500) + '...');
        console.log('─'.repeat(80) + colors.reset);

        return { success: true, data };
    } catch (error) {
        log(colors.red, '❌', `Failed to generate snapshot: ${error.message}`);
        const isConnRefused = error.message.includes('ECONNREFUSED');
        return { success: false, skipped: isConnRefused, error: error.message };
    }
}

// Main test runner
async function runTests() {
    console.log(colors.cyan + '\n╔═══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                   TraderAgent Prompt Generation Test Suite                  ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════╝' + colors.reset);

    const TEST_ADDRESS = '0x7e27565356dbdd81b942893152c26fd2ade6b22f';
    const results = {
        hyperliquidMeta: await testHyperliquidMeta(),
        ohlcv: await testOHLCV(),
        sentiment: await testSentiment(),
        accountState: await testAccountState(TEST_ADDRESS),
        snapshot: await testSnapshotGeneration(TEST_ADDRESS)
    };

    // Summary
    section('TEST SUMMARY');

    const tests = [
        { name: 'Hyperliquid Meta & Asset Contexts', result: results.hyperliquidMeta },
        { name: 'OHLCV Data Fetching', result: results.ohlcv },
        { name: 'Sentiment Analysis', result: results.sentiment },
        { name: 'Account State', result: results.accountState },
        { name: 'Full Snapshot Generation', result: results.snapshot }
    ];

    let passed = 0;
    let failed = 0;
    let skipped = 0;

    tests.forEach(test => {
        if (test.result.skipped) {
            log(colors.yellow, '⊘', `${test.name}: SKIPPED`);
            skipped++;
        } else if (test.result.success) {
            log(colors.green, '✅', `${test.name}: PASSED`);
            passed++;
        } else {
            log(colors.red, '❌', `${test.name}: FAILED`);
            failed++;
        }
    });

    console.log(`\n${colors.cyan}Results: ${colors.green}${passed} passed${colors.reset}, ${colors.red}${failed} failed${colors.reset}, ${colors.yellow}${skipped} skipped${colors.reset}`);

    if (failed === 0 && passed > 0) {
        console.log(`\n${colors.green}✨ All critical tests passed! The prompt generation system is working correctly.${colors.reset}\n`);
    } else if (failed > 0) {
        console.log(`\n${colors.red}⚠️  Some tests failed. Please review the errors above.${colors.reset}\n`);
    }
}

// Run tests
runTests().catch(console.error);
