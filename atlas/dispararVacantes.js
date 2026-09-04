// atlas/dispararVacantes.js
//
// Trigger de MongoDB Atlas que DISPARA el vigilante cada 20 min.
// Se pega en el panel de Atlas (Triggers > Add Trigger >
// Scheduled, Authentication: System) con este cron:
//
//     */20 0-3,11-23 * * *
//
// (UTC, o sea 5:00-22:00 hora de Costa Rica. Los cron de Atlas
// tambien van en UTC y CR es UTC-6 todo el año.)
//
// POR QUE EXISTE: el cron de GitHub Actions no sirve para esto.
// El 04/09/2026 el workflow estaba activo y sano, pero GitHub
// solo lanzo 4 corridas en 16 horas en vez de unas 50: en repos
// publicos del plan gratis, los horarios de intervalo corto son
// los primeros que descarta cuando su cola va cargada. Uno de
// esos disparos llego 4 horas tarde (07:53 UTC, fuera de las dos
// ventanas del cron). No es algo que se pueda reactivar ni
// arreglar del lado del repo.
//
// La salida es que el disparo venga de afuera: las corridas por
// workflow_dispatch NO pasan por esa cola de horarios, se lanzan
// de una. El navegador se queda en Actions (en la VM de WAHA no
// cabe Chromium, tumba el WhatsApp); aca se muda solo el reloj.
//
// OJO CON EL MODO: el workflow_dispatch tiene el input `modo` con
// default `prueba`, y un dispatch siempre manda un valor. Si no
// se le pasa `real` explicito, la corrida mira y guarda pero NO
// manda ni un WhatsApp. Ese es el error silencioso que hay que
// cuidar aca.
//
// SI ESTO FALLA no avisa por WhatsApp a proposito: el vigilante
// deja de commitear y [[watchdogVacantes]] lo agarra en 3 horas.
// Dos alarmas para lo mismo serian dos alarmas que mantener.
//
// EL TOKEN: hace falta un PAT de GitHub porque disparar un
// workflow es escritura (el repo es publico, pero eso solo abre
// la lectura). Fine-grained, solo para el repo vacantes-mep, con
// el permiso Actions: Read and write. Nada mas. La copia con el
// token real puesto va en 4-dispararVacantes.LISTO-NO-SUBIR.js,
// que lo ignora .gitignore.
//
// DOS TRAMPAS DEL PANEL DE ATLAS, ya conocidas de sobra:
//
//   1. Nada de "<" antes de una MAYUSCULA. El Babel del panel
//      corre con JSX y lee "< NOMBRE ... >" como etiqueta de
//      React. Todas las comparaciones van con ">".
//
//   2. Lineas cortas (72 caracteres). Al copiar desde una
//      terminal las largas se parten, el salto cae dentro de unas
//      comillas y da "Unterminated string constant". Copiar desde
//      el archivo, no del chat.

var TOKEN = "PEGA-AQUI-EL-PAT-DE-GITHUB";

var DUENO = "Jefernee";
var REPO = "vacantes-mep";
var WORKFLOW = "vigilar.yml";
var RAMA = "main";

// Segundo cinturon: si el cron del panel quedara mal escrito,
// esto igual no despierta al MEP a las 3 de la mañana.
var HORA_INICIO = 5;
var HORA_FIN = 22;

exports = async function () {
  var AHORA = new Date();
  var msCR = AHORA.getTime() - 6 * 60 * 60 * 1000;
  var horaCR = new Date(msCR).getUTCHours();

  // Ojo: nada de "<" antes de una MAYUSCULA (ver arriba).
  var temprano = HORA_INICIO > horaCR;
  var tarde = horaCR >= HORA_FIN;
  if (temprano || tarde) {
    console.log("Fuera de horario (" + horaCR + "h CR).");
    return;
  }

  var api = "https://api.github.com/repos/";
  var ruta = "/actions/workflows/" + WORKFLOW + "/dispatches";
  var direccion = api + DUENO + "/" + REPO + ruta;

  // `modo: real` es obligatorio, ver "OJO CON EL MODO" arriba.
  var cuerpo = {
    ref: RAMA,
    inputs: { modo: "real" }
  };

  try {
    var r = await context.http.post({
      url: direccion,
      headers: {
        "Accept": ["application/vnd.github+json"],
        "Authorization": ["Bearer " + TOKEN],
        "X-GitHub-Api-Version": ["2022-11-28"],
        "User-Agent": ["disparador-vacantes"],
        "Content-Type": ["application/json"]
      },
      body: JSON.stringify(cuerpo)
    });

    // GitHub contesta 204 sin cuerpo cuando acepta el disparo.
    if (r.statusCode === 204) {
      console.log("Vigilante disparado (" + horaCR + "h CR).");
      return;
    }

    // Un 401/403 aca casi siempre es el PAT vencido o sin el
    // permiso Actions: Read and write.
    var detalle = "";
    try {
      detalle = " " + r.body.text();
    } catch (e) {
      // sin cuerpo que leer, da igual
    }
    console.error("GitHub respondio " + r.statusCode + detalle);
  } catch (e) {
    console.error("No se pudo disparar: " + e.message);
  }
};
