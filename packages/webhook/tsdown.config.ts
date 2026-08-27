import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: "node18",
  outDir: "dist",
  // See the note in packages/sdk/tsdown.config.ts — this keeps the artefact
  // names the published `exports` map already points at.
  fixedExtension: false,
});
