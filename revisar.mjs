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

// Los errores de Playwright traen un "Call log" de veinte líneas debajo del
// mensaje. Para el WhatsApp solo sirve la primera.
const primeraLinea = (t) => String(t).split(/\r?\n/)[0].trim();

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

// El texto del menú y el de la tabla no calzan letra por letra: el menú dice
// "Regional Educación Alajuela" y la tabla "Direc. Regional Educacion Alajuela".
// Se comparan sin tildes, sin espacios y sin puntuación, y alcanza con que el de
// la tabla contenga al del menú.
const comoClave = (t) => normalizar(t).replace(/[^A-Z0-9]/g, '');

const leerRegional = async (pagina, regional) => {
  await pagina.selectOption('#regionalSelect', regional.valor);

  // HAY QUE ESPERAR A LA TABLA CORRECTA, no a que haya tabla.
  //
  // Blazor deja en pantalla la tabla de la regional anterior mientras trae la
  // nueva, y a partir de cierto punto la app se atora y deja de cambiarla del
  // todo. La espera vieja solo pedía "que haya filas y que no diga Seleccione
  // una Dirección Regional", y eso se cumple al instante con la tabla VIEJA: se
  // leía la regional anterior y se contaban sus vacantes como si fueran de esta.
  //
  // No daba error nunca. Medido el 17/09/2026: una corrida trajo 57 filas de las
  // que solo 30 eran distintas, y 14 de las 22 regionales no se llegaron a leer.
  // Para un vigilante cuyo único trabajo es no perderse una vacante, ese es el
  // fallo peor: el silencioso.
  //
  // OJO CON LA FIRMA: waitForFunction(fn, argumento, opciones). El timeout va en
  // el TERCER parámetro. Cuando iba en el segundo, Playwright lo tomaba como el
  // argumento de la función y la espera corría con el default de 30 s: los
  // números que decía el código nunca fueron los que se aplicaban.
  const llego = await pagina
    .waitForFunction(
      (objetivo) => {
        const limpiar = (t) =>
          (t || '')
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '');
        const filas = document.querySelectorAll('table tbody tr');
        if (!filas.length) return false;
        const celdas = filas[0].cells;
        // "Cargando.." ocupa una sola celda mientras la tabla se rehace.
        if (celdas.length < 8) return false;
        return limpiar(celdas[1].innerText).includes(objetivo);
      },
      comoClave(regional.texto),
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!llego) {
    // Quien llama recarga la app y reintenta ESTA regional. Rendirse en silencio
    // sería volver a contar las vacantes de la regional anterior.
    throw new Error('la tabla nunca cambió a ' + regional.texto);
  }

  // La primera fila ya es de esta regional, pero las demás pueden estar todavía
  // dibujándose. Un respiro corto sale más barato que releer mal.
  await pagina.waitForTimeout(400);

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

