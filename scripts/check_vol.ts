import { getMetaAndAssetCtxs } from "@/lib/hyperliquid";

async function checkVolChange() {
    console.log("Fetching meta 1...");
    const meta1 = await getMetaAndAssetCtxs(false);
    if (!meta1) return;

    const btc1 = meta1.assetCtxs.find((c: any) => c.dayNtlVlm > 1000000000); // Find a high vol asset (BTC)
    const btcIdx = meta1.assetCtxs.indexOf(btc1);
    const btcName = meta1.universe[btcIdx].name;

    console.log(`Asset: ${btcName}, Vol1: ${btc1.dayNtlVlm}`);

    console.log("Waiting 60s...");
    await new Promise(r => setTimeout(r, 60000));

    console.log("Fetching meta 2...");
    const meta2 = await getMetaAndAssetCtxs(false);
    if (!meta2) return;

    const btc2 = meta2.assetCtxs[btcIdx];
    console.log(`Asset: ${btcName}, Vol2: ${btc2.dayNtlVlm}`);

    const diff = parseFloat(btc2.dayNtlVlm) - parseFloat(btc1.dayNtlVlm);
    console.log(`Diff: ${diff}`);
}

checkVolChange().catch(console.error);
