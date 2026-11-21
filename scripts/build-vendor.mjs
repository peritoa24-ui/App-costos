// Empaqueta las librerías de terceros en /vendor para que la app funcione
// sin CDN y sin conexión (PWA). Correr con: npm run vendor
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("vendor", { recursive: true });

await build({
  stdin: { contents: 'export { default as Anthropic } from "@anthropic-ai/sdk";', resolveDir: "." },
  bundle: true, format: "esm", platform: "browser", minify: true,
  outfile: "vendor/anthropic.js",
});

await build({
  stdin: { contents: 'export { BarcodeDetector, prepareZXingModule } from "barcode-detector/ponyfill";', resolveDir: "." },
  bundle: true, format: "esm", platform: "browser", minify: true,
  outfile: "vendor/barcode-detector.js",
});

copyFileSync("node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", "vendor/zxing_reader.wasm");
copyFileSync("node_modules/chart.js/dist/chart.umd.js", "vendor/chart.umd.js");
console.log("vendor listo");
