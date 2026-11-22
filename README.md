# Mis Costos

**Abrir la app:** https://peritoa24-ui.github.io/App-costos/

App para el celular (PWA) que registra tus compras de supermercado, las valida con los códigos de barra y proyecta cuánto vas a gastar.

## Qué hace

1. **Foto del ticket**: la app lee el comercio, la fecha, el total y cada producto con su precio. Por defecto lo hace **gratis, dentro del teléfono** (Tesseract, sin internet). Opcionalmente, con una API key de Anthropic, usa la IA de Claude, que es más precisa. También se puede cargar a mano.
2. **Validación con códigos de barra**: escaneás cada producto con la cámara y lo asociás a su línea del ticket. La app aprende cómo figura cada producto en el ticket (por ejemplo, "LCH ENT LS 1L" es la leche La Serenísima) y en los próximos tickets lo reconoce sola.
3. **Historial de precios**: cada ticket actualiza el precio de cada producto, así ves cuánto subió.
4. **Consumo**: escaneás un producto cuando lo abrís o lo terminás, y la app calcula cada cuánto lo consumís y cuánto te cuesta por mes.
5. **Resumen**: gasto por mes y por categoría, los productos en los que más gastás, los que más aumentaron, tu inflación personal y una proyección a 1, 3, 6 o 12 meses.

Los datos se guardan **en el teléfono** (IndexedDB). Desde Ajustes podés exportar e importar una copia de seguridad.

## Cómo usarla en el celular

La app es un sitio estático: se puede publicar en cualquier hosting con HTTPS, que es obligatorio para usar la cámara. Con GitHub Pages:

1. En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**. Elegí la rama y la carpeta `/ (root)`.
2. Abrí la dirección que te da GitHub (`https://<usuario>.github.io/App-costos/`) desde el celular.
3. En Chrome (Android): menú ⋮ → **Agregar a pantalla de inicio**. En Safari (iPhone): Compartir → **Agregar a inicio**.
4. Listo: la lectura gratis funciona sin configurar nada. Si querés la lectura con IA, en **Ajustes** cargá una API key de Anthropic (cuesta unos centavos de dólar por ticket).

## Para desarrollar

```bash
npm install        # solo hace falta para regenerar /vendor
npm run vendor     # empaqueta SDK de Anthropic, lector de códigos y Chart.js en /vendor
npm run serve      # http://localhost:8080
```

Estructura:

- `js/app.js`: pantallas y flujo
- `js/ocr-free.js`: lectura gratis en el teléfono (Tesseract) y reglas para interpretar tickets argentinos
- `js/ocr.js`: lectura opcional con Claude (salida JSON estructurada)
- `js/scanner.js`: cámara y lectura de códigos (nativo o ZXing en WebAssembly)
- `js/products.js`: catálogo, búsqueda en Open Food Facts y emparejamiento ticket ↔ código
- `js/stats.js`: cálculos del dashboard y proyección
- `js/db.js`: almacenamiento local
- `sw.js`, `manifest.webmanifest`: lo que la hace instalable y le permite abrir sin conexión

## Limitaciones de esta primera versión

- La lectura gratis es menos precisa que la IA: conviene revisar los productos después de cada foto.
- Si usás la IA, la API key queda guardada en el navegador del teléfono. Está bien para uso personal; para compartir la app con otras personas convendría un pequeño servidor intermedio.
- Los nombres de los productos vienen de Open Food Facts, que no tiene todos los productos argentinos. Si un producto no aparece, lo nombrás vos una sola vez.
- No hay sincronización entre dispositivos.
