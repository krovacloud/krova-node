import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: false,
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  // `bin.krova` points at ./dist/index.js; without this tsdown emits
  // index.mjs and the published binary resolves to nothing.
  fixedExtension: false,
});
