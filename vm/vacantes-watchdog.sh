#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Vigilante (watchdog) DEL VIGILANTE DE VACANTES, versión para la VM.
#
# EL PROBLEMA QUE RESUELVE:
#   El vigilante de vacantes avisa por WhatsApp cuando falla, pero eso solo
#   sirve si LLEGA A CORRER. Si nadie lo dispara no falla nada: simplemente
#   deja de pasar, y "no pasa nada" es exactamente lo que uno espera cuando no
#   hay vacantes. Podrían pasar semanas sin que nadie lo note.
#
# POR QUÉ ACÁ Y NO SOLO EN ATLAS:
#   Ya existe este mismo chequeo como trigger de Atlas (atlas/watchdogVacantes.js).
#   El problema es que desde el 04/09/2026 el RELOJ del vigilante también vive en
#   Atlas (atlas/dispararVacantes.js), así que Atlas quedó como punto único de
#   fallo: si se cae, se cae el reloj Y la alarma a la vez, y nadie se enteraría.
#   Corriendo acá quedan tres patas independientes:
#
#     el reloj   -> Atlas       (dispara el workflow cada 20 min)
#     el trabajo -> GitHub      (abre el sitio del MEP con Chromium)
#     la alarma  -> esta VM     (mira que el trabajo esté ocurriendo)
#
#   Si se cae cualquiera de las tres, otra se da cuenta.
#
# CÓMO SE DA CUENTA:
#   Cada corrida del vigilante hace un commit al guardar su estado. Si el último
#   commit del repo es viejo, dejó de correr. El repo es público, así que esto NO
#   necesita ningún token de GitHub. Es el mismo truco del trigger de Atlas.
#
# LO QUE DETECTA (que es más de lo que parece):
#   - Atlas caído, o el trigger dispararVacantes suspendido por errores.
#   - El PAT de GitHub vencido o revocado (el disparo devuelve 401 y no corre).
#   - GitHub Actions caído o con la cola trancada.
#   - El workflow desactivado a mano, o borrado.
#   Todos tienen el mismo síntoma: dejan de aparecer commits.
#
# POR QUÉ EMPIEZA A LAS 6 Y NO A LAS 5:
#   El vigilante trabaja de 5:00 a 22:00 CR, así que entre las 21:40 y las 5:00
#   hay 7h20 de silencio que son PERFECTAMENTE NORMALES, muy por encima del
#   límite de 3 h. Revisando a las 5:00 en punto se ve ese hueco como una caída,
#   porque el primer disparo del día todavía no alcanzó a commitear: es una
#   carrera que el watchdog pierde, y sería una falsa alarma cada mañana. A las
#   6:00 el disparador ya lleva tres corridas hechas. Se paga con detectar una
#   caída de las 5 a.m. una hora tarde, que es un precio baratísimo.
#
# POR QUÉ WHATSAPP Y ADEMÁS CORREO:
#   WhatsApp es lo que se lee, así que va primero, y de paso sale por
#   127.0.0.1: no cruza internet. Pero si el que está caído es WAHA, ese aviso
#   no sale, y una alarma que no puede avisar no es una alarma. Entonces si el
#   WhatsApp falla, se manda por correo con Resend. La versión de Atlas solo
#   tenía WhatsApp; esta tiene las dos.
#
# INSTALACIÓN (en la VM de Oracle, una sola vez):
#   El repo es público, así que se baja directo en vez de pegarlo a mano. Es
#   mejor: al pegar en nano las líneas largas se parten y rompen las comillas.
#
#     sudo mkdir -p /opt/vacantes
#     sudo curl -fsSL -o /opt/vacantes/watchdog.sh \
#       https://raw.githubusercontent.com/Jefernee/vacantes-mep/main/vm/vacantes-watchdog.sh
#     sudo chmod +x /opt/vacantes/watchdog.sh
#     bash -n /opt/vacantes/watchdog.sh && echo "se bajó completo"
#
#   Para actualizarlo después de cambiarlo en el repo, se repite el curl.
#
#   NO hace falta crear secretos nuevos: reusa /opt/waha/watchdog.env, que ya
#   tiene WAHA_API_KEY, RESEND_API_KEY y ALERTAS_EMAIL_TO del watchdog de WAHA.
#   Lo único que conviene agregarle ahí es el destino de WhatsApp:
#
#     sudo nano /opt/waha/watchdog.env
#     # agregar al final la línea:
#     VACANTES_CHAT_ID=50686825481@c.us
#
#   (Si no la agregás, usa ese mismo número por defecto.)
#
#   Cron cada 15 minutos:
#     sudo crontab -e
#     */15 * * * * /opt/vacantes/watchdog.sh >> /var/log/vacantes-watchdog.log 2>&1
#
#   Cada 15 min y no cada 5: la API de GitHub sin token permite 60 consultas por
#   hora POR IP, y esta VM ya la usa para otras cosas. Con un límite de alarma de
#   3 horas, revisar 4 veces por hora es de sobra.
#
# PROBARLO A MANO:
#   sudo /opt/vacantes/watchdog.sh ; echo "salida: $?"
#   # Para ver que la alarma SÍ dispara, sin esperar a que se caiga de verdad:
#   sudo LIMITE_HORAS=0 /opt/vacantes/watchdog.sh
#   sudo tail -f /var/log/vacantes-watchdog.log
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

