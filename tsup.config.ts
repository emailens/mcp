import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  target: "node18",
  banner: {
    js: "#!/usr/bin/env node",
  },
});
