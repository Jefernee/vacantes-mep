// pruebas.mjs
//
// Se corren con `node --test` (o `npm test`), y solas en cada push.
//
// QUÉ SE PRUEBA Y POR QUÉ: lo de `filtro.mjs`, que es donde un error no se ve.
// Si el navegador se rompe, la corrida sale en rojo y llega el WhatsApp de "se
// cayó". Si el filtro deja de calzar, o una vacante se reparte al destinatario
// equivocado, NO pasa nada visible: simplemente no llega el aviso, y eso solo se
// nota cuando ya se venció la vacante. Por eso las pruebas están acá y no en la
// parte del navegador.
//
// Los textos de las especialidades y de las regionales son los de verdad,
// copiados de lo que publica el MEP.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clasificar,
  esMatematicas,
  comoClave,
  claveVacante,
  migrarAvisadas,
  repartir,
} from './filtro.mjs';

// ── El filtro VT6 ─────────────────────────────────────────────────────────

test('calza las especialidades tal como las escribe el MEP', () => {
  assert.equal(clasificar('Ciberseguridad'), 'exacta');
  assert.equal(clasificar('Desarrollo Web'), 'exacta');
  assert.equal(clasificar('Inteligencia Artificial'), 'exacta');
  // Con tildes y en otra caja: el MEP mezcla las dos formas en la misma tabla.
  assert.equal(clasificar('CONFIGURACIÓN Y SOPORTE A REDES DE COMUNICACIÓN Y SISTEMAS OPERATIVOS'), 'exacta');
});

test('el relleno no rompe el calce: "DEL Software" es "DE Software"', () => {
  assert.equal(clasificar('Informática En Desarrollo Del Software'), 'exacta');
  assert.equal(clasificar('Informatica en Desarrollo de Software'), 'exacta');
});

test('Informática Educativa NO se avisa, aunque suene a informática', () => {
  // Es otro grupo profesional: avisar de esto enseña a ignorar los mensajes.
  assert.equal(clasificar('Informática Educativa .Informática Para Iii Y Iv Ciclos'), null);
  assert.equal(clasificar('Informatica Educativa I Y Ii Ciclos'), null);
});

test('lo que suena a informática pero no está en la constancia sale como "posible"', () => {
  // Vale un aviso de más: perderse una vacante cuesta muchísimo más.
  assert.equal(clasificar('Gtic / Ingenieria De Software'), 'posible');
  assert.equal(clasificar('Gtic / Gestion De Infraestructura'), null);
  assert.equal(clasificar('Seguridad Digital'), 'posible');
});

test('lo que no tiene nada que ver no se avisa', () => {
  for (const ajena of ['Español', 'Música/Música', 'Psicología', 'Turismo Generalista', 'Religión', '']) {
    assert.equal(clasificar(ajena), null, ajena + ' no debería calzar');
  }
});

// ── El filtro de matemáticas, para el segundo destinatario ────────────────

test('matemáticas calza escrito de cualquier forma', () => {
  for (const forma of ['Matemáticas', 'MATEMATICAS', 'Matematica', 'Matemáticas / Matemáticas', 'Enseñanza De Las Matemáticas']) {
    assert.equal(esMatematicas(forma), true, forma + ' debería ser matemáticas');
  }
});

test('matemáticas no se lleva lo que no es suyo', () => {
  for (const ajena of ['Español', 'Ciberseguridad', 'Física', 'Informática Empresarial', '']) {
    assert.equal(esMatematicas(ajena), false, ajena + ' no debería ser matemáticas');
  }
});

// ── Menú contra tabla ─────────────────────────────────────────────────────

test('el texto del menú calza con el de la tabla aunque estén escritos distinto', () => {
  // Pares reales: a la izquierda lo que dice el <select>, a la derecha lo que
  // termina apareciendo en la columna "Dirección Regional".
  const pares = [
    ['Regional Educación Alajuela', 'Direc. Regional Educacion Alajuela'],
    ['Regional Educación Cañas', 'Direc. Regional Educacion Cañas'],
    ['Regional Educación San Jose - Norte', 'Direc. Regional Educacion San Jose - Norte'],
    ['Regional Educación Central Del Pacífico', 'Direc. Regional Educacion Central Del Pacífico'],
    ['Administracion De Recursos Humanos', 'Administracion De Recursos Humanos'],
  ];
  for (const [menu, tabla] of pares) {
    assert.ok(comoClave(tabla).includes(comoClave(menu)), menu + ' debería calzar con ' + tabla);
  }
});

