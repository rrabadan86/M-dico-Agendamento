require('./ambiente');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arquivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'metricas-')), 'metricas.json');
process.env.METRICAS_ARQUIVO = arquivo;
const metricas = require('../src/metricas');

/** requisição de mentira: só o que o módulo olha. */
const visitante = (ip, navegador = 'Mozilla/5.0 (iPhone)') => ({
  headers: { 'user-agent': navegador, 'x-forwarded-for': ip },
  socket: { remoteAddress: ip },
});

const DIA = new Date('2026-08-24T15:00:00Z');       // 12:00 em Brasília

beforeEach(() => {
  metricas._limpar();
  try { fs.unlinkSync(arquivo); } catch { /* ainda não existe */ }
});

test('visita conta, e a mesma pessoa voltando não vira visitante novo', () => {
  metricas.registrarVisita(visitante('1.1.1.1'), DIA);
  metricas.registrarVisita(visitante('1.1.1.1'), DIA);
  metricas.registrarVisita(visitante('2.2.2.2'), DIA);

  const { hoje } = metricas.resumo(1, DIA);
  assert.equal(hoje.visitas, 3);
  assert.equal(hoje.unicos, 2);
});

test('o mesmo IP com navegador diferente é outra pessoa', () => {
  // é o caso do consultório: várias pessoas atrás da mesma internet
  metricas.registrarVisita(visitante('1.1.1.1', 'Chrome/1'), DIA);
  metricas.registrarVisita(visitante('1.1.1.1', 'Safari/2'), DIA);
  assert.equal(metricas.resumo(1, DIA).hoje.unicos, 2);
});

test('robô não entra na conta', () => {
  metricas.registrarVisita(visitante('3.3.3.3', 'Googlebot/2.1'), DIA);
  metricas.registrarVisita(visitante('4.4.4.4', 'WhatsApp/2.23'), DIA);
  metricas.registrarVisita(visitante('5.5.5.5', 'facebookexternalhit/1.1'), DIA);
  metricas.registrarVisita(visitante('6.6.6.6'), DIA);

  const { hoje } = metricas.resumo(1, DIA);
  assert.equal(hoje.visitas, 1, 'só a pessoa de verdade');
  assert.equal(hoje.unicos, 1);
});

test('o funil separa quem entrou, quem olhou horários e quem agendou', () => {
  const ana = visitante('1.1.1.1', 'Chrome/ana');
  const bia = visitante('2.2.2.2', 'Chrome/bia');
  const caio = visitante('3.3.3.3', 'Chrome/caio');

  [ana, bia, caio].forEach((v) => metricas.registrarVisita(v, DIA));
  metricas.registrarInteresse(ana, DIA);
  metricas.registrarInteresse(ana, DIA);          // clicou em vários dias
  metricas.registrarInteresse(bia, DIA);
  metricas.registrarAgendamento('h1', DIA);

  const { hoje } = metricas.resumo(1, DIA);
  assert.equal(hoje.unicos, 3);
  assert.equal(hoje.interessados, 2, 'ana e bia, ana uma vez só');
  assert.equal(hoje.agendamentos, 1);
});

test('conversão é sobre visitantes, não sobre visitas', () => {
  const ana = visitante('1.1.1.1', 'Chrome/ana');
  metricas.registrarVisita(ana, DIA);
  metricas.registrarVisita(ana, DIA);
  metricas.registrarVisita(ana, DIA);
  metricas.registrarVisita(visitante('2.2.2.2', 'Chrome/bia'), DIA);
  metricas.registrarAgendamento('h1', DIA);

  const { hoje } = metricas.resumo(1, DIA);
  assert.equal(hoje.visitas, 4);
  assert.equal(hoje.unicos, 2);
  assert.equal(hoje.conversao, 50, '1 agendamento para 2 pessoas');
});

test('agendamentos são separados por local', () => {
  metricas.registrarAgendamento('h1', DIA);
  metricas.registrarAgendamento('h2', DIA);
  metricas.registrarAgendamento('h1', DIA);
  assert.deepEqual(metricas.resumo(1, DIA).dias[0].porLocal, { h1: 2, h2: 1 });
});

test('dia sem movimento aparece zerado, não some da série', () => {
  metricas.registrarVisita(visitante('1.1.1.1'), new Date('2026-08-22T15:00:00Z'));
  metricas.registrarVisita(visitante('1.1.1.1'), DIA);

  const { dias } = metricas.resumo(3, DIA);
  assert.deepEqual(dias.map((d) => d.dia), ['2026-08-22', '2026-08-23', '2026-08-24']);
  assert.equal(dias[1].visitas, 0, 'o dia 23 existe e está zerado');
});

