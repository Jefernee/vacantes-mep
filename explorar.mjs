// explorar.mjs
//
// PARA QUÉ SIRVE: abrir https://apps.mep.go.cr/formulario con un navegador de
// verdad y guardar en disco todo lo que se ve, para poder escribir después el
// vigilante que lea las vacantes.
//
// POR QUÉ HACE FALTA UN NAVEGADOR: esa página es una app Blazor Server. El HTML
// que manda el servidor son 4 KB de cascarón vacío; la lista de vacantes la va
// dibujando en vivo por una conexión WebSocket. Un `curl` o un `http.get` no ve
// nada — hace falta algo que ejecute el JavaScript y espere el dibujado.
//
// CÓMO SE CORRE (una sola vez, en la carpeta vacantes-mep):
//   npm install
//   npx playwright install chromium
//   node explorar.mjs
//
// QUÉ DEJA en la carpeta salida/:
//   pantalla.png    — foto de la página, para ver con qué nos topamos
//   texto.txt       — todo el texto visible
//   render.html     — el HTML YA dibujado (distinto al que manda el servidor)
//   estructura.json — los menús, botones y tablas que encontró, con sus opciones
//
// Nada de esto manda WhatsApp ni escribe en ninguna base. Solo mira y anota.

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const DIRECCION = 'https://apps.mep.go.cr/formulario';

// OJO: no llamar URL a nada acá. Ese nombre es el del constructor global que se
// usa dos líneas abajo, y taparlo hace fallar el arranque con "URL is not a
// constructor" antes de abrir el navegador.
const SALIDA = new URL('./salida/', import.meta.url);

const guardar = async (nombre, contenido) => {
  const ruta = new URL(nombre, SALIDA);
  await writeFile(ruta, contenido);
  console.log('  guardado: salida/' + nombre);
};

console.log('Abriendo el navegador...');
const navegador = await chromium.launch({ headless: true });

// Un user-agent de navegador normal: los sitios del MEP filtran lo que no lo parece.
const contexto = await navegador.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 2200 },
  locale: 'es-CR',
});
const pagina = await contexto.newPage();

// Anotamos las peticiones que hace la página. Si por casualidad pide los datos a
// alguna API normal, ahí va a aparecer — y entonces nos ahorramos el navegador.
const peticiones = [];
pagina.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith('data:') && !/\.(png|jpe?g|svg|woff2?|ttf|ico|css)(\?|$)/i.test(u)) {
    peticiones.push(r.method() + ' ' + u);
  }
});
pagina.on('websocket', (ws) => peticiones.push('WEBSOCKET ' + ws.url()));

console.log('Cargando ' + DIRECCION + ' ...');
// domcontentloaded y no networkidle: Blazor deja un WebSocket abierto y la red
// nunca queda del todo quieta. La espera de verdad es la de abajo.
await pagina.goto(DIRECCION, { waitUntil: 'domcontentloaded', timeout: 90000 });

// Blazor conecta el WebSocket y DESPUÉS dibuja. `networkidle` no lo espera, así
// que le damos unos segundos de gracia antes de mirar.
console.log('Esperando a que Blazor dibuje...');
await pagina.waitForTimeout(8000);

console.log('Anotando lo que hay:');
await guardar('pantalla.png', await pagina.screenshot({ fullPage: true }));
await guardar('texto.txt', await pagina.innerText('body'));
await guardar('render.html', await pagina.content());

// Los controles con los que habrá que interactuar (elegir regional, buscar, etc.)
// y las tablas, que es donde deberían estar las vacantes.
const estructura = await pagina.evaluate(() => {
  const texto = (el) => (el.innerText || el.textContent || '').trim().slice(0, 120);

  const selects = [...document.querySelectorAll('select')].map((s) => ({
    nombre: s.name || s.id || '(sin nombre)',
    opciones: [...s.options].map((o) => o.text.trim()).slice(0, 40),
  }));

  // MudBlazor (la librería que usa esta app) no usa <select> nativo: sus menús
  // son divs. Por eso buscamos también por sus clases.
  const mud = [...document.querySelectorAll('.mud-select, .mud-input-control, .mud-expansion-panel')]
    .map(texto)
    .filter(Boolean)
    .slice(0, 30);

  const botones = [...document.querySelectorAll('button, a.mud-button-root, [role="button"]')]
    .map(texto)
    .filter(Boolean)
    .slice(0, 40);

  const tablas = [...document.querySelectorAll('table')].map((t) => ({
    encabezados: [...t.querySelectorAll('th')].map((h) => h.innerText.trim()),
    filas: t.querySelectorAll('tbody tr').length,
    primeraFila: [...(t.querySelector('tbody tr')?.cells || [])].map((c) => c.innerText.trim()),
  }));

  return {
    titulo: document.title,
    selects,
    controlesMud: mud,
    botones,
    tablas,
    largoTextoVisible: (document.body.innerText || '').length,
  };
});

estructura.peticiones = peticiones;
await guardar('estructura.json', JSON.stringify(estructura, null, 2));

await navegador.close();

console.log('');
console.log('Listo. Resumen:');
console.log('  título:', estructura.titulo);
console.log('  texto visible:', estructura.largoTextoVisible, 'caracteres');
console.log('  menús <select>:', estructura.selects.length);
console.log('  controles MudBlazor:', estructura.controlesMud.length);
console.log('  botones:', estructura.botones.length);
console.log('  tablas:', estructura.tablas.length);
console.log('');
console.log('Los archivos quedaron en vacantes-mep/salida/');
