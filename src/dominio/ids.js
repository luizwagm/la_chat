/* ==========================================================================
   ids.js — ULID

   POR QUE NÃO AUTOINCREMENTO
   Id sequencial é um convite à enumeração (§17): sabendo que existe a mensagem
   1042, sabe-se que existem a 1041 e a 1043, e cada uma vira um pedido para
   testar se a autorização falha. O ULID não dá esse mapa. (A autorização é
   conferida de qualquer jeito — mas não se deve entregar a lista de alvos.)

   POR QUE NÃO UUIDv4
   UUIDv4 é aleatório puro, então ids próximos no tempo caem em lugares
   distantes do índice. Numa tabela que só cresce — e `mensagens` é isso —
   inserir sempre no meio do índice fragmenta a árvore e faz a escrita ficar
   mais lenta com o tempo.

   O ULID resolve os dois: os 48 bits da frente são o RELÓGIO, então ids
   criados em seguida ficam vizinhos no índice e ordenam por tempo sozinhos.
   Os 80 bits de trás são aleatórios, então não se adivinha o próximo.

       01K2QF8N7B   8Z4XW3M0KP9YTR
       └── tempo ─┘ └─ aleatório ─┘

   Um efeito prático que vale ouro: `ORDER BY id` já é ordem cronológica, e a
   paginação por cursor cai direto na chave primária, sem índice extra.

   ---------------------------------------------------------------------------
   A MONOTONICIDADE, e por que ela não é firula

   Dentro do MESMO milissegundo, dois ULIDs sorteados independentemente podem
   sair fora de ordem entre si. Num chat isso não é teórico: duas mensagens
   enviadas ao mesmo tempo apareceriam trocadas na tela, e a resposta viria
   antes da pergunta.

   Aqui, quando o milissegundo se repete, a parte aleatória do último id é
   INCREMENTADA em vez de sorteada de novo. A ordem fica garantida sem depender
   da precisão do relógio.

   ---------------------------------------------------------------------------
   O RELÓGIO PODE VOLTAR (NTP ajustando, máquina virtual pausada). Se isso
   acontecer, continuamos incrementando a partir do último id emitido em vez de
   emitir um id "do passado" — ordem monotônica é mais importante aqui do que
   o carimbo de tempo ser exato, porque é a ordem que a tela mostra. O horário
   de verdade da mensagem vive na coluna `criada_em`, que é quem responde
   "quando isso foi dito".
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");

/* Base32 de Crockford: sem I, L, O e U. Não é capricho — tira a confusão entre
   1/I/L e 0/O quando alguém lê um id em voz alta no suporte, e tira o U para
   não formar palavrão por acaso num id que aparece em URL. */
const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TAMANHO_TEMPO = 10;
const TAMANHO_ALEATORIO = 16;

let ultimoTempo = -1;
let ultimoAleatorio = null;   // Uint8Array(16) com um índice do alfabeto por posição

function tempoEmBase32(ms) {
  let saida = "";
  let t = ms;
  for (let i = TAMANHO_TEMPO - 1; i >= 0; i--) {
    saida = ALFABETO[t % 32] + saida;
    t = Math.floor(t / 32);
  }
  return saida;
}

function sortearAleatorio() {
  const bytes = crypto.randomBytes(TAMANHO_ALEATORIO);
  const v = new Uint8Array(TAMANHO_ALEATORIO);
  for (let i = 0; i < TAMANHO_ALEATORIO; i++) v[i] = bytes[i] % 32;
  return v;
}

/* Soma 1 ao número de 80 bits representado pelos índices, propagando o vai-um
   da direita para a esquerda. Estourar tudo (16 posições em Z) só aconteceria
   com 32^16 ids no mesmo milissegundo; ainda assim, sorteamos de novo em vez
   de voltar a zero, que produziria id menor que o anterior. */
function incrementar(v) {
  for (let i = TAMANHO_ALEATORIO - 1; i >= 0; i--) {
    if (v[i] < 31) { v[i]++; return v; }
    v[i] = 0;
  }
  return sortearAleatorio();
}

function ulid(agora = Date.now()) {
  let t = agora;

  if (t <= ultimoTempo && ultimoAleatorio) {
    /* Mesmo milissegundo — ou relógio que andou para trás. Nos dois casos,
       continua de onde parou para nunca emitir id menor que o anterior. */
    t = ultimoTempo;
    ultimoAleatorio = incrementar(ultimoAleatorio);
  } else {
    ultimoTempo = t;
    ultimoAleatorio = sortearAleatorio();
  }

  let cauda = "";
  for (let i = 0; i < TAMANHO_ALEATORIO; i++) cauda += ALFABETO[ultimoAleatorio[i]];
  return tempoEmBase32(t) + cauda;
}

/* Conferência de FORMA, usada em toda rota que recebe id pela URL.

   O motivo é concreto: sem ela, `GET /conversas/<10 MB de texto>` vira uma
   consulta ao banco com 10 MB de parâmetro, e `../../etc/passwd` vira um id
   que só é recusado lá na frente — ou não é. Um id que não tem a forma de ULID
   nunca deveria chegar ao banco. */
const EH_ULID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const ehUlid = (v) => typeof v === "string" && EH_ULID.test(v);

/* O instante gravado dentro do id. Serve para conferir coerência ("este id foi
   criado depois daquele?") sem ir ao banco. */
function tempoDoUlid(id) {
  if (!ehUlid(id)) return null;
  let t = 0;
  for (let i = 0; i < TAMANHO_TEMPO; i++) t = t * 32 + ALFABETO.indexOf(id[i]);
  return t;
}

module.exports = { ulid, ehUlid, tempoDoUlid, ALFABETO };
