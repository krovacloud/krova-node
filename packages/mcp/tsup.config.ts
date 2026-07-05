import { defineConfig } from "tsup";

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
});
