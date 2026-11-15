import Module from "node:module";
const loader = Module as any,
  original = loader._load;
loader._load = function (request: string, ...args: any[]) {
  return request === "server-only" ? {} : original.call(this, request, ...args);
};
async function main() {
  const [{ DeskResearchWorker }, { prisma }] = await Promise.all([
    import("../services/DeskResearchWorker"),
    import("../lib/db"),
  ]);
  const worker = new DeskResearchWorker(),
    stop = new AbortController();
  const {verifyResearchRuntime}=await import("../lib/desk/backtest/recovery");
  let checkedAt=0, ready=false;
  process.on("SIGINT", () => stop.abort());
  process.on("SIGTERM", () => stop.abort());
  try {
    while (!stop.signal.aborted) {
      try {
        if(worker.runtimeError)ready=false;
        if(!ready && Date.now()-checkedAt>=60000){
          checkedAt=Date.now();
          ready=(await verifyResearchRuntime(prisma,stop.signal)).status==="ready";
          if(ready)worker.runtimeError=null;
        }
        if(!ready){await new Promise(resolve=>setTimeout(resolve,2000));continue;}
        if (await worker.tick(stop.signal)) continue;
      } catch {
        console.error("Research worker waiting for application database.");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    await prisma.$disconnect();
  }
}
void main();
