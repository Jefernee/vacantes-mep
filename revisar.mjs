// revisar.mjs
//
// Recorre TODAS las direcciones regionales en apps.mep.go.cr/formulario, se queda
// con las vacantes que calzan con el grupo profesional VT6 y avisa por WhatsApp
// las que no se hayan avisado antes.
//
// POR QUÉ ASÍ:
//
//   · Un navegador de verdad. La app es Blazor Server (la lista se dibuja por
//     WebSocket, el HTML llega vacío) y encima está detrás de Cloudflare. Un
//     `fetch` recibe 403 y aunque no lo recibiera vería una página en blanco.
//
//   · Recorrer el menú entero. La propia página avisa que las regionales "no
//     visibles" son las que no tienen vacantes: el menú ya viene filtrado, así
//     que recorrerlo completo ES cubrir todo el país.
//
//   · Memoria de lo avisado. El MEP deja cada vacante publicada 24 horas
//     hábiles, y esto corre cada 20 minutos: sin memoria mandaría la misma
//     vacante 70 veces. Se guarda en estado/avisadas.json, que el propio
//     workflow commitea de vuelta al repo.
//
// MODO PRUEBA: con MODO=prueba no manda WhatsApp ni toca el estado. Solo mira y
// guarda lo que encontró en salida/. Sirve para revisar sin gastar mensajes.

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const DIRECCION = 'https://apps.mep.go.cr/formulario';
const CARPETA = new URL('./', import.meta.url);

const MODO_PRUEBA = (process.env.MODO || '').toLowerCase() === 'prueba';

// ── El filtro: grupo profesional VT6 ──────────────────────────────────────
// Tal como aparecen en la constancia de grupos profesionales. Se comparan sin
// tildes y en mayúsculas, porque el MEP no es consistente con los acentos
// ("MATEMATICAS" y "MATEMÁTICAS" conviven en la misma tabla).
const ESPECIALIDADES_VT6 = [
  'CIBERSEGURIDAD',
  'CONFIGURACION Y ADMINISTRACION DE SERVICIOS EN LA NUBE',
  'CONFIGURACION Y SOPORTE A REDES DE COMUNICACION Y SISTEMAS OPERATIVOS',
  'CONTROL DE LA CALIDAD DEL SOFTWARE',
  'DESARROLLO DE APLICACIONES MOVILES',
  'DESARROLLO WEB',
  'GESTION DE DATOS PARA EL ANALISIS Y LA VISUALIZACION',
  'INFORMATICA EMPRESARIAL',
  'INFORMATICA EN DESARROLLO DE SOFTWARE',
  'INFORMATICA EN PROGRAMACION',
  'INFORMATICA EN REDES DE COMPUTADORAS',
  'INFORMATICA EN SOPORTE',
  'INTELIGENCIA ARTIFICIAL',
];

// Cualquier otra cosa que hable de informática se avisa igual, marcada aparte.
// Perderse una vacante cuesta muchísimo más que recibir un aviso de más: la
// ventana son 24 horas hábiles y no hay segunda oportunidad.
const PISTAS_SUELTAS = ['INFORMATIC', 'COMPUTAC', 'PROGRAMAC', 'SOFTWARE', 'REDES', 'DIGITAL'];

const normalizar = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')  // fuera tildes
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

// Devuelve 'exacta' | 'posible' | null
const clasificar = (especialidad) => {
  const e = normalizar(especialidad);
  if (!e) return null;
  for (const v of ESPECIALIDADES_VT6) {
    if (e === v || e.includes(v) || v.includes(e)) return 'exacta';
  }
  for (const p of PISTAS_SUELTAS) {
    if (e.includes(p)) return 'posible';
  }
  return null;
};

// ── Utilidades ────────────────────────────────────────────────────────────
const guardar = async (ruta, contenido) => {
  const destino = new URL(ruta, CARPETA);
  await mkdir(new URL('./', destino), { recursive: true });
  await writeFile(destino, contenido);
};

