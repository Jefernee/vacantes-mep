// atlas/watchdogVacantes.js
//
// Trigger de MongoDB Atlas que vigila AL VIGILANTE.
//
// ⚠️ Este archivo NO corre en GitHub. Se pega en el panel de Atlas
// (App Services → Triggers), igual que los del dólar y fin de sesión.
//
// POR QUÉ EXISTE:
//   El vigilante de vacantes avisa cuando falla, pero eso solo funciona si
//   LLEGA A CORRER. Si GitHub desactiva el horario (lo hace en repos sin
//   actividad), si Actions se cae, o si alguien apaga el workflow sin querer,
//   no falla nada: simplemente deja de pasar. Y "no pasa nada" es exactamente
//   lo que uno espera cuando no hay vacantes, así que podrían pasar semanas.
//
//   Por eso este vigilante vive en OTRO lado. Si estuviera en GitHub se caería
//   junto con lo que tiene que vigilar.
//
// CÓMO SE DA CUENTA:
//   Cada corrida del vigilante hace un commit en el repo (guarda el estado).
//   Así que si el último commit es viejo, es que dejó de correr. No hace falta
//   ni token ni permisos: el repo es público.
//
// CRON sugerido: "0 * * * *"  (una vez por hora)

// ── Configuración ─────────────────────────────────────────────────────────
// ⚠️ Reemplazar la API KEY por la real antes de guardar en el panel de Atlas.
const WAHA_URL = "http://157.151.183.29:3000";
const WAHA_API_KEY = "PEGA-AQUI-LA-API-KEY-DE-WAHA";
const WAHA_SESSION = "default";
const DESTINO = "50686825481@c.us";

const REPO = "Jefernee/vacantes-mep";

// Cuántas horas sin commits se consideran "está caído". El vigilante corre cada
// 20 minutos entre las 5 AM y las 10 PM, así que 3 horas de silencio en horario
// activo es señal segura. De noche no corre y el silencio es normal.
const HORAS_DE_SILENCIO = 3;
const HORA_INICIO_CR = 5;
const HORA_FIN_CR = 22;

const NOMBRES_DATA_SOURCE = ["Cluster0", "mongodb-atlas"];
const NOMBRE_DB = "salaDeJuegos";
// ──────────────────────────────────────────────────────────────────────────

exports = async function () {
  const AHORA = new Date();
  const horaCR = new Date(AHORA.getTime() - 6 * 60 * 60 * 1000).getUTCHours();

  // De madrugada el vigilante no corre: el silencio es esperado, no un fallo.
  if (horaCR < HORA_INICIO_CR || horaCR >= HORA_FIN_CR) {
    console.log("Fuera del horario activo (" + horaCR + "h CR). No se revisa.");
    return;
  }

  // ── Cuándo fue el último commit del repo ────────────────────────────────
  let ultimoCommit = null;
  try {
    const resp = await context.http.get({
      url: "https://api.github.com/repos/" + REPO + "/commits?per_page=1",
      headers: {
        "Accept": ["application/vnd.github+json"],
        "User-Agent": ["watchdog-vacantes"],
      },
    });
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      console.error("GitHub respondió " + resp.statusCode);
      return;
    }
    const datos = JSON.parse(resp.body.text());
    if (!datos.length) {
      console.error("El repo no devolvió commits.");
      return;
    }
    ultimoCommit = new Date(datos[0].commit.committer.date);
  } catch (e) {
    // Si no se puede consultar GitHub, no se avisa: sería un falso positivo por
    // un problema de red de Atlas, no del vigilante.
    console.error("No se pudo consultar GitHub: " + e.message);
    return;
  }

  const horasDeSilencio = (AHORA - ultimoCommit) / 3600000;
  console.log("Último commit hace " + horasDeSilencio.toFixed(1) + " horas.");

  if (horasDeSilencio < HORAS_DE_SILENCIO) return;

  // ── Freno: un aviso cada 12 horas, no uno por hora ──────────────────────
  let coleccion = null;
  for (let i = 0; i < NOMBRES_DATA_SOURCE.length; i++) {
    try {
      const s = context.services.get(NOMBRES_DATA_SOURCE[i]);
      if (s) { coleccion = s.db(NOMBRE_DB).collection("watchdog_vacantes"); break; }
    } catch (e) { /* siguiente nombre */ }
  }

  if (coleccion) {
    try {
      const previo = await coleccion.findOne({ _id: "ultimoAviso" });
      if (previo && (AHORA - new Date(previo.cuando)) / 3600000 < 12) {
        console.log("Ya se avisó hace menos de 12 horas. No se repite.");
        return;
      }
    } catch (e) {
      console.error("No se pudo leer el freno: " + e.message);
    }
  }

  // ── Avisar ──────────────────────────────────────────────────────────────
  const mensaje = [
    "🔴 *El vigilante de vacantes dejó de correr*",
    "",
    "Lleva " + Math.round(horasDeSilencio) + " horas sin dar señales (debería revisar cada 20 minutos).",
    "",
    "⚠️ *No te está avisando de las vacantes nuevas.* Revisá el sitio a mano:",
    "https://apps.mep.go.cr/formulario",
    "",
    "Para ver qué pasó:",
    "https://github.com/" + REPO + "/actions",
    "",
    "_Lo más común: GitHub desactiva los horarios en repos sin actividad. Se",
    "reactiva desde esa misma página, con el botón de habilitar el workflow._",
  ].join("\n");

  let enviado = false;
  try {
    const resp = await context.http.post({
      url: WAHA_URL + "/api/sendText",
      headers: { "Content-Type": ["application/json"], "X-Api-Key": [WAHA_API_KEY] },
      body: JSON.stringify({ session: WAHA_SESSION, chatId: DESTINO, text: mensaje }),
    });
    enviado = resp.statusCode >= 200 && resp.statusCode < 300;
    if (!enviado) console.error("WAHA respondió " + resp.statusCode);
  } catch (e) {
    console.error("Error enviando a WAHA: " + e.message);
  }

  if (enviado && coleccion) {
    try {
      await coleccion.updateOne(
        { _id: "ultimoAviso" },
        { $set: { cuando: AHORA, horasDeSilencio: horasDeSilencio } },
        { upsert: true }
      );
    } catch (e) {
      console.error("No se pudo guardar el freno: " + e.message);
    }
  }

  console.log((enviado ? "✅ Avisado" : "❌ No se pudo avisar"));
};
