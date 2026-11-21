// Escáner de códigos de barra con la cámara.
// Usa el BarcodeDetector nativo si existe (Chrome Android) y si no, ZXing en WebAssembly (iPhone, etc).
import { BarcodeDetector as Ponyfill, prepareZXingModule } from "../vendor/barcode-detector.js";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];

prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith(".wasm") ? new URL("../vendor/zxing_reader.wasm", import.meta.url).href : prefix + path,
  },
});

async function makeDetector() {
  if ("BarcodeDetector" in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (supported.includes("ean_13")) return new window.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
    } catch {}
  }
  return new Ponyfill({ formats: FORMATS });
}

// Abre la cámara dentro de `container` y llama a onCode(codigo) cada vez que lee uno nuevo.
// Devuelve una función para cerrarla.
export async function startScanner(container, onCode) {
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.muted = true;
  container.innerHTML = "";
  container.appendChild(video);
  const frame = document.createElement("div");
  frame.className = "scan-frame";
  container.appendChild(frame);

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  const detector = await makeDetector();

  let stopped = false;
  let last = "";
  let lastAt = 0;
  const loop = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2) {
        const codes = await detector.detect(video);
        const code = codes[0]?.rawValue;
        const now = Date.now();
        if (code && (code !== last || now - lastAt > 2500)) {
          last = code;
          lastAt = now;
          if (navigator.vibrate) navigator.vibrate(60);
          frame.classList.add("hit");
          setTimeout(() => frame.classList.remove("hit"), 300);
          onCode(code);
        }
      }
    } catch {}
    setTimeout(loop, 180);
  };
  loop();

  return () => {
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    container.innerHTML = "";
  };
}

// Valida el dígito verificador de EAN-13 / EAN-8 / UPC-A.
export function isValidEan(code) {
  if (!/^\d{8}$|^\d{12,13}$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
