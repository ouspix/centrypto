import { spawn } from "node:child_process";
import path from "node:path";
function launchResearch(
  input: unknown,
  signal: AbortSignal,
): Promise<{ datasetArtifactId?: string; resultArtifactId?: string; health?: "ready"; sourceHashes?: Record<string,string> }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Research cancelled."));
      return;
    }
    const child = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        "-r",
        "dotenv/config",
        path.join(process.cwd(), "scripts/desk_research_backtest.ts"),
      ],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        env: { ...process.env, DOTENV_CONFIG_PATH: ".env.local" },
      },
    );
    let output = "",
      settled = false;
    const finish = (
      error?: Error,
      value?: { datasetArtifactId?: string; resultArtifactId?: string; health?: "ready"; sourceHashes?: Record<string,string> },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (child.pid)
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill();
        } catch {
          child.kill();
        }
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(new Error("Research cancelled."));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Research exceeded 120 seconds; narrow the window or instrument set.",
          ),
        ),
      120000,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 100000)
        finish(new Error("Research output limit exceeded."));
    });
    child.once("error", () =>
      finish(new Error("Research subprocess unavailable.")),
    );
    child.stdin.on("error", () =>
      finish(new Error("Research subprocess input failed.")),
    );
    child.once("close", (code) => {
      try {
        const line = output
          .split("\n")
          .findLast((l) => l.startsWith("DESK_BACKTEST_RESULT="));
        if (!line) throw new Error("Research subprocess returned no result.");
        const result = JSON.parse(line.slice("DESK_BACKTEST_RESULT=".length));
        if (code !== 0 || result.error)
          throw new Error(result.error || "Research failed.");
        if (result.health !== "ready" && (
          typeof result.datasetArtifactId !== "string" ||
          typeof result.resultArtifactId !== "string"
        ))
          throw new Error("Invalid research artifact references.");
        finish(undefined, result);
      } catch (e) {
        finish(e instanceof Error ? e : new Error("Research failed."));
      }
    });
    if (signal.aborted) {
      abort();
      return;
    }
    child.stdin.end(JSON.stringify(input));
  });
}
export async function researchProcess(input: unknown, signal: AbortSignal) {
  const result=await launchResearch(input,signal);
  if(!result.datasetArtifactId||!result.resultArtifactId)throw new Error("Invalid research artifact references.");
  return {datasetArtifactId:result.datasetArtifactId,resultArtifactId:result.resultArtifactId};
}
/** Imports the real engine in a fresh process; no market request or experiment. */
export async function researchHealthProcess(signal: AbortSignal) {
  const result=await launchResearch({healthCheck:true},AbortSignal.any([signal,AbortSignal.timeout(15000)]));
  if(result.health!=="ready"||!result.sourceHashes)throw new Error("Research runtime probe failed.");
  return result.sourceHashes;
}
