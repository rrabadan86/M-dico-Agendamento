require('./ambiente');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

/* whatsapp-web.js de mentira: o que interessa é como o número vira endereço. */
const registrados = new Set();
const consultados = [];
const clienteFalso = {
  async getNumberId(numero) {
    consultados.push(numero);
    return registrados.has(numero) ? { _serialized: `${numero}@c.us` } : null;
  },
  async sendMessage(destino, texto) { return { destino, texto }; },
  info: null,   // preenchido nos testes que precisam do número da sessão
};

const caminho = require.resolve('whatsapp-web.js');
require.cache[caminho] = {
  id: caminho, filename: caminho, loaded: true, children: [], paths: [],
  exports: { Client: class {}, LocalAuth: class {} },
};

process.env.WA_DRIVER = 'wwebjs';
const driver = require('../src/whatsapp/wwebjs');

driver._usarCliente(clienteFalso);

beforeEach(() => { registrados.clear(); consultados.length = 0; });

test('número registrado vira o endereço que o WhatsApp devolveu', async () => {
  registrados.add('5562981718205');
  const endereco = await driver.enderecoDe('5562981718205');
  assert.equal(endereco, '5562981718205@c.us');
});

test('linha antiga sem o nono dígito é encontrada na segunda tentativa', async () => {
  registrados.add('556281718205');                      // sem o 9
  const endereco = await driver.enderecoDe('5562981718205');
  assert.equal(endereco, '556281718205@c.us');
  assert.deepEqual(consultados, ['5562981718205', '556281718205']);
});

test('número sem WhatsApp explica o problema em vez de falhar seco', async () => {
  await assert.rejects(
    () => driver.enderecoDe('5562900000000'),
    (e) => /não foi encontrado no WhatsApp/.test(e.message) && /55 \+ DDD/.test(e.message)
  );
});

test('número vazio nem consulta o WhatsApp', async () => {
  await assert.rejects(() => driver.enderecoDe('  '), /vazio/);
  assert.equal(consultados.length, 0);
});

test('a máscara do número é ignorada', async () => {
  registrados.add('5562981718205');
  assert.equal(await driver.enderecoDe('+55 (62) 98171-8205'), '5562981718205@c.us');
});

test('o próprio número da sessão não passa pelo getNumberId', async () => {
  // é o caso do consultório com um aparelho só: a sessão e o telefone da
  // recepção são a mesma linha. O getNumberId devolve nulo para o próprio
  // wid, e antes disso o envio morria com "não foi encontrado no WhatsApp".
  clienteFalso.info = { wid: { user: '5562981718205', _serialized: '5562981718205@c.us' } };
  assert.equal(await driver.enderecoDe('(62) 98171-8205'), '5562981718205@c.us');
  assert.deepEqual(consultados, []);
  clienteFalso.info = null;
});

test('a sessão é reconhecida mesmo se cadastrada sem o nono dígito', async () => {
  clienteFalso.info = { wid: { user: '5562981718205', _serialized: '5562981718205@c.us' } };
  assert.equal(await driver.enderecoDe('556281718205'), '5562981718205@c.us');
  assert.deepEqual(consultados, []);
  clienteFalso.info = null;
});

test('linha cadastrada sem o 9 é achada com o 9', async () => {
  registrados.add('5562981718205');                     // no WhatsApp, com o 9
  const endereco = await driver.enderecoDe('556281718205');   // cadastrada sem
  assert.equal(endereco, '5562981718205@c.us');
  assert.deepEqual(consultados, ['556281718205', '5562981718205']);
});

test('número de outra pessoa continua sendo consultado', async () => {
  clienteFalso.info = { wid: { user: '5562981718205', _serialized: '5562981718205@c.us' } };
  registrados.add('5562999998888');
  assert.equal(await driver.enderecoDe('5562999998888'), '5562999998888@c.us');
  assert.ok(consultados.includes('5562999998888'));
  clienteFalso.info = null;
});

test('número cadastrado sem o código do país é encontrado assim mesmo', async () => {
  registrados.add('5562981718205');
  assert.equal(await driver.enderecoDe('(62) 98171-8205'), '5562981718205@c.us');
  assert.deepEqual(consultados, ['62981718205', '5562981718205']);
});
