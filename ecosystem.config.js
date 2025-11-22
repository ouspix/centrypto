module.exports = {
    apps: [
        {
            name: "market-collector",
            script: "scripts/run_market_collector.ts",
            interpreter: "node",
            interpreter_args: "--import tsx",
            env: {
                NODE_ENV: "production",
            },
            restart_delay: 5000,
        },
        {
            name: "sentiment",
            script: "scripts/run_sentiment.ts",
            interpreter: "node",
            interpreter_args: "--import tsx",
            env: {
                NODE_ENV: "production",
            },
            restart_delay: 5000,
        },
    ],
};
