import { defineConfig } from "vitest/config";

// plugin/tests run under `claude plugin test`, not vitest.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