# ── Configuración ────────────────────────────────────────────────────────────
DUENO="${DUENO:-Jefernee}"
REPO="${REPO:-vacantes-mep}"

LIMITE_HORAS="${LIMITE_HORAS:-3}"   # horas de silencio que se consideran caída
HORA_INICIO="${HORA_INICIO:-6}"     # ver "POR QUÉ EMPIEZA A LAS 6" arriba
HORA_FIN="${HORA_FIN:-22}"

# Rutas por defecto (se pueden sobreescribir por entorno para poder probar).
ENV_FILE="${WATCHDOG_ENV_FILE:-/opt/waha/watchdog.env}"
ESTADO_FILE="${VACANTES_ESTADO_FILE:-/var/tmp/vacantes-watchdog.estado}"

# WAHA es local: no sale a internet y vuelve.
WAHA_URL="${WAHA_URL:-http://127.0.0.1:3000}"
WAHA_SESSION="${WAHA_SESSION:-default}"

AVISO_COOLDOWN_SEG=43200   # 12 h entre avisos, no uno cada 15 min
CURL_TIMEOUT=20

ALERTAS_EMAIL_FROM="${ALERTAS_EMAIL_FROM:-Sala de Juegos <onboarding@resend.dev>}"

SITIO="https://apps.mep.go.cr/formulario"
# ─────────────────────────────────────────────────────────────────────────────

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Las keys viven fuera del script (el repo es público).
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

# El número ya está público en atlas/watchdogVacantes.js, así que como respaldo
# no revela nada nuevo; igual se prefiere el del env file.
CHAT_ID="${VACANTES_CHAT_ID:-50686825481@c.us}"

