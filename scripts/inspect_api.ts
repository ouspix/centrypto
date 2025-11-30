import { getMetaAndAssetCtxs } from "@/lib/hyperliquid";

async function main() {
    const data = await getMetaAndAssetCtxs(false);
    if (data && data.assetCtxs.length > 0) {
        console.log("Keys in assetCtx:", Object.keys(data.assetCtxs[0]));
        console.log("Sample assetCtx:", data.assetCtxs[0]);
    }
}

main().catch(console.error);
