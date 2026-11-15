import Module from "node:module";
const loader = Module as any,
  original = loader._load;
loader._load = function (request: string, ...args: any[]) {
  return request === "server-only" ? {} : original.call(this, request, ...args);
};
async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 100000) throw new Error("Research input too large.");
  }
  const a = JSON.parse(input),
    [
      { loadResearchData },
      { runDeskResearch },
      { validateResearchRequest },
      { saveDeskArtifact },
      { prisma },
      { marketDbMain, marketDbTest },
    ] = await Promise.all([
      import("../lib/desk/backtest/data"),
      import("../lib/desk/backtest/engine"),
      import("../lib/desk/backtest/request"),
      import("../lib/desk/artifacts"),
      import("../lib/db"),
      import("../lib/market-db"),
    ]);
  try {
    const { researchSourceHashes } = await import("../lib/desk/backtest/jobs");
    const current = await researchSourceHashes();
    if(a.healthCheck===true){
      await import("../lib/desk/backtest/candles");
      console.log("DESK_BACKTEST_RESULT="+JSON.stringify({health:"ready",sourceHashes:current}));
      return;
    }
    if (
      !a.sourceHashes ||
      Object.entries(current).some(
        ([name, hash]) => a.sourceHashes[name] !== hash,
      )
    )
      throw new Error(
        "Research source changed since submission. Submit a new run with the current engine.",
      );
    const request = validateResearchRequest(a.request, a.context.isTestnet);
    let result:unknown, dataArtifact:{artifactId:string};
    const signal = AbortSignal.timeout(110000);
    if(request.engine === "candles"){
      const {loadCandleResearch,runCandleResearch}=await import("../lib/desk/backtest/candles");
      let dataset:Awaited<ReturnType<typeof loadCandleResearch>>;
      if(a.datasetReference){
        const artifact=await prisma.deskArtifact.findFirst({where:{id:a.datasetReference.artifactId,bookId:a.context.bookId}});
        if(!artifact||artifact.sha256!==a.datasetReference.sha256)throw new Error("Frozen reused dataset identity changed or unavailable.");
        const {decodeDeskArtifact}=await import("../lib/desk/artifacts");dataset=decodeDeskArtifact(artifact);dataArtifact={artifactId:artifact.id};
      }else{
        dataset=await loadCandleResearch(request,a.context.isTestnet,a.instruments,signal);
        dataArtifact=await saveDeskArtifact(prisma,a.context.bookId,"research_candle_dataset",dataset);
      }
      result=runCandleResearch(dataset,a.context,request);
    }else{
      const { researchWindows, runResearchCampaign } = await import("../lib/desk/backtest/campaign");
      const datasets = [], artifacts = [];
      for (const window of researchWindows(request)) {
        signal.throwIfAborted();
        const dataset = await loadResearchData(window, a.context.isTestnet, a.instruments, signal);
        datasets.push(dataset);
        artifacts.push(await saveDeskArtifact(prisma, a.context.bookId, "research_dataset", dataset));
      }
      dataArtifact = artifacts.length === 1 ? artifacts[0] : await saveDeskArtifact(prisma,a.context.bookId,"research_dataset_manifest", { windows:researchWindows(request).map((w,i)=>({start:w.start,end:w.end,...artifacts[i]})) });
      result = request.additionalWindows ? runResearchCampaign(datasets, a.context, request) : runDeskResearch(datasets[0], a.context, request);
    }
    const resultArtifact = await saveDeskArtifact(
      prisma,
      a.context.bookId,
      "research_result",
      result,
    );
    console.log(
      "DESK_BACKTEST_RESULT=" +
        JSON.stringify({
          datasetArtifactId: dataArtifact.artifactId,
          resultArtifactId: resultArtifact.artifactId,
        }),
    );
  } finally {
    await Promise.all([
      prisma.$disconnect(),
      marketDbMain.$disconnect(),
      marketDbTest.$disconnect(),
    ]);
  }
}
main().catch((e) => {
  console.log(
    "DESK_BACKTEST_RESULT=" +
      JSON.stringify({
        error: e instanceof Error ? e.message : "Research failed.",
      }),
  );
  process.exitCode = 1;
});
