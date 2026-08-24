/* ==========================================================================
   dominio/salas.js — a sala por link, e o convidado de fora

   Regras puras. Sem banco, sem rede, sem navegador.

   ---------------------------------------------------------------------------
   O LINK É A CREDENCIAL — e isso muda tudo

   Não há login, não há convite nominal, não há lista de quem pode. Quem tiver
   a URL, entra. É assim que funciona em toda ferramenta de reunião, e é uma
   escolha consciente de conveniência sobre controle.

   As três consequências que o resto do arquivo existe para conter:

   1. O LINK VAZA COMO QUALQUER TEXTO. Encaminhado no WhatsApp, colado num
      grupo, guardado no histórico do navegador, registrado no log de um proxy.
      Por isso a sala EXPIRA e a chamada tem DURAÇÃO FIXA: o estrago de um link
      vazado é limitado no tempo, sempre.

   2. O CÓDIGO PODE SER ADIVINHADO — em tese. Ver o comentário do alfabeto: são
      58^11 combinações (~2^64). Com o freio por IP e por código, tentar é
      inviável; sem o freio, seria só demorado. O freio não é opcional.

   3. O NOME É DECLARADO PELA PRÓPRIA PESSOA. Um convidado pode digitar "Ana
      Ribeiro" e aparecer com o nome de alguém da casa. Por isso a tela marca
      convidado como convidado, sempre, e o nome passa por saneamento aqui.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");

/* ==========================================================================
   O ALFABETO — base58, o do Bitcoin

   Fora dele ficam `0`, `O`, `I` e `l`: os quatro que as pessoas confundem ao
   ler um link em voz alta ou copiar à mão de uma tela.

   58^11 = 2,9 x 10^19 combinações, ou ~2^64. Para comparação, o Google Meet
   usa 10 letras minúsculas (~2^47) e se apoia no mesmo lugar que este projeto:
   o limitador de tentativas.

   ONZE caracteres foi o pedido, e é folgado. Não diminua: cada caractere a
   menos divide o espaço por 58.
   ========================================================================== */
const ALFABETO = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TAMANHO_CODIGO = 11;

/* ==========================================================================
   GERAR

   `randomBytes`, e nunca `Math.random()`. O gerador do JavaScript é previsível
   a partir de algumas saídas — e aqui a saída É a chave da sala.

   O descarte por módulo (`rejeitar`) existe porque 256 não é múltiplo de 58:
   usar `byte % 58` direto faria os seis primeiros caracteres do alfabeto
   saírem com mais frequência que os demais. Perde-se pouca entropia por vez,
   mas é entropia perdida de graça, e num código de 11 posições isso se soma.
   ========================================================================== */
function gerarCodigo() {
  const limite = 256 - (256 % ALFABETO.length);   // 232 para 58
  let saida = "";
  while (saida.length < TAMANHO_CODIGO) {
    for (const b of crypto.randomBytes(TAMANHO_CODIGO * 2)) {
      if (b >= limite) continue;                  // descarta o viés
      saida += ALFABETO[b % ALFABETO.length];
      if (saida.length === TAMANHO_CODIGO) break;
    }
  }
  return saida;
}

const RE_CODIGO = new RegExp(`^[${ALFABETO}]{${TAMANHO_CODIGO}}$`);

/* Conferência de FORMA, antes de qualquer ida ao banco. Um código fora do
   formato nunca deveria custar uma consulta — nem virar chave de limitador,
   que é como se transforma um teclado em consumo de memória do servidor. */
const ehCodigo = (v) => typeof v === "string" && RE_CODIGO.test(v);

/* O que se guarda no banco para ACHAR a sala. O código em claro nunca é
   gravado — mesma regra do token de sessão: o banco guarda algo que serve
   para conferir, não para entrar. */
const hashDoCodigo = (codigo) =>
  crypto.createHash("sha256").update(String(codigo)).digest("hex");

/* ==========================================================================
   DURAÇÃO

   Teto de 8 horas: acima disso não é reunião, é uma sala aberta esquecida — e
   sala anônima esquecida é exatamente o que não pode existir.

   Piso de 5 minutos porque o aviso de "faltam 5 minutos" precisa caber dentro
   da reunião; abaixo disso ele dispararia antes de começar.
   ========================================================================== */
