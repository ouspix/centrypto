import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
export default defineConfig({
    plugins: [react()],
    test: { environment: "jsdom", globals: true, setupFiles: ["./__tests__/setup.ts"], include: ["__tests__/MainnetScreenerSimulation.test.ts"], testTimeout: 120000 },
    resolve: { alias: { "@": path.resolve(__dirname, "./"), "server-only": path.resolve(__dirname, "./__tests__/server-only.ts") } }
});
