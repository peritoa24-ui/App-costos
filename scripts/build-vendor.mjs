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
// Lector de texto gratuito (Tesseract), funciona en el teléfono sin internet
mkdirSync("vendor/tesseract/core", { recursive: true });
mkdirSync("vendor/tesseract/lang", { recursive: true });
copyFileSync("node_modules/tesseract.js/dist/tesseract.esm.min.js", "vendor/tesseract/tesseract.esm.min.js");
copyFileSync("node_modules/tesseract.js/dist/worker.min.js", "vendor/tesseract/worker.min.js");
for (const v of ["lstm", "simd-lstm", "relaxedsimd-lstm"]) {
  copyFileSync(`node_modules/tesseract.js-core/tesseract-core-${v}.wasm.js`, `vendor/tesseract/core/tesseract-core-${v}.wasm.js`);
}
copyFileSync("node_modules/@tesseract.js-data/spa/4.0.0_best_int/spa.traineddata.gz", "vendor/tesseract/lang/spa.traineddata.gz");
console.log("vendor listo");
