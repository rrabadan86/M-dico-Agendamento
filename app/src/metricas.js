/**
 * metricas.js — quantas pessoas entraram, quantas agendaram.
 *
 * Contagem própria em vez de Google Analytics, por três motivos:
 *
 *  1. É um site de oncologia. Quem visita muitas vezes acabou de receber um
 *     diagnóstico. Mandar esse tráfego para um terceiro que cruza com o resto
 *     do perfil da pessoa é o tipo de coisa que a LGPD trata como dado
 *     sensível — e que ninguém precisa fazer para saber quantas visitas teve.
 *  2. Sem cookie, sem banner de consentimento.
 *  3. O servidor já vê toda requisição. O que falta é só contar.
 *
 * O que fica gravado é um número por dia, nunca uma linha por pessoa. Para
 * separar "visitas" de "visitantes" é preciso reconhecer quem repete, e para
 * isso guarda-se um hash curto de IP + navegador — com um sal que muda todo
 * dia, e nunca o IP em si. Na virada do dia o sal antigo some e os hashes de
 * ontem viram números sem volta: dá para contar, não dá para seguir alguém.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const t = require('./tempo');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = process.env.METRICAS_ARQUIVO || path.join(RAIZ, 'dados', 'metricas.json');

/** Quantos dias de histórico manter. Um ano é mais que suficiente. */
const DIAS_GUARDADOS = 400;

/** Teto de visitantes distintos por dia, para o arquivo não crescer sem limite. */
const TETO_DIGITAIS = 5000;

/**
 * Robô não é gente. Sem este filtro o número mais alto do painel seria a
 * prévia de link do WhatsApp: cada vez que alguém manda o endereço numa
 * conversa, o servidor da Meta abre a página para montar o cartãozinho.
 */
const ROBOS = /bot|crawl|spider|slurp|bingpreview|facebookexternal|whatsapp|telegram|preview|monitor|curl|wget|headless|python-requests|lighthouse/i;

const vazio = () => ({
  visitas: 0,          // páginas abertas
  unicos: 0,           // pessoas distintas
  interessados: 0,     // pessoas que chegaram a pedir horários
  agendamentos: 0,     // pré-agendamentos criados
  porLocal: {},        // agendamentos por hospital
  digitais: [],        // hashes do dia (só para contar sem repetir)
  viramGrade: [],      // hashes de quem pediu horários
});

let cache = null;
let salDoDia = { dia: null, valor: null };

function ler() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    if (!cache || typeof cache !== 'object') cache = {};
  } catch {
    cache = {};                       // primeira execução, ou arquivo corrompido
  }
  return cache;
}