# ── Hora de Costa Rica, sin depender del reloj de la VM ──────────────────────
# La VM de Oracle viene en UTC y eso puede cambiar con cualquier reinstalación.
# Costa Rica es UTC-6 todo el año (no hay horario de verano), así que la hora
# local se calcula y no se pregunta.
HORA_UTC=$(( 10#$(date -u '+%H') ))
HORA_CR=$(( (HORA_UTC + 24 - 6) % 24 ))

if [ "$HORA_CR" -lt "$HORA_INICIO" ] || [ "$HORA_CR" -ge "$HORA_FIN" ]; then
  log "Fuera de horario (${HORA_CR}h CR). Nada que revisar."
  exit 0
fi

# ── Estado persistido ────────────────────────────────────────────────────────
# Formato: "<epoch_ultimo_aviso> <en_alarma 0|1>"
ULTIMO_AVISO=0
EN_ALARMA=0
if [ -f "$ESTADO_FILE" ]; then
  read -r ULTIMO_AVISO EN_ALARMA < "$ESTADO_FILE" 2>/dev/null || true
  case "$ULTIMO_AVISO" in (*[!0-9]*|"") ULTIMO_AVISO=0 ;; esac
  case "$EN_ALARMA"    in (*[!0-9]*|"") EN_ALARMA=0 ;; esac
fi

guardar_estado() { echo "$1 $2" > "$ESTADO_FILE"; }

# ── Avisos ───────────────────────────────────────────────────────────────────
# WhatsApp primero (es lo que se lee). Devuelve 0 si salió.
enviar_whatsapp() {
  texto="$1"
  if [ -z "${WAHA_API_KEY:-}" ]; then
    log "Sin WAHA_API_KEY (esperada en $ENV_FILE): no se intenta WhatsApp."
    return 1
  fi

  # El texto va dentro de un JSON: hay que escapar barras, comillas y saltos.
  texto_json=$(printf '%s' "$texto" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | awk '{ printf "%s\\n", $0 }')

  CODIGO=$(curl -s -o /dev/null -w '%{http_code}' -m "$CURL_TIMEOUT" -X POST \
    -H "X-Api-Key: $WAHA_API_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"session\":\"$WAHA_SESSION\",\"chatId\":\"$CHAT_ID\",\"text\":\"$texto_json\"}" \
    "$WAHA_URL/api/sendText" 2>/dev/null) || CODIGO="000"

  if [ "$CODIGO" -ge 200 ] 2>/dev/null && [ "$CODIGO" -lt 300 ] 2>/dev/null; then
    log "WhatsApp enviado a $CHAT_ID."
    return 0
  fi
  log "ERROR: WAHA respondió HTTP $CODIGO. Se intenta por correo."
  return 1
}

# Correo como respaldo, por si el caído es WAHA.
enviar_correo() {
  asunto="$1"; cuerpo="$2"

  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ALERTAS_EMAIL_TO:-}" ]; then
    log "Correo no configurado: no hay respaldo para este aviso."
    return 1
  fi

  cuerpo_json=$(printf '%s' "$cuerpo" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | awk '{ printf "%s\\n", $0 }')

  CODIGO=$(curl -s -o /dev/null -w '%{http_code}' -m "$CURL_TIMEOUT" -X POST \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"from\":\"$ALERTAS_EMAIL_FROM\",\"to\":[\"$ALERTAS_EMAIL_TO\"],\"subject\":\"$asunto\",\"text\":\"$cuerpo_json\"}" \
    "https://api.resend.com/emails" 2>/dev/null) || CODIGO="000"

  if [ "$CODIGO" -ge 200 ] 2>/dev/null && [ "$CODIGO" -lt 300 ] 2>/dev/null; then
    log "Correo enviado a $ALERTAS_EMAIL_TO."
    return 0
  fi
  log "ERROR: Resend respondió HTTP $CODIGO. El aviso NO salió por ningún lado."
  return 1
}

# avisar <asunto> <texto>: WhatsApp, y si no sale, correo.
avisar() {
  if enviar_whatsapp "$2"; then return 0; fi
  enviar_correo "$1" "$2"
}

# ── Consultar el último commit del repo ──────────────────────────────────────
API="https://api.github.com/repos/$DUENO/$REPO/commits?per_page=1"

RESPUESTA=$(curl -s -m "$CURL_TIMEOUT" \
  -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: vacantes-watchdog' \
  "$API" 2>/dev/null) || RESPUESTA=""

# Sin jq: sacamos la fecha con grep (jq puede no estar instalado). La primera
# fecha de la respuesta es la del autor, que en los commits del bot es la misma
# que la del committer, así que sirve igual.
FECHA=$(printf '%s' "$RESPUESTA" \
  | grep -o '"date":"[0-9T:Z-]*"' | head -1 | cut -d'"' -f4)

if [ -z "$FECHA" ]; then
  # Falla de red de la VM, o GitHub devolviendo error o rate limit. NO es una
  # caída del vigilante, así que no se avisa: avisar acá sería mentir.
  log "No se pudo consultar GitHub (respuesta: '${RESPUESTA:0:120}'). No se avisa."
  exit 0
fi

EPOCH_COMMIT=$(date -d "$FECHA" +%s 2>/dev/null) || EPOCH_COMMIT=""
if [ -z "$EPOCH_COMMIT" ]; then
  log "No se pudo interpretar la fecha '$FECHA'. No se avisa."
  exit 0
fi

AHORA=$(date +%s)
SEGUNDOS=$(( AHORA - EPOCH_COMMIT ))
MINUTOS=$(( SEGUNDOS / 60 ))
HORAS=$(( SEGUNDOS / 3600 ))
LIMITE_SEG=$(( LIMITE_HORAS * 3600 ))

log "Último commit hace ${HORAS}h (${MINUTOS} min). Límite: ${LIMITE_HORAS}h."

# ── Caso feliz ───────────────────────────────────────────────────────────────
if [ "$SEGUNDOS" -lt "$LIMITE_SEG" ]; then
  if [ "$EN_ALARMA" -eq 1 ]; then
    # Veníamos de avisar que estaba caído: hay que cerrar el asunto, o queda la
    # duda de si sigue muerto.
    log "OK: el vigilante volvió a correr. Se avisa la recuperación."
    avisar "El vigilante de vacantes volvió" \
"*El vigilante de vacantes volvió a correr*

Ya está revisando el sitio del MEP otra vez. El último commit es de hace ${MINUTOS} minutos.

No hay que hacer nada."
    guardar_estado "$ULTIMO_AVISO" 0
  fi
  exit 0
fi

# ── Está caído ───────────────────────────────────────────────────────────────
DESDE_AVISO=$(( AHORA - ULTIMO_AVISO ))
if [ "$EN_ALARMA" -eq 1 ] && [ "$DESDE_AVISO" -lt "$AVISO_COOLDOWN_SEG" ]; then
  log "Sigue caído (${HORAS}h), pero ya se avisó hace ${DESDE_AVISO}s. No se repite."
  exit 0
fi

log "CAÍDO: ${HORAS}h sin commits. Avisando."

avisar "El vigilante de vacantes dejó de correr" \
"*El vigilante de vacantes dejó de correr*

Lleva ${HORAS} horas sin dar señales. Debería revisar cada 20 minutos.

*No te está avisando de vacantes nuevas.*
Revisa el sitio a mano:
$SITIO

Qué mirar, en este orden:

1. El trigger dispararVacantes en el panel de Atlas. Atlas lo suspende solo si su función falla varias veces seguidas, y ahí Atlas se ve perfecto.
2. El PAT de GitHub de ese trigger. Si venció, el disparo devuelve 401.
3. Las corridas del workflow:
https://github.com/$DUENO/$REPO/actions

Este aviso lo manda el watchdog de la VM, que es el único que no depende ni de Atlas ni de GitHub."

guardar_estado "$AHORA" 1
exit 0
