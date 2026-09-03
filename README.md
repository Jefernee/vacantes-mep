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
