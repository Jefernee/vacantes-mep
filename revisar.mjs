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

// Botón de prueba de la alarma. Una alarma que nunca se probó es una alarma que
// no se sabe si suena, y esta tiene que sonar el día que de verdad haga falta.
if (process.env.SIMULAR_FALLO === '1') {
  throw new Error('Fallo simulado a propósito para probar el aviso.');
}

// Cosas raras que conviene ver aunque no rompan la corrida.
const advertencias = [];
const advertir = (m) => { advertencias.push(m); console.error('ADVERTENCIA: ' + m); };

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

// Suena a informática pero NO es del grupo VT6. "Informática Educativa" es de
// I y II ciclos (y su variante de III y IV): es otro grupo profesional y no se
// pueden dar esas clases con esta constancia. Sin esta lista caerían siempre en
// la red de "posibles" y llegarían avisos de vacantes a las que no se puede
// aplicar — que es peor que no avisar, porque enseña a ignorar los mensajes.
const EXCLUIDAS = ['INFORMATICA EDUCATIVA'];

const estaExcluida = (especialidad) => {
  const plano = normalizar(especialidad);
  return EXCLUIDAS.some((x) => plano.includes(x));
};

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

// Palabras que no distinguen nada y sí rompen las comparaciones: el MEP publica
// "Informática En Desarrollo DEL Software" y la constancia dice "DE Software".
// Comparando palabra por palabra sin el relleno, las dos son la misma cosa.
const RELLENO = new Set(['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'EN', 'PARA', 'A', 'CON', 'AL']);

const fichas = (s) =>
  normalizar(s)
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !RELLENO.has(t));

const contieneTodas = (grandes, chicas) => chicas.every((t) => grandes.includes(t));

// Devuelve 'exacta' | 'posible' | null
const clasificar = (especialidad) => {
  // Antes que nada: lo excluido no se avisa ni aunque calce con las palabras.
  if (estaExcluida(especialidad)) return null;

  const propias = fichas(especialidad);
  if (!propias.length) return null;

  for (const v of ESPECIALIDADES_VT6) {
    const suyas = fichas(v);
    // Calce en los dos sentidos: la publicación puede ser más específica que la
    // constancia o al revés.
    if (contieneTodas(propias, suyas) || contieneTodas(suyas, propias)) return 'exacta';
  }

  const plano = normalizar(especialidad);
  for (const p of PISTAS_SUELTAS) {
    if (plano.includes(p)) return 'posible';
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

// ── Leer la tabla que está en pantalla, página por página ─────────────────
const leerFilas = (pagina) =>
  pagina.$$eval('table tbody tr', (trs) =>
    trs
      .map((tr) => [...tr.cells].map((c) => (c.innerText || '').trim()))
      .filter((celdas) => celdas.length >= 8)
  );

// El pie de la tabla dice algo como "1-10 de 23". Ese último número es la única
// forma de saber si nos faltan filas, así que se usa para verificar.
const totalDeclarado = async (pagina) => {
  const texto = await pagina
    .$eval('.mud-table-pagination', (el) => el.innerText || '')
    .catch(() => '');
  const m = texto.replace(/\s+/g, ' ').match(/(\d+)\s*-\s*(\d+)\s+(?:de|of)\s+(\d+)/i);
  return m ? Number(m[3]) : null;
};

// Pasa a la página siguiente. Devuelve false si ya no hay más.
const siguientePagina = async (pagina) => {
  const boton = pagina
    .locator('.mud-table-pagination button[aria-label*="next" i], .mud-table-pagination button[aria-label*="siguiente" i]')
    .first();
  if ((await boton.count()) === 0) return false;
  if (await boton.isDisabled().catch(() => true)) return false;
  await boton.click();
  await pagina.waitForTimeout(900);
  return true;
};

const leerRegional = async (pagina, regional) => {
  await pagina.selectOption('#regionalSelect', regional.valor);

  await pagina
    .waitForFunction(
      () => {
        const filas = document.querySelectorAll('table tbody tr');
        if (!filas.length) return false;
        return !/seleccione una direcci/i.test(filas[0].innerText || '');
      },
      { timeout: 20000 }
    )
    .catch(() => {});

  await pagina.waitForTimeout(700);

  const filas = [];
  const vistas = new Set();
  const total = await totalDeclarado(pagina);

  for (let pag = 1; pag <= 25; pag++) {
    for (const c of await leerFilas(pagina)) {
      const clave = c.join('|');
      if (!vistas.has(clave)) {
        vistas.add(clave);
        filas.push(c);
      }
    }
    if (total !== null && filas.length >= total) break;
    if (!(await siguientePagina(pagina))) break;
  }

  // La red de seguridad: si el pie declara más filas de las que juntamos, algo
  // quedó sin leer. Mejor enterarse acá que por una vacante perdida.
  if (total !== null && filas.length < total) {
    advertir(regional.texto + ': el MEP declara ' + total + ' vacantes y solo se leyeron ' + filas.length);
  }

  return filas;
};

// ── Recorrer todas las regionales ─────────────────────────────────────────
const recolectar = async (pagina) => {
  await pagina.goto(DIRECCION, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // Blazor conecta el WebSocket y recién ahí dibuja el menú. Esperamos a que el
  // menú tenga opciones de verdad, no solo el "Seleccione una..." inicial.
  await pagina.waitForFunction(
    () => document.querySelectorAll('#regionalSelect option, select option').length > 3,
    { timeout: 60000 }
  );

  const regionales = await pagina.$$eval('#regionalSelect option', (opciones) =>
    opciones
      .map((o) => ({ valor: o.value, texto: o.text.trim() }))
      .filter((o) => o.valor && !/^seleccione/i.test(o.texto))
  );

  console.log('Regionales con vacantes publicadas: ' + regionales.length);
  if (regionales.length < 3) {
    advertir('El menú trajo solo ' + regionales.length + ' regionales; puede que la app no cargara bien.');
  }

  const todas = [];
  let htmlDeMuestra = null;

  for (const regional of regionales) {
    try {
      const filas = await leerRegional(pagina, regional);

      // Guardamos el HTML de la primera regional con datos: sirve para revisar
      // cómo viene la tabla si algo cambia.
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

      console.log('  ' + regional.texto + ': ' + filas.length);
    } catch (e) {
      advertir(regional.texto + ': no se pudo leer — ' + e.message);
    }

    // Blazor muestra su propio cartel cuando se le cae el circuito. Si eso pasa,
    // TODAS las regionales que siguen darían cero vacantes y parecería que no
    // hay ninguna: es el peor fallo posible acá, porque es silencioso.
    const reventado = await pagina.locator('#blazor-error-ui').isVisible().catch(() => false);
    if (reventado) {
      advertir('La app mostró su cartel de error. Se recarga y se sigue.');
      await pagina.goto(DIRECCION, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await pagina
        .waitForFunction(() => document.querySelectorAll('#regionalSelect option').length > 3, { timeout: 60000 })
        .catch(() => {});
    }
  }

  return { todas, htmlDeMuestra };
};

// ── Catálogo de especialidades ────────────────────────────────────────────
// Se anota TODA especialidad que el MEP publique, calce o no. Es la red contra
// el fallo más peligroso de todos: que el MEP le cambie el nombre a una de las
// tuyas y el filtro deje de reconocerla sin que nadie se entere.
//
// Con el catálogo, un nombre nuevo queda registrado la primera vez que aparece y
// se puede revisar después, en vez de descubrirlo por una vacante perdida.
const actualizarCatalogo = (catalogo, todas, ahora) => {
  const cuando = ahora.toISOString();

  for (const v of todas) {
    const nombre = (v.especialidad || '').trim();
    if (!nombre) continue;

    const calce = clasificar(nombre) || (estaExcluida(nombre) ? 'excluida' : 'no interesa');
    const yaEstaba = catalogo.especialidades[nombre];

    if (!yaEstaba) {
      catalogo.especialidades[nombre] = {
        calce: calce,
        vecesVista: 1,
        primeraVez: cuando,
        ultimaVez: cuando,
        avisadaComoNueva: false,
      };
    } else {
      yaEstaba.vecesVista += 1;
      yaEstaba.ultimaVez = cuando;
      yaEstaba.calce = calce;
    }
  }
};

// Los nombres parecidos que todavía no se avisaron.
//
// Anotar y avisar van SEPARADOS a propósito: el catálogo se guarda siempre, pero
// la marca de "ya avisado" solo se pone si el WhatsApp salió. Si se marcaran
// juntos, un fallo de envío se tragaría la única alerta de que el filtro pudo
// haber quedado corto — y esa alerta no vuelve a aparecer nunca.
//
// Solo se avisan las parecidas: una especialidad nueva de cocina o de música no
// aporta nada y llenaría el mensaje de ruido.
const parecidasSinAvisar = (catalogo) =>
  Object.entries(catalogo.especialidades)
    .filter(([, e]) => e.calce === 'posible' && !e.avisadaComoNueva)
    .map(([nombre]) => nombre);

// ── Mandar el WhatsApp por WAHA ───────────────────────────────────────────
const avisar = async (nuevas, nuevasParecidas = [], problemas = []) => {
  const url = process.env.WAHA_URL;
  const apiKey = process.env.WAHA_API_KEY;
  const chatId = process.env.WAHA_CHAT_ID;

  if (!url || !apiKey || !chatId) {
    console.error('Faltan WAHA_URL / WAHA_API_KEY / WAHA_CHAT_ID. No se manda nada.');
    return false;
  }

  const lineas = [];
  lineas.push(
    nuevas.length ? '🎓 *Vacantes nuevas para vos* (VT6)'
    : problemas.length ? '⚠️ *Aviso del vigilante de vacantes*'
    : '🆕 *Aviso del vigilante de vacantes*'
  );
  lineas.push('');
  for (const v of nuevas) {
    lineas.push((v.calce === 'exacta' ? '✅ ' : '🔎 ') + '*' + v.especialidad + '*');
    lineas.push('🏫 ' + v.institucion);
    lineas.push('📍 ' + v.regional);
    lineas.push('💼 ' + v.clasePuesto + (v.lecciones ? ' · ' + v.lecciones + ' lecciones' : ''));
    lineas.push('📅 Rige ' + v.rige + (v.vence ? ' — vence ' + v.vence : ''));
    lineas.push('🔢 Vacante ' + v.vacante);
    lineas.push('');
  }
  if (nuevas.length) lineas.push('⏳ El MEP las deja publicadas 24 horas hábiles.');
  lineas.push('👉 ' + DIRECCION);
  if (nuevas.some((v) => v.calce === 'posible')) {
    lineas.push('');
    lineas.push('_🔎 = parecida a lo tuyo pero no idéntica. Revisala por las dudas._');
  }
  if (nuevasParecidas.length) {
    lineas.push('');
    lineas.push('🆕 *Nombre de especialidad nunca visto antes:*');
    for (const n of nuevasParecidas) lineas.push('· ' + n);
    lineas.push('_Puede ser una de las tuyas escrita distinto. Queda anotada._');
  }
  if (problemas.length) {
    lineas.push('');
    lineas.push('⚠️ *El vigilante leyó a medias:*');
    for (const p of problemas) lineas.push('· ' + p);
    lineas.push('_Puede haber vacantes que no se vieron. Revisá el sitio a mano._');
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
  advertencias,
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
  console.log('MODO PRUEBA: no se manda WhatsApp ni se toca el estado ni el catálogo.');
  console.log('Especialidades que hay hoy en el país:');
  for (const e of especialidades) console.log('  · ' + e);
  process.exit(0);
}

// ── Anotar las especialidades vistas ──────────────────────────────────────
const ahora = new Date();
const catalogo = await leerJson('estado/especialidades.json', { especialidades: {} });
actualizarCatalogo(catalogo, todas, ahora);
const nuevasParecidas = parecidasSinAvisar(catalogo);
catalogo.actualizado = ahora.toISOString();
await guardar('estado/especialidades.json', JSON.stringify(catalogo, null, 2));

if (nuevasParecidas.length) {
  console.log('Especialidades parecidas nunca vistas: ' + nuevasParecidas.join(' | '));
}
console.log('Especialidades conocidas hasta hoy: ' + Object.keys(catalogo.especialidades).length);

// ── Avisar solo lo que no se avisó antes ──────────────────────────────────
const estado = await leerJson('estado/avisadas.json', { avisadas: {} });

const nuevas = interesantes.filter((v) => !estado.avisadas[v.regional + '|' + v.vacante]);

// Un nombre nuevo parecido al tuyo se avisa aunque no haya vacantes nuevas: es
// justamente la señal de que el filtro puede haber quedado corto.
if (!nuevas.length && !nuevasParecidas.length && !advertencias.length) {
  console.log('Nada nuevo que avisar.');
  process.exit(0);
}

console.log('Vacantes nuevas: ' + nuevas.length);
const enviado = await avisar(nuevas, nuevasParecidas, advertencias);

if (enviado) {
  for (const v of nuevas) {
    estado.avisadas[v.regional + '|' + v.vacante] = ahora.toISOString();
  }

  // Los nombres nuevos ya se avisaron: no repetirlos en cada corrida.
  for (const nombre of nuevasParecidas) {
    if (catalogo.especialidades[nombre]) catalogo.especialidades[nombre].avisadaComoNueva = true;
  }
  await guardar('estado/especialidades.json', JSON.stringify(catalogo, null, 2));
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