const leerJson = async (ruta, porDefecto) => {
  try {
    return JSON.parse(await readFile(new URL(ruta, CARPETA), 'utf8'));
  } catch {
    return porDefecto;
  }
};

// ── Leer las vacantes de todas las regionales ─────────────────────────────
const recolectar = async (pagina) => {
  await pagina.goto(DIRECCION, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // Blazor conecta el WebSocket y recién ahí dibuja el menú. Esperamos a que el
  // menú tenga opciones de verdad, no solo el "Seleccione una..." inicial.
  await pagina.waitForFunction(
    () => document.querySelectorAll('#regionalSelect option, select option').length > 3,
    { timeout: 60000 }
  );

  const regionales = await pagina.$$eval('select option', (opciones) =>
    opciones
      .map((o) => ({ valor: o.value, texto: o.text.trim() }))
      .filter((o) => o.valor && !/^seleccione/i.test(o.texto))
  );

  console.log('Regionales con vacantes publicadas: ' + regionales.length);

  const todas = [];
  let htmlDeMuestra = null;

  for (const regional of regionales) {
    try {
      await pagina.selectOption('select', regional.valor);

      // La tabla se redibuja sola. Esperamos a que desaparezca el cartel de
      // "Seleccione una Dirección Regional" y haya filas con datos.
      await pagina.waitForFunction(
        () => {
          const filas = document.querySelectorAll('table tbody tr');
          if (!filas.length) return false;
          const primera = (filas[0].innerText || '').toLowerCase();
          return !primera.includes('seleccione una direccion') &&
                 !primera.includes('seleccione una dirección');
        },
        { timeout: 20000 }
      ).catch(() => { /* puede quedar vacía: se maneja abajo */ });

      await pagina.waitForTimeout(700);

      const filas = await pagina.$$eval('table tbody tr', (trs) =>
        trs
          .map((tr) => [...tr.cells].map((c) => (c.innerText || '').trim()))
          .filter((celdas) => celdas.length >= 8)
      );

      // Guardamos el HTML de la primera regional con datos: sirve para revisar
      // si la tabla tiene paginación y se nos escapan filas.
      if (!htmlDeMuestra && filas.length) {
        htmlDeMuestra = { regional: regional.texto, html: await pagina.content() };
      }

      for (const c of filas) {
        todas.push({
          vacante: c[0],
          regional: c[1] || regional.texto,
          clasePuesto: c[2],
          especialidad: c[3],
          institucion: c[4],
          lecciones: c[5],
          rige: c[6],
          vence: c[7],
        });
      }

      console.log('  ' + regional.texto + ': ' + filas.length + ' vacantes');
    } catch (e) {
      console.error('  ' + regional.texto + ': ERROR — ' + e.message);
    }
  }

  return { todas, htmlDeMuestra };
};

// ── Mandar el WhatsApp por WAHA ───────────────────────────────────────────
const avisar = async (nuevas) => {
  const url = process.env.WAHA_URL;
  const apiKey = process.env.WAHA_API_KEY;
  const chatId = process.env.WAHA_CHAT_ID;

  if (!url || !apiKey || !chatId) {
    console.error('Faltan WAHA_URL / WAHA_API_KEY / WAHA_CHAT_ID. No se manda nada.');
    return false;
  }

  const lineas = ['🎓 *Vacantes nuevas para vos* (VT6)', ''];
  for (const v of nuevas) {
    lineas.push((v.calce === 'exacta' ? '✅ ' : '🔎 ') + '*' + v.especialidad + '*');
    lineas.push('🏫 ' + v.institucion);
    lineas.push('📍 ' + v.regional);
    lineas.push('💼 ' + v.clasePuesto + (v.lecciones ? ' · ' + v.lecciones + ' lecciones' : ''));
    lineas.push('📅 Rige ' + v.rige + (v.vence ? ' — vence ' + v.vence : ''));
    lineas.push('🔢 Vacante ' + v.vacante);
    lineas.push('');
  }
  lineas.push('⏳ El MEP las deja publicadas 24 horas hábiles.');
  lineas.push('👉 ' + DIRECCION);
  if (nuevas.some((v) => v.calce === 'posible')) {
    lineas.push('');
    lineas.push('_🔎 = parecida a lo tuyo pero no idéntica. Revisala por las dudas._');
  }

  const mensaje = lineas.join('\n');
  console.log('--- mensaje ---\n' + mensaje + '\n---------------');

  const resp = await fetch(url.replace(/\/$/, '') + '/api/sendText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ session: process.env.WAHA_SESSION || 'default', chatId, text: mensaje }),
  });

  if (!resp.ok) {
    console.error('WAHA respondió ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
    return false;
  }
  return true;
};

// ── Programa principal ────────────────────────────────────────────────────
const navegador = await chromium.launch({ headless: true });
const contexto = await navegador.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1600, height: 2400 },
  locale: 'es-CR',
});
const pagina = await contexto.newPage();

