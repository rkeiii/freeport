import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  // Multipart copier tests move 12-23 MiB through workerd; slow on CI runners.
  test: { testTimeout: 30_000 },
});
