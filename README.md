# Vigilante de vacantes del MEP

Avisa por WhatsApp cuando el MEP publica una vacante que calza con el **grupo
profesional VT6** (informática y sus talleres).

## Por qué existe

El MEP deja cada vacante publicada **24 horas hábiles**. Revisar el sitio a mano
varias veces al día no es viable, y si te la perdés, se fue.

## Por qué necesita un navegador

Las vacantes de todas las regionales están en `apps.mep.go.cr/formulario`, que es
una app **Blazor Server**: el HTML que manda el servidor son 4 KB de cascarón
vacío y la lista se dibuja en vivo por WebSocket. Un `curl` no ve nada. Por eso
esto usa Playwright con Chromium.

La única regional que además publica en formato legible sin navegador es Alajuela
(una hoja de Google incrustada en `drea.mep.go.cr/vacantes`). Los demás dominios
`dre*.mep.go.cr` ya no existen: el MEP los consolidó en esa app.

## Por qué corre en GitHub Actions

Hace falta un lugar encendido 24/7 con memoria para un navegador. La VM que tiene
WAHA es una Oracle E2.1.Micro de **1 GB** y su motor se eligió expresamente por no
traer Chromium — meterle uno ahí puede tumbar el WhatsApp de la sala. Actions es
gratis e ilimitado en repos públicos.

## Archivos

- `explorar.mjs` — herramienta de diagnóstico: abre la app y guarda en `salida/`
  la captura, el texto, el HTML ya dibujado y la estructura de controles.
- `.github/workflows/explorar.yml` — corre el explorador a mano y hace commit de
  los resultados.

## Cómo funciona

Cada 20 minutos (de 5:00 a 22:00 hora de Costa Rica) GitHub Actions abre la app
del MEP con Chromium, recorre el menú de direcciones regionales y lee la tabla de
cada una. Se queda con las vacantes cuya especialidad calza con VT6 y manda un
WhatsApp con las que no se hayan avisado antes.

- **✅ calce exacto** — la especialidad es una de las 13 de la constancia.
- **🔎 posible** — habla de informática pero no es idéntica (por ejemplo
  "Informática Educativa. Informática Para I Y Ii Ciclos", que es de I y II
  ciclos). Se avisa igual: perderse una vacante cuesta más que un aviso de más.

Las especialidades se comparan **palabra por palabra**, sin las de relleno. El MEP
publica "Informática En Desarrollo *Del* Software" y la constancia dice "*De*
Software": comparando el texto completo, esa palabra sola hacía fallar el calce.

### Lo que evita fallar en silencio

- El pie de la tabla declara cuántas vacantes hay ("1-10 de 23"). Si se leyeron
  menos, queda una advertencia en `salida/vacantes.json`.
- Si Blazor muestra su cartel de error, se detecta, se recarga y se sigue. Sin
  eso, las regionales que faltaran darían cero y parecería que no hay vacantes.
- El estado solo se marca si el WhatsApp salió: un fallo de envío se reintenta.

## Correrlo a mano

```bash
gh workflow run vigilar.yml -f modo=prueba   # lee y guarda, no manda WhatsApp
gh workflow run vigilar.yml -f modo=real     # manda de verdad
```

## Configuración

Tres Secrets en GitHub: `WAHA_URL`, `WAHA_API_KEY` y `WAHA_CHAT_ID`. El envío lo
hace la API de WAHA en la VM de Oracle, la misma que usa la sala de juegos.