let resultado;
try {
  resultado = await recolectar(pagina);
} finally {
  await navegador.close();
}

const { todas, htmlDeMuestra } = resultado;

// Marcamos cuáles calzan con VT6.
const interesantes = [];
for (const v of todas) {
  const calce = clasificar(v.especialidad);
  if (calce) interesantes.push({ ...v, calce });
}

console.log('');
console.log('Total de vacantes en el país: ' + todas.length);
console.log('Calzan con VT6: ' + interesantes.length);

// Un vistazo a las especialidades que existen hoy: sirve para afinar el filtro
// si el MEP escribe alguna de forma distinta a la de la constancia.
const especialidades = [...new Set(todas.map((v) => v.especialidad).filter(Boolean))].sort();

await guardar('salida/vacantes.json', JSON.stringify({
  generado: new Date().toISOString(),
  totalPais: todas.length,
  calzanVT6: interesantes.length,
  especialidadesVistas: especialidades,
  interesantes,
  todas,
}, null, 2));

if (htmlDeMuestra) {
  await guardar('salida/muestra-tabla.html', htmlDeMuestra.html);
  console.log('HTML de muestra guardado (' + htmlDeMuestra.regional + ')');
}

if (MODO_PRUEBA) {
  console.log('');
  console.log('MODO PRUEBA: no se manda WhatsApp ni se toca el estado.');
  console.log('Especialidades que hay hoy en el país:');
  for (const e of especialidades) console.log('  · ' + e);
  process.exit(0);
}

// ── Avisar solo lo que no se avisó antes ──────────────────────────────────
const estado = await leerJson('estado/avisadas.json', { avisadas: {} });
const ahora = new Date();

const nuevas = interesantes.filter((v) => !estado.avisadas[v.regional + '|' + v.vacante]);

if (!nuevas.length) {
  console.log('Nada nuevo que avisar.');
  process.exit(0);
}

console.log('Vacantes nuevas: ' + nuevas.length);
const enviado = await avisar(nuevas);

if (enviado) {
  for (const v of nuevas) {
    estado.avisadas[v.regional + '|' + v.vacante] = ahora.toISOString();
  }
  // Limpieza: lo de hace más de 30 días ya no puede reaparecer, y sin esto el
  // archivo crece para siempre.
  const limite = new Date(ahora.getTime() - 30 * 24 * 60 * 60 * 1000);
  for (const [clave, cuando] of Object.entries(estado.avisadas)) {
    if (new Date(cuando) < limite) delete estado.avisadas[clave];
  }
  await guardar('estado/avisadas.json', JSON.stringify(estado, null, 2));
  console.log('Aviso enviado y estado actualizado.');
} else {
  // No se marca nada: si el WhatsApp falló, la próxima corrida lo reintenta.
  console.error('El aviso NO salió. El estado queda igual para reintentar.');
  process.exit(1);
}
