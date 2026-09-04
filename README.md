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

## Por qué el reloj NO es el cron de GitHub

El workflow tiene su `schedule`, pero Actions lo cumple cuando quiere. El
04/09/2026, con el workflow activo y sano, GitHub lanzó **4 corridas en 16 horas**
en vez de las ~50 que pedía el cron, y uno de esos disparos llegó **4 horas tarde**
(07:53 UTC, fuera de las dos ventanas configuradas). En repos públicos del plan
gratis, los horarios de intervalo corto son lo primero que GitHub descarta cuando
su cola va cargada. No se reactiva ni se arregla desde el repo.

Así que el reloj vive afuera: el trigger `atlas/dispararVacantes.js` le pega al
API de GitHub cada 20 minutos. Las corridas por `workflow_dispatch` **no** pasan
por esa cola de horarios: se lanzan de una. El `schedule` del workflow se dejó
puesto como red por si Atlas se cae — con suerte agrega unas pocas corridas, y el
`concurrency` del workflow evita que dos se pisen.

## Las tres patas

Cada pieza vive en una infraestructura distinta, a propósito:

| Pata | Dónde | Qué hace |
|---|---|---|
| El reloj | Atlas | dispara el workflow cada 20 min |
| El trabajo | GitHub Actions | abre el sitio del MEP con Chromium |
| La alarma | la VM de Oracle | mira que el trabajo esté ocurriendo |

Antes el reloj y la alarma estaban los dos en Atlas, y eso lo volvía un punto
único de fallo: si Atlas se caía, se caían a la vez el que dispara y el que
avisa, y nadie se enteraba. Con la alarma en la VM, si se cae cualquiera de las
tres, otra se da cuenta. El trigger de Atlas se puede dejar como segunda alarma
o borrar: los dos hacen el mismo chequeo.

## Archivos

- `explorar.mjs` — herramienta de diagnóstico: abre la app y guarda en `salida/`
  la captura, el texto, el HTML ya dibujado y la estructura de controles.
- `.github/workflows/explorar.yml` — corre el explorador a mano y hace commit de
  los resultados.
- `atlas/dispararVacantes.js` — el reloj. Trigger de Atlas, cada 20 min, dispara
  el workflow por `workflow_dispatch`.
- `atlas/watchdogVacantes.js` — la alarma. Trigger de Atlas, cada hora, avisa por
  WhatsApp si el último commit del repo tiene más de 3 horas (o sea: el vigilante
  no está corriendo, o el disparador dejó de disparar).
- `vm/vacantes-watchdog.sh` — la misma alarma, pero por cron en la VM de Oracle.
  Avisa por WhatsApp y, si WAHA está caído, por correo con Resend. Ver "Las tres
  patas" arriba.

## Cómo funciona

Cada 20 minutos (de 5:00 a 22:00 hora de Costa Rica) un trigger de Atlas dispara
el workflow, que abre la app del MEP con Chromium, recorre el menú de direcciones
regionales y lee la tabla de cada una. Se queda con las vacantes cuya especialidad
calza con VT6 y manda un WhatsApp con las que no se hayan avisado antes.

- **✅ calce exacto** — la especialidad es una de las 13 de la constancia.
- **🔎 posible** — habla de informática pero no es idéntica a ninguna de las 13.
  Se avisa igual: perderse una vacante cuesta más que un aviso de más.
- **excluida** — suena a informática pero no se puede dar con esta constancia.
  Hoy: **Informática Educativa** (I y II ciclos, y III y IV). Es otro grupo
  profesional. Se anota en el catálogo pero nunca se avisa: un aviso al que no se
  puede aplicar es peor que ninguno, porque enseña a ignorar los mensajes.

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

Y dos triggers en MongoDB Atlas (Scheduled, Authentication: System), cada uno con
su secreto pegado a mano en el panel:

| Trigger | Cron (UTC) | Necesita |
|---|---|---|
| `dispararVacantes` | `*/20 0-3,11-23 * * *` | PAT de GitHub, fine-grained, solo este repo, permiso **Actions: Read and write** |
| `watchdogVacantes` | `0 * * * *` | la API key de WAHA |

El watchdog empieza a vigilar a las **6:00** CR, no a las 5:00: entre las 21:40 y
las 5:00 hay 7h20 de silencio que son normales, y revisando a las 5:00 en punto
se vería ese hueco como una caída. A las 6 el disparador ya lleva tres corridas.

Las copias con los secretos ya puestos van en `atlas/*LISTO-NO-SUBIR*`, que las
ignora `.gitignore`.

## Qué NO cubre

El MEP publica por **dos canales distintos**, y esto vigila uno solo:

| Canal | Qué lleva | ¿Se vigila? |
|---|---|---|
| App `apps.mep.go.cr/formulario` | Vacantes de más de 35 días, todas las regionales | **Sí** |
| Hojas de cada regional | Suplencias de **menos de 35 días** | No |

Comprobado el 03/09/2026: ese día la app mostraba **1** vacante para Alajuela
(Religión, del 7/9 al 11/12) y la hoja de la DREA tenía **9** distintas, todas
con fecha límite del mismo día. No es un error de lectura: son cosas distintas.

Se dejó fuera a propósito. Si algún día hacen falta, la hoja de Alajuela se lee
como CSV y sería una segunda fuente sencilla:

```
https://docs.google.com/spreadsheets/d/e/2PACX-1vRJe_uT8v9Cd9WlRGf10ArtZmpGwkEUiPcpmA9F7NHrNW9Iy0_7G-sJUYxSlb8zkl6Q3T_suWKGeDf_/pub?gid=821349536&single=true&output=csv
```

Sale del iframe incrustado en `drea.mep.go.cr/vacantes`. De las demás regionales
no se sabe: sus dominios `dre*.mep.go.cr` ya no existen y habría que descubrir
una por una si publican en algún lado.
