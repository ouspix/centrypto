import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./__tests__/setup.ts'],
        include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
        // Historical parity requires an explicitly configured database and dataset.
        // Run it separately with npm run test:market-parity; its assertions are unchanged.
        exclude: [...configDefaults.exclude, 'rsshub-selfhost/**', '__tests__/MainnetScreenerSimulation.test.ts'],
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './'),
            'server-only': path.resolve(__dirname, './__tests__/server-only.ts'),
        },
    },
})
