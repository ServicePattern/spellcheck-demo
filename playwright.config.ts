import { defineConfig } from '@playwright/test';

const PORT = 5191;

export default defineConfig({
  testDir: '.',
  testMatch: ['src/**/*.spec.ts', 'tools/**/*.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    channel: process.env.CI ? undefined : 'chrome',
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