const DURACAO_MIN = 5;
const DURACAO_MAX = 8 * 60;
const DURACAO_PADRAO = 60;

/* O aviso sai quando faltam estes minutos. Cinco foi o pedido, e é o que dá
   tempo de encerrar um assunto sem interromper no meio de uma frase. */
const AVISO_MIN = 5;

/* ==========================================================================
   PRORROGAR — os minutos que o anfitrião pode acrescentar

   Uma LISTA, e não um campo livre. São os pedaços que uma reunião real
   atrasa: "só mais dois minutos", "fecho em cinco". Campo aberto convidaria a
   digitar 480 e transformar a reunião marcada numa sala permanente — que é
   justamente o que o prazo existe para impedir.

   O TETO CONTINUA VALENDO. Somadas, as prorrogações não podem passar de
   `DURACAO_MAX`: quem precisa de mais que oito horas não precisa de uma
   reunião, precisa de outra ferramenta.
   ========================================================================== */
const PRORROGACOES = [1, 2, 3, 5, 8, 10];

function validarProrrogacao(minutos) {
  const n = Math.round(Number(minutos) || 0);
  if (!PRORROGACOES.includes(n))
    return { ok: false, erro: `acrescente um destes: ${PRORROGACOES.join(", ")} minutos` };
  return { ok: true, minutos: n };
}

/* Quanto ainda cabe, respeitando o teto total da reunião. */
function cabeProrrogar(sala, minutos, agora = Date.now()) {
  const inicio = Number(sala?.iniciada_em) || agora;
  const fimAtual = Number(sala?.encerra_em) || agora;
  const totalDepois = (fimAtual + minutos * 60_000 - inicio) / 60_000;
  if (totalDepois > DURACAO_MAX)
    return { ok: false, erro: `a reunião não pode passar de ${DURACAO_MAX / 60} horas` };
  return { ok: true };
}

/* Validade do LINK, diferente da duração da chamada: o link pode valer o dia e
   a reunião durar 40 minutos. Teto de 7 dias — um link de reunião que vale um
   mês é um link que ninguém lembra que existe. */
const VALIDADE_PADRAO_H = 24;
const VALIDADE_MAX_H = 7 * 24;

function validarDuracao(minutos) {
  const n = Math.round(Number(minutos) || DURACAO_PADRAO);
  if (!Number.isFinite(n)) return { ok: false, erro: "duração inválida" };
  if (n < DURACAO_MIN)
    return { ok: false, erro: `a reunião precisa de pelo menos ${DURACAO_MIN} minutos` };
  if (n > DURACAO_MAX)
    return { ok: false, erro: `a reunião não pode passar de ${DURACAO_MAX / 60} horas` };
  return { ok: true, minutos: n };
}

function validarValidade(horas) {
  const n = Math.round(Number(horas) || VALIDADE_PADRAO_H);
  if (!Number.isFinite(n) || n < 1) return { ok: false, erro: "validade inválida" };
  if (n > VALIDADE_MAX_H)
    return { ok: false, erro: `o link não pode valer mais de ${VALIDADE_MAX_H / 24} dias` };
  return { ok: true, horas: n };
}

/* ==========================================================================
   O RELÓGIO DA SALA

   Uma função só responde tudo que a tela e o servidor precisam saber sobre o
   tempo — e como é uma função pura, o teste consegue viajar no tempo sem
   esperar uma hora.
   ========================================================================== */
function tempo(sala, agora = Date.now()) {
  const encerraEm = Number(sala?.encerra_em) || 0;
  if (!encerraEm) return { comecou: false, restanteMs: null, avisar: false, acabou: false };

  const restante = encerraEm - agora;
  return {
    comecou: true,
    restanteMs: Math.max(0, restante),
    /* O aviso vale numa JANELA, e não num instante: quem entra faltando 3
       minutos precisa ver o aviso também, e um teste de igualdade só dispararia
       para quem estivesse na tela no segundo exato. */
    avisar: restante > 0 && restante <= AVISO_MIN * 60_000,
    acabou: restante <= 0,
  };
}

