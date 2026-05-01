import { parentPort } from "worker_threads";
import { BacktestRunner } from "./BacktestRunner";
import { BacktestRunConfig } from "./BacktestTypes";
import { OptimizerTrialWorkerMessage, OptimizerTrialWorkerResult, runOptimizerCandidate, runOptimizerTrial } from "./WalkForwardOptimizer";

if (!parentPort) {
    throw new Error("OptimizerTrialWorker must run inside a worker thread.");
}

const runner = new BacktestRunner();

parentPort.on("message", async (message: OptimizerTrialWorkerMessage) => {
    if (message.type === "close") {
        parentPort?.close();
        return;
    }

    const result = message.type === "run"
        ? await runOptimizerTrial(
            runner,
            reviveRunConfigDates(message.baseRunConfig),
            message.trialIndex,
            message.gates
        )
        : await runOptimizerCandidate(
            runner,
            reviveRunConfigDates(message.runConfig),
            message.candidate,
            message.gates
        );
    parentPort?.postMessage({
        type: "result",
        trialIndex: message.trialIndex,
        result
    } satisfies OptimizerTrialWorkerResult);
});

function reviveRunConfigDates(config: BacktestRunConfig): BacktestRunConfig {
    return {
        ...config,
        start: new Date(config.start),
        end: new Date(config.end)
    };
}
