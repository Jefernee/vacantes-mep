// atlas/watchdogVacantes.js
//
// Trigger de MongoDB Atlas que vigila AL VIGILANTE.
// Se pega en el panel de Atlas (Triggers > Add Trigger > Scheduled,
// una vez por hora, Authentication: System). NO corre en GitHub.
//
// POR QUE EXISTE: el vigilante avisa cuando falla, pero eso solo
// sirve si LLEGA A CORRER. Si nadie lo dispara no falla nada:
// simplemente deja de pasar, y "no pasa nada" es justo lo que uno
// espera cuando no hay vacantes. Podrian pasar semanas sin que
// nadie lo note. Por eso vive en otra infraestructura: en GitHub
// se caeria junto con lo que tiene que vigilar.
//
// Desde el 04/09/2026 el que lo dispara es [[dispararVacantes]],
// otro trigger de Atlas, porque el cron de GitHub descartaba 9 de
// cada 10 corridas. Asi que ahora este watchdog vigila dos cosas:
// que el vigilante corra Y que el disparador siga disparando.
//
// COMO SE DA CUENTA: cada corrida del vigilante hace un commit al
// guardar su estado. Si el ultimo commit es viejo, dejo de correr.
// No hace falta token: el repo es publico.
//
// DOS TRAMPAS DEL PANEL DE ATLAS, aprendidas a los golpes:
//
//   1. Nada de "<" antes de una MAYUSCULA. Babel corre con JSX
//      habilitado y lee "< NOMBRE ... >" como una etiqueta de React.
//      Falla con mensajes que apuntan a otro lado ("falta un punto y
//      coma" sobre un if valido). Todas las comparaciones van con ">".
//
//   2. Lineas cortas (72 caracteres). Al copiar desde una terminal,
//      las largas se parten y el salto de linea cae en medio de unas
//      comillas: "Unterminated string constant".
//
// La copia con la API key real esta en 3-watchdogVacantes.LISTO-NO-SUBIR.js
// (fuera del repo, la ignora .gitignore).

var WAHA_URL = "http://157.151.183.29:3000";
var WAHA_KEY = "PEGA-AQUI-LA-API-KEY-DE-WAHA";
var SESION = "default";
var DESTINO = "50686825481@c.us";

var DUENO = "Jefernee";
var REPO = "vacantes-mep";

// Horas de silencio que se consideran "esta caido".
var LIMITE = 3;

// Empieza a las 6 y NO a las 5 a proposito. El vigilante para a
// las 21:40 CR y arranca a las 5:00, o sea 7h20 de silencio que
// son normales. Revisando a las 5:00 en punto se ve ese hueco de
// 7 horas y se grita en falso, porque el disparo de las 5:00
// todavia no alcanzo a commitear. A las 6 ya lleva 3 corridas.
// Se paga con detectar una caida de las 5 a.m. una hora tarde.
var HORA_INICIO = 6;
var HORA_FIN = 22;

var FUENTES = ["Cluster0", "mongodb-atlas"];
var BASE = "salaDeJuegos";

exports = async function () {
  var AHORA = new Date();
  var msCR = AHORA.getTime() - 6 * 60 * 60 * 1000;
  var horaCR = new Date(msCR).getUTCHours();

  // Ojo: nada de "<" antes de una MAYUSCULA. Babel de Atlas
  // tiene JSX y lo confunde con una etiqueta de React.
  var temprano = HORA_INICIO > horaCR;
  var tarde = horaCR >= HORA_FIN;
  if (temprano || tarde) {
    console.log("Fuera de horario (" + horaCR + "h CR).");
    return;
  }

  var api = "https://api.github.com/repos/";
  var ruta = "/commits?per_page=1";
  var direccion = api + DUENO + "/" + REPO + ruta;

  var ultimo = null;
  try {
    var r = await context.http.get({
      url: direccion,
      headers: {
        "Accept": ["application/vnd.github+json"],
        "User-Agent": ["watchdog-vacantes"]
      }
    });
    if (200 > r.statusCode || r.statusCode >= 300) {
      console.error("GitHub respondio " + r.statusCode);
      return;
    }
    var datos = JSON.parse(r.body.text());
    if (!datos.length) {
      console.error("Sin commits.");
      return;
    }
    ultimo = new Date(datos[0].commit.committer.date);
  } catch (e) {
    // Falla de red de Atlas, no del vigilante: no se avisa.
    console.error("No se pudo consultar GitHub: " + e.message);
    return;
  }

  var horas = (AHORA - ultimo) / 3600000;
  console.log("Ultimo commit hace " + horas.toFixed(1) + " h.");

  if (LIMITE > horas) return;

  // Freno: un aviso cada 12 horas, no uno por hora.
  var col = null;
  for (var i = 0; FUENTES.length > i; i++) {
    try {
      var s = context.services.get(FUENTES[i]);
      if (s) {
        col = s.db(BASE).collection("watchdog_vacantes");
        break;
      }
    } catch (e) {
      // nombre equivocado, probamos el siguiente
    }
  }

  if (col) {
    try {
      var p = await col.findOne({ _id: "ultimoAviso" });
      if (p) {
        var desde = (AHORA - new Date(p.cuando)) / 3600000;
        if (12 > desde) {
          console.log("Ya se aviso hace poco. No se repite.");
          return;
        }
      }
    } catch (e) {
      console.error("No se pudo leer el freno: " + e.message);
    }
  }

  var sitio = "https://apps.mep.go.cr/formulario";
  var acciones = "https://github.com/" + DUENO + "/" + REPO;

  var lineas = [];
  lineas.push("🔴 *El vigilante de vacantes dejo de correr*");
  lineas.push("");
  lineas.push("Lleva " + Math.round(horas) + " horas sin dar senales.");
  lineas.push("Deberia revisar cada 20 minutos.");
  lineas.push("");
  lineas.push("⚠️ *No te esta avisando de vacantes nuevas.*");
  lineas.push("Revisa el sitio a mano:");
  lineas.push(sitio);
  lineas.push("");
  lineas.push("Para ver que paso:");
  lineas.push(acciones + "/actions");
  lineas.push("");
  lineas.push("_Lo mas comun: el trigger dispararVacantes de");
  lineas.push("Atlas dejo de disparar (PAT vencido o trigger");
  lineas.push("suspendido). Revisalo en el panel de Atlas._");
  var mensaje = lineas.join("\n");

  var enviado = false;
  try {
    var envio = await context.http.post({
      url: WAHA_URL + "/api/sendText",
      headers: {
        "Content-Type": ["application/json"],
        "X-Api-Key": [WAHA_KEY]
      },
      body: JSON.stringify({
        session: SESION,
        chatId: DESTINO,
        text: mensaje
      })
    });
    enviado = envio.statusCode >= 200 && 300 > envio.statusCode;
    if (!enviado) {
      console.error("WAHA respondio " + envio.statusCode);
    }
  } catch (e) {
    console.error("Error enviando a WAHA: " + e.message);
  }

  if (enviado && col) {
    try {
      await col.updateOne(
        { _id: "ultimoAviso" },
        { $set: { cuando: AHORA, horas: horas } },
        { upsert: true }
      );
    } catch (e) {
      console.error("No se pudo guardar el freno: " + e.message);
    }
  }

  console.log(enviado ? "Avisado" : "No se pudo avisar");
};
