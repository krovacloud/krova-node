import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  outDir: "dist",
  // ⛔ Keep tsup's filenames. tsdown defaults `fixedExtension` to true whenever
  // `platform` is node, which emits `index.mjs` / `index.d.mts`. Every consumer
  // resolves through the `exports` map in package.json, which points at
  // `./dist/index.js` and `./dist/index.d.ts` — renaming the artefacts would
  // break every installed copy of this package. With `"type": "module"` set,
  // `false` gives ESM `.js` + CJS `.cjs`, exactly as tsup did.
  fixedExtension: false,
});
