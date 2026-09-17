// filtro.mjs
//
// Las decisiones del vigilante que no tocan la red ni el disco: qué especialidad
// le interesa a quién, y a qué destinatario le falta ver cada vacante.
//
// POR QUÉ ESTÁN APARTE: `revisar.mjs` abre un navegador y manda WhatsApp apenas
// se importa, así que no hay forma de probarlo sin hacer las dos cosas. Esto sí
// se puede probar de verdad, y es justo la parte donde un error no se ve: un
// filtro que deja de calzar no da error, solo deja de avisar. Las pruebas viven
// en `pruebas.mjs` y corren solas en cada push.

// ── El filtro: grupo profesional VT6 ──────────────────────────────────────
// Tal como aparecen en la constancia de grupos profesionales. Se comparan sin
// tildes y en mayúsculas, porque el MEP no es consistente con los acentos
// ("MATEMATICAS" y "MATEMÁTICAS" conviven en la misma tabla).
export const ESPECIALIDADES_VT6 = [
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

// Cualquier otra cosa que hable de informática se avisa igual, marcada aparte.
// Perderse una vacante cuesta muchísimo más que recibir un aviso de más: la
// ventana son 24 horas hábiles y no hay segunda oportunidad.
const PISTAS_SUELTAS = ['INFORMATIC', 'COMPUTAC', 'PROGRAMAC', 'SOFTWARE', 'REDES', 'DIGITAL'];

export const normalizar = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')  // fuera tildes
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

export const estaExcluida = (especialidad) => {
  const plano = normalizar(especialidad);
  return EXCLUIDAS.some((x) => plano.includes(x));
};

// Palabras que no distinguen nada y sí rompen las comparaciones: el MEP publica
// "Informática En Desarrollo DEL Software" y la constancia dice "DE Software".
// Comparando palabra por palabra sin el relleno, las dos son la misma cosa.
const RELLENO = new Set(['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'EN', 'PARA', 'A', 'CON', 'AL']);

export const fichas = (s) =>
  normalizar(s)
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !RELLENO.has(t));

const contieneTodas = (grandes, chicas) => chicas.every((t) => grandes.includes(t));

// Devuelve 'exacta' | 'posible' | null
export const clasificar = (especialidad) => {
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

// ── Matemáticas, para el segundo destinatario ─────────────────────────────
// El MEP escribe la especialidad de varias formas ("Matemáticas", "Matematica",
// "Matemáticas / Matemáticas"), así que se compara sin tildes y por contenido.
export const esMatematicas = (especialidad) => normalizar(especialidad).includes('MATEMATIC');

// ── Comparar el menú con la tabla ─────────────────────────────────────────
// El texto del menú y el de la tabla no calzan letra por letra: el menú dice
// "Regional Educación Alajuela" y la tabla "Direc. Regional Educacion Alajuela".
// Se comparan sin tildes, sin espacios y sin puntuación, y alcanza con que el de
// la tabla contenga al del menú.
export const comoClave = (t) => normalizar(t).replace(/[^A-Z0-9]/g, '');

// ── Memoria de lo avisado, por destinatario ───────────────────────────────
// La misma vacante puede estar avisada para uno y pendiente para el otro: con
// una sola lista compartida, el segundo destinatario se perdería todo lo que el
// primero ya recibió.
export const claveVacante = (v) => v.regional + '|' + v.vacante;

// El archivo nació con una sola lista plana, de cuando había un solo
// destinatario. Se mueve bajo "principal" para no volver a avisar lo viejo.
export const migrarAvisadas = (avisadas, destinos) => {
  const salida = Object.values(avisadas).some((v) => typeof v === 'string')
    ? { principal: avisadas }
    : { ...avisadas };
  for (const d of destinos) salida[d.id] = salida[d.id] || {};
  return salida;
};

// Para cada destinatario: qué le tocaría y qué de eso todavía no ha visto.
export const repartir = (destinos, todas, interesantes, avisadas) =>
  destinos.map((destino) => {
    const suyas = destino.filtro
      ? todas.filter((v) => destino.filtro(v.especialidad)).map((v) => ({ ...v, calce: 'exacta' }))
      : interesantes;
    return { destino, nuevas: suyas.filter((v) => !avisadas[destino.id][claveVacante(v)]) };
  });
