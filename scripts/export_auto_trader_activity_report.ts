import { writeFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { buildAutoTraderActivityReport } from "@/lib/auto-trader-activity-report";

async function main() {
    const settings = await (prisma as any).autoTraderSettings?.findFirst({
        orderBy: { updatedAt: "desc" }
    });
    const latestSnapshot = await (prisma as any).marketStateSnapshot?.findFirst({
        orderBy: { createdAt: "desc" }
    });

    const report = buildAutoTraderActivityReport({
        settingsConfig: settings?.config,
        latestSnapshotData: latestSnapshot?.data
    });
    const outPath = path.join(
        process.cwd(),
        "reports",
        `auto-trader-activity-${new Date().toISOString().slice(0, 10)}.md`
    );

    await writeFile(outPath, report, "utf8");
    console.log(outPath);
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect?.();
    });