function gravar() {
  try {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    const temporario = `${ARQUIVO}.${process.pid}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(cache), 'utf8');
    fs.renameSync(temporario, ARQUIVO);        // troca atômica
  } catch (e) {
    // medição nunca pode derrubar o agendamento: falhou, perde-se a contagem
    console.error('[metricas] não consegui gravar:', e.message);
  }
}

/**
 * Grava no máximo uma vez por segundo.
 *
 * Contar acontece a cada visita; escrever a cada visita seria bater no disco
 * à toa. O `unref` evita que este timer segure o processo no ar.
 */
let pendente = null;
function agendarGravacao() {
  if (pendente) return;
  pendente = setTimeout(() => { pendente = null; gravar(); }, 1000);
  if (pendente.unref) pendente.unref();
}

function diaDe(agora) {
  return t.hoje(agora);                        // AAAA-MM-DD no fuso de Brasília
}

function doDia(dia) {
  const dados = ler();
  if (!dados[dia]) {
    dados[dia] = vazio();
    podar(dados);
  }
  return dados[dia];
}

function podar(dados) {
  const dias = Object.keys(dados).sort();
  while (dias.length > DIAS_GUARDADOS) delete dados[dias.shift()];
}

/**
 * Identificador de um visitante, válido só hoje.
 *
 * O sal é sorteado uma vez por dia e vive na memória. Quem reiniciar o
 * servidor no meio do dia recomeça o sal — os visitantes já contados podem
 * ser contados de novo. É um erro para cima, pequeno, e o preço de não
 * guardar nada que identifique alguém.
 */
function digital(req, dia) {
  if (salDoDia.dia !== dia) {
    salDoDia = { dia, valor: crypto.randomBytes(16).toString('hex') };
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || '';
  const navegador = req.headers['user-agent'] || '';
  return crypto.createHash('sha256')
    .update(`${salDoDia.valor}|${ip}|${navegador}`)
    .digest('hex')
    .slice(0, 12);
}

const ehRobo = (req) => ROBOS.test(req.headers['user-agent'] || '');

/** Marca a digital numa lista, respeitando o teto. Diz se era nova. */
function anotarDigital(lista, marca) {
  if (lista.includes(marca)) return false;
  if (lista.length >= TETO_DIGITAIS) return true;    // conta, mas não guarda mais
  lista.push(marca);
  return true;
}

function registrarVisita(req, agora = new Date()) {
  if (ehRobo(req)) return;
  const dia = diaDe(agora);
  const d = doDia(dia);
  d.visitas += 1;
  if (anotarDigital(d.digitais, digital(req, dia))) d.unicos += 1;
  agendarGravacao();
}

/** Pediu a grade de horários: passou de quem só olhou para quem cogitou. */
function registrarInteresse(req, agora = new Date()) {
  if (ehRobo(req)) return;
  const dia = diaDe(agora);
  const d = doDia(dia);
  if (anotarDigital(d.viramGrade, digital(req, dia))) d.interessados += 1;
  agendarGravacao();
}

function registrarAgendamento(hospitalId, agora = new Date()) {
  const d = doDia(diaDe(agora));
  d.agendamentos += 1;
  const chave = String(hospitalId || 'desconhecido');
  d.porLocal[chave] = (d.porLocal[chave] || 0) + 1;
  agendarGravacao();
}

/**
 * Os últimos `dias` dias, do mais antigo para o mais novo, sem buracos:
 * dia sem movimento entra zerado, senão o gráfico mente sobre a frequência.
 */
function resumo(dias = 30, agora = new Date()) {
  const dados = ler();
  const hoje = diaDe(agora);
  const linhas = [];
  for (let i = dias - 1; i >= 0; i -= 1) {
    const dia = t.somarDias(hoje, -i);
    const d = dados[dia] || vazio();
    linhas.push({
      dia,
      visitas: d.visitas,
      unicos: d.unicos,
      interessados: d.interessados,
      agendamentos: d.agendamentos,
      porLocal: { ...d.porLocal },
    });
  }
  return { dias: linhas, total: somar(linhas), hoje: somar(linhas.slice(-1)) };
}

function somar(linhas) {
  const total = linhas.reduce((acc, l) => ({
    visitas: acc.visitas + l.visitas,
    unicos: acc.unicos + l.unicos,
    interessados: acc.interessados + l.interessados,
    agendamentos: acc.agendamentos + l.agendamentos,
  }), { visitas: 0, unicos: 0, interessados: 0, agendamentos: 0 });

  // "de cada 100 pessoas que entraram, quantas agendaram" — sobre visitantes,
  // não sobre visitas: quem abre a página três vezes é uma pessoa só.
  total.conversao = total.unicos ? Math.round((total.agendamentos / total.unicos) * 1000) / 10 : 0;
  return total;
}

/**
 * Grava o que ainda não foi para o disco antes do processo morrer.
 *
 * A gravação é adiada em 1 segundo para não bater no disco a cada visita, e o
 * timer é `unref` — ou seja, não segura o processo no ar. Sem isto, todo
 * `pm2 restart` (e são vários, a cada atualização) descartaria as contagens
 * do último segundo.
 */
function descarregar() {
  if (!pendente) return;
  clearTimeout(pendente);
  pendente = null;
  gravar();
}
for (const sinal of ['SIGINT', 'SIGTERM', 'beforeExit']) process.on(sinal, descarregar);

/** Só para teste: esquece o que está em memória. */
function _limpar() {
  cache = null;
  salDoDia = { dia: null, valor: null };
  if (pendente) { clearTimeout(pendente); pendente = null; }
}

module.exports = {
  ARQUIVO, registrarVisita, registrarInteresse, registrarAgendamento, resumo,
  descarregar, _limpar, _gravarAgora: gravar,
};