test('cada dia tem a sua própria conta de visitantes', () => {
  const ana = visitante('1.1.1.1', 'Chrome/ana');
  metricas.registrarVisita(ana, new Date('2026-08-23T15:00:00Z'));
  metricas.registrarVisita(ana, DIA);

  const { dias, total } = metricas.resumo(2, DIA);
  assert.equal(dias[0].unicos, 1);
  assert.equal(dias[1].unicos, 1);
  assert.equal(total.visitas, 2);
});

test('o que foi contado sobrevive ao reinício do servidor', () => {
  metricas.registrarVisita(visitante('1.1.1.1'), DIA);
  metricas.registrarAgendamento('h1', DIA);
  metricas._gravarAgora();

  metricas._limpar();                              // como se o processo tivesse caído
  const { hoje } = metricas.resumo(1, DIA);
  assert.equal(hoje.visitas, 1);
  assert.equal(hoje.agendamentos, 1);
});

test('arquivo corrompido não derruba o servidor', () => {
  fs.writeFileSync(arquivo, '{ isto não é json', 'utf8');
  metricas._limpar();
  assert.doesNotThrow(() => metricas.registrarVisita(visitante('1.1.1.1'), DIA));
  assert.equal(metricas.resumo(1, DIA).hoje.visitas, 1);
});

test('nem o IP nem o navegador ficam gravados', () => {
  metricas.registrarVisita(visitante('187.45.200.13', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), DIA);
  metricas._gravarAgora();

  const bruto = fs.readFileSync(arquivo, 'utf8');
  assert.ok(!bruto.includes('187.45.200.13'), 'IP não pode estar no arquivo');
  assert.ok(!bruto.includes('iPhone'), 'navegador não pode estar no arquivo');
});

test('o que estava para gravar não se perde no restart do pm2', () => {
  // a gravação é adiada 1s e o timer é unref: sem o descarregar(), todo
  // `pm2 restart` jogaria fora as contagens do último segundo
  metricas.registrarVisita(visitante('1.1.1.1'), DIA);
  assert.ok(!fs.existsSync(arquivo), 'ainda não foi para o disco');

  metricas.descarregar();
  assert.ok(fs.existsSync(arquivo), 'o desligamento força a gravação');

  metricas._limpar();
  assert.equal(metricas.resumo(1, DIA).hoje.visitas, 1);
});

test('descarregar sem nada pendente não faz nada', () => {
  assert.doesNotThrow(() => metricas.descarregar());
  assert.ok(!fs.existsSync(arquivo));
});

test('dias anteriores ao início da contagem são marcados como não medidos', () => {
  // é a diferença entre "ninguém entrou" e "não estávamos contando" — sem
  // ela, a tela afirma um mês de movimento zero que nunca foi observado
  metricas.registrarVisita(visitante('1.1.1.1'), DIA);

  const { dias, desde } = metricas.resumo(30, DIA);
  assert.equal(desde, '2026-08-24');
  assert.equal(dias.filter((d) => d.medido).length, 1);
  assert.equal(dias.filter((d) => !d.medido).length, 29);
  assert.equal(dias[dias.length - 1].medido, true, 'hoje é medido');
});

test('arquivo antigo, sem o marco, adota o dia mais velho que tem', () => {
  fs.writeFileSync(arquivo, JSON.stringify({
    '2026-08-20': { visitas: 3, unicos: 2, interessados: 1, agendamentos: 0, porLocal: {}, digitais: [], viramGrade: [] },
    '2026-08-24': { visitas: 1, unicos: 1, interessados: 0, agendamentos: 0, porLocal: {}, digitais: [], viramGrade: [] },
  }), 'utf8');
  metricas._limpar();

  const { dias, desde } = metricas.resumo(10, DIA);
  assert.equal(desde, '2026-08-20');
  assert.equal(dias.find((d) => d.dia === '2026-08-19').medido, false);
  assert.equal(dias.find((d) => d.dia === '2026-08-22').medido, true, 'dia sem visita, mas já medido');
});

test('o marco não é confundido com um dia', () => {
  metricas.registrarVisita(visitante('1.1.1.1'), DIA);
  metricas._gravarAgora();
  metricas._limpar();

  const { dias, total } = metricas.resumo(3, DIA);
  assert.equal(dias.length, 3, 'a chave "desde" não vira uma coluna');
  assert.equal(total.visitas, 1);
});
