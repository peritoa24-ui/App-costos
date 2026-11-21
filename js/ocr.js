// Lectura del ticket con IA (Claude). La API key la carga el usuario en Ajustes
// y se guarda solo en este dispositivo.
import { Anthropic } from "../vendor/anthropic.js";

const MODEL = "claude-opus-5-5";

const TICKET_SCHEMA = {
  type: "object",
  properties: {
    store: { type: "string", description: "Nombre del comercio / supermercado" },
    date: { type: "string", description: "Fecha de la compra en formato YYYY-MM-DD, o vacío si no se lee" },
    total: { type: "number", description: "Total final pagado" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string", description: "Descripción tal cual figura en el ticket" },
          quantity: { type: "number", description: "Cantidad de unidades (o kg si es pesable)" },
          unit_price: { type: "number", description: "Precio unitario final, con descuentos de esa línea aplicados" },
          line_total: { type: "number", description: "Importe total de la línea" },
          ean: { type: "string", description: "Código de barras si figura impreso en la línea, si no vacío" },
        },
        required: ["description", "quantity", "unit_price", "line_total", "ean"],
        additionalProperties: false,
      },
    },
  },
  required: ["store", "date", "total", "items"],
  additionalProperties: false,
};

const PROMPT = `Esta es la foto de un ticket de compra de un supermercado de Argentina.
Extraé cada producto comprado como un ítem. Reglas:
- Los importes usan coma decimal y punto de miles (ej: "1.234,50" = 1234.50). Devolvé números.
- Si una línea tiene descuento o promoción (ej: "DTO", "2x1", "BONIF"), aplicalo al producto correspondiente en unit_price y line_total en lugar de crear un ítem aparte.
- Para productos pesables, quantity son los kg y unit_price el precio por kg.
- No incluyas subtotales, IVA, medios de pago, vuelto ni bolsas si no tienen precio.
- Si no se puede leer un dato, usá "" o 0.`;

export function getApiKey() {
  try { return localStorage.getItem("anthropic_api_key") || ""; } catch { return ""; }
}
export function setApiKey(k) {
  try { localStorage.setItem("anthropic_api_key", k.trim()); } catch {}
}

// Reduce la foto para que el envío sea rápido y barato.
export async function fileToJpegBase64(file, maxSide = 1800) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return dataUrl.split(",")[1];
}

export async function readTicket(file) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Falta la API key. Cargala en Ajustes.");
  const data = await fileToJpegBase64(file);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: TICKET_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("La API key no es válida.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Demasiados pedidos seguidos. Probá en un minuto.");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Sin conexión. Revisá internet.");
    if (err instanceof Anthropic.APIError) throw new Error(`Error de la IA (${err.status}): ${err.message}`);
    throw err;
  }

  if (response.stop_reason === "refusal") throw new Error("La IA no pudo procesar esta imagen.");
  if (response.stop_reason === "max_tokens") throw new Error("El ticket es demasiado largo para leerlo de una vez.");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(text);
  return {
    store: parsed.store || "",
    date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : new Date().toISOString().slice(0, 10),
    total: Number(parsed.total) || 0,
    items: parsed.items.map((it) => ({
      description: it.description,
      quantity: Number(it.quantity) || 1,
      unitPrice: Number(it.unit_price) || 0,
      lineTotal: Number(it.line_total) || 0,
      ean: (it.ean || "").replace(/\D/g, "") || null,
    })),
  };
}
