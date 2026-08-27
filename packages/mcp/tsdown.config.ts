import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  // Prepend the shebang so the built bin is directly executable.
  banner: {
    js: "#!/usr/bin/env node",
  },
  // `bin.krova-mcp`, `main`, `types` and the `exports` map all point at
  // ./dist/index.js and ./dist/index.d.ts; keep tsdown emitting those names.
  fixedExtension: false,
});