/* ==========================================================================
   O NOME DO CONVIDADO — texto de estranho, tratado como tal

   Ele vai aparecer na tela de gente da casa, então passa pelo mesmo rigor de
   qualquer entrada: sem caractere de controle, sem marca de direção (o truque
   do "Trojan Source", que inverte a ordem visual do texto), sem invisível, e
   com tamanho de gente.

   O que este saneamento NÃO resolve, e nenhum resolveria: a pessoa digitar o
   nome de um colega. Isso é problema de INTERFACE — a tela marca convidado
   como convidado, sempre, e é isso que impede a confusão.
   ========================================================================== */
const CONTROLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const DIRECAO = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const INVISIVEL = /[\u200B-\u200D\uFEFF]/g;

function validarNome(bruto) {
  const limpo = String(bruto ?? "")
    .replace(CONTROLE, "")
    .replace(DIRECAO, "")
    .replace(INVISIVEL, "")
    .replace(/\s+/g, " ")
    .trim();

  if (limpo.length < 2) return { ok: false, erro: "Escreva seu nome para entrar." };
  if (limpo.length > 40) return { ok: false, erro: "O nome pode ter no máximo 40 caracteres." };

  return { ok: true, nome: limpo };
}

/* ==========================================================================
   PODE ENTRAR?

   Uma função só, para a resposta ser a mesma em toda porta — a página do link,
   a entrada de fato e a reconexão. Três lugares com a mesma pergunta e três
   respostas ligeiramente diferentes é como se ganha uma porta que aceita quem
   as outras recusam.
   ========================================================================== */
function podeEntrar(sala, { agora = Date.now(), anfitriaoPresente = false, convidadosDentro = 0 } = {}) {
  if (!sala) return { ok: false, motivo: "inexistente" };
  if (sala.estado === "revogada") return { ok: false, motivo: "revogada" };
  if (sala.estado === "encerrada") return { ok: false, motivo: "encerrada" };
  if (Number(sala.expira_em) <= agora) return { ok: false, motivo: "expirada" };

  const t = tempo(sala, agora);
  if (t.acabou) return { ok: false, motivo: "tempo_esgotado" };

  /* ======================================================================
     O ANFITRIÃO PRECISA ESTAR NA SALA — e isto não é formalidade

     Sem esta regra, duas pessoas de fora com o link conversam entre si usando
     o SEU servidor de relay, na SUA banda, sem ninguém da casa por perto e
     sem nada no registro além de dois nomes digitados. É o abuso mais barato
     que uma sala anônima permite, e o que faz um link vazado virar um serviço
     gratuito de terceiros.

     Com a regra, o link vazado só serve enquanto alguém da casa está lá — e
     nesse momento a pessoa vê quem entrou.
     ====================================================================== */
  if (sala.exige_anfitriao && !anfitriaoPresente)
    return { ok: false, motivo: "sem_anfitriao" };

  if (convidadosDentro >= Number(sala.max_convidados || 0))
    return { ok: false, motivo: "lotada" };

  return { ok: true };
}

/* As frases de recusa, num lugar só.

   Elas são DELIBERADAMENTE vagas sobre a existência da sala: "link inválido ou
   expirado" cobre inexistente, revogada e expirada com o mesmo texto. Dizer
   "esta sala existe mas foi revogada" confirmaria ao curioso que ele acertou um
   código — e é assim que se transforma tentativa e erro em mapa. */
const RECUSAS = Object.freeze({
  inexistente: "Link inválido ou expirado.",
  revogada: "Link inválido ou expirado.",
  expirada: "Link inválido ou expirado.",
  encerrada: "Esta reunião já foi encerrada.",
  tempo_esgotado: "O tempo desta reunião terminou.",
  sem_anfitriao: "A reunião ainda não começou. Aguarde o anfitrião abrir a sala.",
  lotada: "Esta reunião já está com o número máximo de participantes.",
});

module.exports = {
  ALFABETO, TAMANHO_CODIGO,
  DURACAO_MIN, DURACAO_MAX, DURACAO_PADRAO, AVISO_MIN, PRORROGACOES,
  VALIDADE_PADRAO_H, VALIDADE_MAX_H,
  gerarCodigo, ehCodigo, hashDoCodigo,
  validarDuracao, validarValidade, validarNome, validarProrrogacao, cabeProrrogar,
  tempo, podeEntrar, RECUSAS,
};