// ── Abrir la app y esperar a que dibuje el menú ───────────────────────────
//
// Blazor conecta el WebSocket y recién ahí dibuja el menú. Se espera a que el
// menú tenga opciones de verdad, no solo el "Seleccione una..." inicial.
// Devuelve true si quedó lista para usar; no tira excepción, porque quien la
// llama decide si recarga o se rinde.
const abrirApp = async (pagina, timeout = 25000) => {
  await pagina.goto(DIRECCION, { waitUntil: 'domcontentloaded', timeout: 90000 });
  return pagina
    .waitForFunction(
      () => document.querySelectorAll('#regionalSelect option, select option').length > 3,
      null,
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
};

// Recargar hasta que la app dibuje, con una pausa de por medio. Una sola
// recarga no siempre alcanza: medido el 17/09/2026, cuando el circuito se cae a
// media lectura la primera recarga puede volver a nacer muerta.
const abrirAppReintentando = async (pagina, intentos = 3) => {
  for (let intento = 1; intento <= intentos; intento++) {
    if (await abrirApp(pagina)) return true;
    console.log('  la app no dibujó (intento ' + intento + ' de ' + intentos + ').');
    if (intento < intentos) await pagina.waitForTimeout(3000);
  }
  return false;
};

// ── Recorrer todas las regionales ─────────────────────────────────────────
const recolectar = async (pagina) => {
  // El circuito de Blazor a veces nace muerto: el WebSocket conecta, la página
  // responde, pero la lista de regionales nunca se dibuja y ahí se queda — no
  // se recupera sola ni esperando 90 segundos (medido el 17/09/2026: pasó en 1
  // de cada 6 cargas). Recargar sí la arregla.
  //
  // Antes acá había una sola espera: una carga mala tumbaba la corrida entera y
  // disparaba el WhatsApp de "se rompió" por algo que se arregla con un F5.
  // Cinco de los ocho fallos de las primeras dos semanas fueron exactamente eso.
  if (!(await abrirAppReintentando(pagina))) {
    throw new Error('La lista de regionales no cargó en 3 intentos: la app del MEP no está dibujando.');
  }

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

  let appPerdida = false;

  for (const regional of regionales) {
    let filas = null;
    let ultimoError = null;

    // Dos pasadas por regional. Antes, si una fallaba, se daba por perdida y la
    // corrida terminaba avisando "puede haber vacantes que no se vieron" — justo
    // lo que este vigilante existe para evitar. Ahora se recarga la app y se
    // vuelve a intentar ESA regional antes de rendirse.
    for (let intento = 1; intento <= 2; intento++) {
      try {
        filas = await leerRegional(pagina, regional);
      } catch (e) {
        ultimoError = e;
        filas = null;
      }

      // Blazor muestra su propio cartel cuando se le cae el circuito. Si queda
      // caído, TODAS las regionales que siguen darían cero vacantes y parecería
      // que no hay ninguna: es el peor fallo posible acá, porque es silencioso.
      const caido = await pagina.locator('#blazor-error-ui').isVisible().catch(() => false);
      if (!caido && filas !== null) break;

      if (!(await abrirAppReintentando(pagina))) {
        appPerdida = true;
        break;
      }
      // La lectura sí sirvió: la recarga era solo para dejar la app sana para la
      // regional siguiente, no hay que repetir esta.
      if (filas !== null) break;
      console.log('  ' + regional.texto + ': no se pudo leer; se reintenta tras recargar.');
    }

    if (filas === null) {
      advertir(regional.texto + ': no se pudo leer — ' + (ultimoError ? primeraLinea(ultimoError.message) : 'sin detalle'));
    } else {
      try {
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
        advertir(regional.texto + ': se leyó pero no se pudo anotar — ' + primeraLinea(e.message));
      }
    }

    if (appPerdida) {
      // Sin app no hay nada que leer: seguir con las regionales que faltan es
      // gastar dos minutos en cada una para traer cero filas, y encima acercarse
      // al límite de 20 minutos del job. Se corta acá con lo que sí se alcanzó a
      // ver; la corrida de dentro de 20 minutos vuelve a intentar desde cero.
      advertir(
        'La app del MEP dejó de dibujar y no volvió tras varias recargas. Se cortó en ' +
        regional.texto + ': quedaron regionales sin revisar.'
      );
      break;
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

// Los nombres que todavía no se avisaron.
//
// Se avisa de TODO nombre nuevo, no solo de los que suenan a informática. El
// fallo que esto tiene que atrapar es el que no se ve: que el MEP le cambie el
// nombre a una especialidad tuya lo suficiente como para que ni siquiera parezca
// informática ("Seguridad de la Información" en vez de "Ciberseguridad", por
// ejemplo). Filtrando por palabras clave, ese caso pasaría de largo para siempre.
//
// No es ruidoso porque se avisa por NOMBRE, no por vacante: las especialidades se
// repiten, así que después de la siembra inicial aparecen unas pocas al mes.
//
// Anotar y avisar van SEPARADOS a propósito: el catálogo se guarda siempre, pero
// la marca de "ya avisado" solo se pone si el WhatsApp salió. Si se marcaran
// juntos, un fallo de envío se tragaría la única alerta de que el filtro pudo
// haber quedado corto — y esa alerta no vuelve a aparecer nunca.
const nombresSinAvisar = (catalogo) =>
  Object.entries(catalogo.especialidades)
    // Las excluidas ya se decidieron a mano: no hay nada que revisar.
    .filter(([, e]) => !e.avisadaComoNueva && e.calce !== 'excluida')
    .map(([nombre, e]) => ({ nombre, calce: e.calce }));

// ── Matemáticas, para el segundo destinatario ─────────────────────────────
// El MEP escribe la especialidad de varias formas ("Matemáticas", "Matematica",
// "Matemáticas / Matemáticas"), así que se compara sin tildes y por contenido.
const esMatematicas = (especialidad) => normalizar(especialidad).includes('MATEMATIC');

// ── A quién se le avisa y de qué ──────────────────────────────────────────
//
// Dos destinatarios con necesidades distintas:
//
//   · El principal es el dueño del vigilante. Le llega todo: las vacantes de su
//     grupo profesional VT6, los nombres de especialidad nunca vistos (para
//     poder afinar el filtro), las advertencias de lectura y el latido.
//
//   · El de matemáticas es alguien a quien solo le interesa que le avisen de una
//     plaza. Le llegan SOLO las vacantes de matemáticas: ni catálogo de
//     especialidades, ni advertencias, ni latido. Lo demás es mantenimiento del
//     vigilante y para esa persona sería ruido.
//
// Si el chatId de un destinatario viene vacío, ese destinatario simplemente no
// existe: así se puede dejar el de matemáticas configurado el día que haya
// número, sin tocar el código.
const DESTINOS = [
  {
    id: 'principal',
    etiqueta: 'VT6',
    chatId: process.env.WAHA_CHAT_ID,
    // null = el filtro de siempre, el que ya decide clasificar().
    filtro: null,
    extras: true,
  },
  {
    id: 'matematicas',
    etiqueta: 'Matemáticas',
    chatId: process.env.WAHA_CHAT_ID_MATEMATICAS,
    filtro: esMatematicas,
    extras: false,
  },
].filter((d) => d.chatId);

// ── Mandar un texto por WAHA ──────────────────────────────────────────────
// Un solo lugar que hable con WAHA: lo usan el aviso de vacantes y el latido.
const mandarTexto = async (chatId, mensaje) => {
  const url = process.env.WAHA_URL;
  const apiKey = process.env.WAHA_API_KEY;

  if (!url || !apiKey || !chatId) {
    console.error('Faltan WAHA_URL / WAHA_API_KEY / el destinatario. No se manda nada.');
    return false;
  }

  console.log('--- mensaje para ' + chatId + ' ---');
  console.log(mensaje);
  console.log('---------------');

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

// ── El WhatsApp de las vacantes ───────────────────────────────────────────
// `destino.extras` decide si además del listado de vacantes van los nombres de
// especialidad nunca vistos y las advertencias de lectura. Al número de
// matemáticas le van SOLO las vacantes: lo demás es mantenimiento del vigilante
// y no le sirve de nada a quien solo quiere enterarse de una plaza.
const avisar = async (destino, nuevas, nombresNuevos = [], problemas = [], esSiembra = false) => {
  if (!destino.extras) {
    nombresNuevos = [];
    problemas = [];
  }

  const lineas = [];
  lineas.push(
    nuevas.length ? '🎓 *Vacantes nuevas* (' + destino.etiqueta + ')'
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
  if (nombresNuevos.length) {
    lineas.push('');
    if (esSiembra) {
      lineas.push('🗂 *Especialidades que publica el MEP hoy* (' + nombresNuevos.length + ')');
      lineas.push('_Esta lista va una sola vez, para que la revises. De aquí en adelante solo te aviso de los nombres nuevos._');
    } else {
      lineas.push('🆕 *Nombres de especialidad nunca vistos* (' + nombresNuevos.length + ')');
    }
    lineas.push('');

    // Primero las que sí se avisarían: si alguna es un nombre nuevo de algo tuyo,
    // conviene que salte a la vista antes que la lista larga de las que no.
    const ordenados = [...nombresNuevos].sort((a, b) =>
      (a.calce === 'no interesa' ? 1 : 0) - (b.calce === 'no interesa' ? 1 : 0)
    );

    // El mensaje tiene que seguir siendo legible en el teléfono.
    const TOPE = 25;
    for (const n of ordenados.slice(0, TOPE)) {
      const marca = n.calce === 'exacta' ? '✅' : n.calce === 'posible' ? '🔎' : '·';
      lineas.push(marca + ' ' + n.nombre);
    }
    if (ordenados.length > TOPE) lineas.push('… y ' + (ordenados.length - TOPE) + ' más.');

    lineas.push('');
    lineas.push('_Si alguna de estas es tuya y no te la estoy avisando, decímelo y la agrego al filtro._');
  }
  if (problemas.length) {
    lineas.push('');
    lineas.push('⚠️ *El vigilante leyó a medias:*');
    for (const p of problemas) lineas.push('· ' + p);
    lineas.push('_Puede haber vacantes que no se vieron. Revisá el sitio a mano._');
  }

  return mandarTexto(destino.chatId, lineas.join('\n'));
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
// La primera corrida ve TODAS las especialidades como nuevas. Eso no es una
// alerta, es la siembra del catálogo, y el mensaje lo tiene que decir así.
const catalogoEstabaVacio = Object.keys(catalogo.especialidades).length === 0;
actualizarCatalogo(catalogo, todas, ahora);
const nombresNuevos = nombresSinAvisar(catalogo);
catalogo.actualizado = ahora.toISOString();
await guardar('estado/especialidades.json', JSON.stringify(catalogo, null, 2));

if (nombresNuevos.length) {
  console.log('Nombres de especialidad nunca vistos: ' + nombresNuevos.map((n) => n.nombre).join(' | '));
}
console.log('Especialidades conocidas hasta hoy: ' + Object.keys(catalogo.especialidades).length);

// ── Avisar solo lo que no se avisó antes ──────────────────────────────────
//
// La memoria de lo avisado es POR DESTINATARIO: la misma vacante de matemáticas
// puede estar sin avisar para uno y ya avisada para el otro, y con una sola
// lista compartida el segundo destinatario se perdería todo lo que el primero
// ya recibió.
const estado = await leerJson('estado/avisadas.json', { avisadas: {} });

// El archivo nació con una sola lista plana, de cuando había un solo
// destinatario. Se mueve bajo "principal" para no volver a avisar lo viejo.
if (Object.values(estado.avisadas).some((v) => typeof v === 'string')) {
  estado.avisadas = { principal: estado.avisadas };
}
for (const d of DESTINOS) estado.avisadas[d.id] = estado.avisadas[d.id] || {};

const clave = (v) => v.regional + '|' + v.vacante;

// Para cada destinatario, qué le tocaría y qué de eso todavía no ha visto.
const reparto = DESTINOS.map((destino) => {
  const suyas = destino.filtro
    ? todas.filter((v) => destino.filtro(v.especialidad)).map((v) => ({ ...v, calce: 'exacta' }))
    : interesantes;
  return { destino, nuevas: suyas.filter((v) => !estado.avisadas[destino.id][clave(v)]) };
});

for (const { destino, nuevas } of reparto) {
  console.log(destino.id + ' (' + destino.etiqueta + '): ' + nuevas.length + ' vacantes sin avisar');
}

// ── El latido: "sigo acá" cada 3 horas ────────────────────────────────────
//
// Un vigilante sano es un vigilante callado, y desde el teléfono el silencio se
// ve igual que estar caído. Las alarmas de la VM y de Atlas cubren el caso de
// que deje de correr del todo, pero eso no se ve desde acá. Cada 3 horas manda
// una línea diciendo que revisó y qué encontró, para no confiar a ciegas.
//
// Solo al destinatario principal: al de matemáticas se le prometió que solo le
// llegan vacantes.
const LATIDO_CADA_HORAS = 3;
const latido = await leerJson('estado/latido.json', { ultimo: null, totalPais: null });
const horasSinLatido = latido.ultimo ? (ahora - new Date(latido.ultimo)) / 3600000 : Infinity;
const principal = DESTINOS.find((d) => d.id === 'principal');

const guardarLatido = () =>
  guardar('estado/latido.json', JSON.stringify({ ultimo: ahora.toISOString(), totalPais: todas.length }, null, 2));

// Red de seguridad contra el próximo fallo silencioso, sea cual sea: si el país
// entero pasa de decenas de vacantes a casi ninguna de un pique, es mucho más
// probable que se haya roto la lectura a que el MEP las haya retirado todas.
if (latido.totalPais >= 10 && todas.length < latido.totalPais / 3) {
  advertir(
    'El país pasó de ' + latido.totalPais + ' vacantes a ' + todas.length +
    '. Puede que la lectura se haya roto: revisá el sitio a mano.'
  );
}

const hayAlgoQueAvisar =
  reparto.some((r) => r.nuevas.length) || nombresNuevos.length || advertencias.length;

if (!hayAlgoQueAvisar) {
  if (horasSinLatido < LATIDO_CADA_HORAS) {
    console.log('Nada nuevo que avisar.');
    process.exit(0);
  }

  const hora = ahora.toLocaleString('es-CR', {
    timeZone: 'America/Costa_Rica',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const salio = principal && await mandarTexto(
    principal.chatId,
    '🟢 *El vigilante de vacantes sigue trabajando*\n\n' +
    'Última revisión: ' + hora + '.\n' +
    'Vacantes publicadas hoy en todo el país: ' + todas.length + '.\n' +
    'Para VT6: ninguna nueva.\n\n' +
    '_Este aviso llega cada ' + LATIDO_CADA_HORAS + ' horas para que sepas que sigue vivo. El día que deje de llegar, algo pasó._\n' +
    '👉 ' + DIRECCION
  );
  if (salio) await guardarLatido();
  process.exit(0);
}

// ── Mandar ────────────────────────────────────────────────────────────────
//
// Cada destinatario se marca por separado: si el WhatsApp de uno falla, el otro
// igual queda avisado y solo se reintenta el que no salió.
let algunoFallo = false;
let algunoSalio = false;

for (const { destino, nuevas } of reparto) {
  const extras = destino.extras && (nombresNuevos.length || advertencias.length);
  if (!nuevas.length && !extras) continue;

  const enviado = await avisar(destino, nuevas, nombresNuevos, advertencias, catalogoEstabaVacio);
  if (!enviado) {
    console.error('El aviso a ' + destino.id + ' NO salió. Queda sin marcar para reintentar.');
    algunoFallo = true;
    continue;
  }
  algunoSalio = true;

  for (const v of nuevas) estado.avisadas[destino.id][clave(v)] = ahora.toISOString();

  // Los nombres nuevos ya se avisaron: no repetirlos en cada corrida. Solo los
  // marca quien de verdad los recibió.
  if (destino.extras) {
    for (const n of nombresNuevos) {
      if (catalogo.especialidades[n.nombre]) catalogo.especialidades[n.nombre].avisadaComoNueva = true;
    }
    await guardar('estado/especialidades.json', JSON.stringify(catalogo, null, 2));
  }
}

// Limpieza: lo de hace más de 30 días ya no puede reaparecer, y sin esto el
// archivo crece para siempre.
const limite = new Date(ahora.getTime() - 30 * 24 * 60 * 60 * 1000);
for (const avisadas of Object.values(estado.avisadas)) {
  for (const [k, cuando] of Object.entries(avisadas)) {
    if (new Date(cuando) < limite) delete avisadas[k];
  }
}
await guardar('estado/avisadas.json', JSON.stringify(estado, null, 2));

// Un aviso de verdad vale como latido: no hace falta mandar además el "sigo
// trabajando" cinco minutos después.
if (algunoSalio) await guardarLatido();

if (algunoFallo) {
  console.error('Al menos un aviso no salió. La próxima corrida lo reintenta.');
  process.exit(1);
}
console.log('Avisos enviados y estado actualizado.');
