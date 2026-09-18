import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    alias: {
      "@zhizhang/contracts": path.resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@zhizhang/model-protocol": path.resolve(__dirname, "../../packages/model-protocol/src/index.ts"),
    },
  },
});
