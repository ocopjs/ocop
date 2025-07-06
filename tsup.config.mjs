import { defineConfig } from "tsup";

export default defineConfig({
  entryPoints: ["src"],
  format: ["cjs"],
  dts: false,
  loader: {
    '.html': 'text'
  }
});
