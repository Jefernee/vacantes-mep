// avisar-fallo.mjs
//
// Avisa por WhatsApp cuando el vigilante se rompe, y avisa de nuevo cuando se
// recupera.
//
// POR QUÉ EXISTE: sin esto, un vigilante caído se ve exactamente igual que un
// vigilante que no encontró vacantes — silencio. Y el silencio es justo lo que
// uno espera la mayor parte del tiempo, así que podrían pasar semanas sin que
// nadie note que dejó de funcionar. Ese es el fallo peligroso.
//
// CÓMO SE USA (desde el workflow):
//   node avisar-fallo.mjs fallo "motivo"   → cuando el job falla
//   node avisar-fallo.mjs ok               → cuando el job sale bien
//
// EL FRENO: si el MEP se cae un fin de semana, esto correría cada 20 minutos y
// mandaría 50 mensajes. Se avisa una vez y no se repite hasta pasadas 3 horas.
// Un aviso que satura se termina ignorando, y entonces no sirve de nada.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const CARPETA = new URL('./', import.meta.url);
const ARCHIVO = 'estado/fallos.json';
const HORAS_ENTRE_AVISOS = 3;

const modo = (process.argv[2] || '').toLowerCase();
const motivo = process.argv[3] || 'sin detalle';

const leer = async () => {
  try {
    return JSON.parse(await readFile(new URL(ARCHIVO, CARPETA), 'utf8'));
  } catch {
    return { fallando: false, ultimoAviso: null, desde: null };
  }
};

const escribir = async (datos) => {
  const destino = new URL(ARCHIVO, CARPETA);
  await mkdir(new URL('./', destino), { recursive: true });
  await writeFile(destino, JSON.stringify(datos, null, 2));
};

const mandar = async (texto) => {
  const url = process.env.WAHA_URL;
  const apiKey = process.env.WAHA_API_KEY;
  const chatId = process.env.WAHA_CHAT_ID;
  if (!url || !apiKey || !chatId) {
    console.error('Faltan las credenciales de WAHA: no se puede avisar.');
    return false;
  }
  try {
    const resp = await fetch(url.replace(/\/$/, '') + '/api/sendText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ session: process.env.WAHA_SESSION || 'default', chatId, text: texto }),
    });
    if (!resp.ok) {
      console.error('WAHA respondió ' + resp.status);
      return false;
    }
    console.log('Aviso enviado.');
    return true;
  } catch (e) {
    // Si WAHA también está caído no hay nada más que hacer desde acá.
    console.error('No se pudo contactar a WAHA: ' + e.message);
    return false;
  }
};

const ahora = new Date();
const estado = await leer();
const enlace = process.env.ENLACE_CORRIDA || 'https://github.com/Jefernee/vacantes-mep/actions';

if (modo === 'ok') {
  // Solo se avisa la recuperación si antes hubo un fallo avisado. Si no, cada
  // corrida buena mandaría un "todo bien" y sería peor que el problema.
  if (estado.fallando) {
    const desde = estado.desde ? new Date(estado.desde) : null;
    const cuanto = desde
      ? Math.round((ahora - desde) / 60000) + ' minutos'
      : 'un rato';
    await mandar(
      '✅ *El vigilante de vacantes volvió a funcionar*\n\n' +
      'Estuvo caído ' + cuanto + '. Ya está revisando de nuevo cada 20 minutos.\n\n' +
      '⚠️ Revisá el sitio del MEP por si se publicó algo mientras estuvo caído:\n' +
      'https://apps.mep.go.cr/formulario'
    );
  }
  await escribir({ fallando: false, ultimoAviso: estado.ultimoAviso, desde: null });
  process.exit(0);
}

// ── Modo fallo ────────────────────────────────────────────────────────────
const ultimo = estado.ultimoAviso ? new Date(estado.ultimoAviso) : null;
const horasDesdeElUltimo = ultimo ? (ahora - ultimo) / 3600000 : Infinity;

if (horasDesdeElUltimo < HORAS_ENTRE_AVISOS) {
  console.log('Ya se avisó hace ' + horasDesdeElUltimo.toFixed(1) + ' h. No se repite.');
  // Se mantiene el estado de "fallando" para que la recuperación sí se avise.
  await escribir({ fallando: true, ultimoAviso: estado.ultimoAviso, desde: estado.desde || ahora.toISOString() });
  process.exit(0);
}

const salio = await mandar(
  '🔴 *El vigilante de vacantes se cayó*\n\n' +
  'Motivo: ' + motivo + '\n\n' +
  '⚠️ *Mientras tanto, revisá el sitio a mano*, porque no te va a avisar de las vacantes nuevas:\n' +
  'https://apps.mep.go.cr/formulario\n\n' +
  'Detalle de la corrida:\n' + enlace + '\n\n' +
  '_No se repite este aviso hasta dentro de ' + HORAS_ENTRE_AVISOS + ' horas._'
);

await escribir({
  fallando: true,
  ultimoAviso: salio ? ahora.toISOString() : estado.ultimoAviso,
  desde: estado.desde || ahora.toISOString(),
});