test('la tabla de OTRA regional no se da por buena', () => {
  // Esta es la prueba del fallo silencioso del 17/09/2026: se leía la tabla de
  // la regional anterior y se contaban sus vacantes como si fueran de esta.
  assert.ok(!comoClave('Direc. Regional Educacion Occidente').includes(comoClave('Regional Educación Puriscal')));
  assert.ok(!comoClave('Cargando..').includes(comoClave('Regional Educación Heredia')));
});

// ── El reparto entre destinatarios ────────────────────────────────────────

const vacante = (vacante, especialidad) => ({
  vacante,
  especialidad,
  regional: 'Direc. Regional Educacion San Carlos',
});

const PRINCIPAL = { id: 'principal', etiqueta: 'VT6', chatId: 'a', filtro: null, extras: true };
const MATE = { id: 'matematicas', etiqueta: 'Matemáticas', chatId: 'b', filtro: esMatematicas, extras: false };

const escenario = (destinos, avisadasCrudas = {}) => {
  const todas = [
    vacante('1', 'Ciberseguridad'),
    vacante('2', 'Matemáticas'),
    vacante('3', 'Español'),
  ];
  const interesantes = todas
    .map((v) => ({ ...v, calce: clasificar(v.especialidad) }))
    .filter((v) => v.calce);
  const avisadas = migrarAvisadas(avisadasCrudas, destinos);
  return { todas, interesantes, avisadas, reparto: repartir(destinos, todas, interesantes, avisadas) };
};

test('cada destinatario recibe solo lo suyo', () => {
  const { reparto } = escenario([PRINCIPAL, MATE]);

  const principal = reparto.find((r) => r.destino.id === 'principal');
  assert.deepEqual(principal.nuevas.map((v) => v.especialidad), ['Ciberseguridad']);

  const mate = reparto.find((r) => r.destino.id === 'matematicas');
  assert.deepEqual(mate.nuevas.map((v) => v.especialidad), ['Matemáticas']);
});

test('lo ya avisado a uno no se le quita al otro', () => {
  // La de matemáticas ya la vio el principal; el de matemáticas nunca la vio.
  const yaAvisadas = { principal: { 'Direc. Regional Educacion San Carlos|2': '2026-09-17T00:00:00.000Z' } };
  const { reparto } = escenario([PRINCIPAL, MATE], yaAvisadas);

  const mate = reparto.find((r) => r.destino.id === 'matematicas');
  assert.equal(mate.nuevas.length, 1, 'al de matemáticas todavía le falta verla');
});

test('no se repite lo que ese destinatario ya recibió', () => {
  const yaAvisadas = { matematicas: { 'Direc. Regional Educacion San Carlos|2': '2026-09-17T00:00:00.000Z' } };
  const { reparto } = escenario([PRINCIPAL, MATE], yaAvisadas);

  const mate = reparto.find((r) => r.destino.id === 'matematicas');
  assert.equal(mate.nuevas.length, 0);
});

test('sin el número de matemáticas configurado, todo sigue como antes', () => {
  const { reparto } = escenario([PRINCIPAL]);
  assert.equal(reparto.length, 1);
  assert.deepEqual(reparto[0].nuevas.map((v) => v.especialidad), ['Ciberseguridad']);
});

test('el formato viejo de avisadas.json se migra sin reavisar nada', () => {
  // Antes era una sola lista plana, de cuando había un solo destinatario.
  const viejo = { 'Direc. Regional Educacion San Carlos|1': '2026-09-10T00:00:00.000Z' };
  const migrado = migrarAvisadas(viejo, [PRINCIPAL, MATE]);

  assert.equal(migrado.principal[claveVacante(vacante('1', 'x'))], '2026-09-10T00:00:00.000Z');
  assert.deepEqual(migrado.matematicas, {});

  const { reparto } = escenario([PRINCIPAL, MATE], viejo);
  const principal = reparto.find((r) => r.destino.id === 'principal');
  assert.equal(principal.nuevas.length, 0, 'lo viejo no se vuelve a avisar');
});

test('migrar dos veces no rompe nada', () => {
  const viejo = { 'algo|1': '2026-09-10T00:00:00.000Z' };
  const una = migrarAvisadas(viejo, [PRINCIPAL, MATE]);
  const dos = migrarAvisadas(una, [PRINCIPAL, MATE]);
  assert.deepEqual(dos, una);
});
