/* ==========================================================================
   ip.js — de quem é esta requisição, de verdade

   ISTO JÁ FOI ERRADO NOS QUATRO SERVIDORES DESTE PARQUE. A forma natural, a
   que aparece em todo exemplo da internet, e a que estava no conector do
   LA Sentinela é:

       req.headers["x-forwarded-for"].split(",")[0]        // ← ERRADO

   O `X-Forwarded-For` é uma LISTA que cada proxy vai ACRESCENTANDO no fim:

       X-Forwarded-For: <o que o cliente mandou>, <ip visto pelo proxy 1>, ...
                         └──────────┬──────────┘
                          texto escrito pelo ATACANTE

   O primeiro item é o que o cliente enviou. Ele pode escrever o que quiser. As
   consequências não são teóricas:

   · o limitador de força bruta pune um IP inventado, e o atacante nunca é
     travado — basta ele trocar o cabeçalho a cada tentativa;
   · pior: ele escolhe o IP de OUTRA pessoa e tranca essa pessoa para fora;
   · a auditoria (§31) registra o endereço que o atacante escolher, o que
     torna o log pior que inútil — ele mente com aparência de prova.

   A LEITURA CERTA é contar do FIM para trás, descartando um item por proxy
   confiável. Com um nginx local (`CHAT_PROXIES=1`), o IP real é o ÚLTIMO da
   lista: foi o próprio nginx que o escreveu, e ele é a única parte da lista
   que o cliente não controla.

   Errar o número para MAIS faz todo mundo virar o IP do proxy — o limitador
   passa a trancar o escritório inteiro de uma vez. Errar para MENOS reabre a
   falha inteira. Por isso o número é configuração explícita, conferida pelo
   `verificar.sh`, e não um palpite do código.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");

/* Endereço direto do socket. É o único valor que NENHUM cabeçalho influencia —
   e por isso é o desvio seguro quando a lista não serve. */
function ipDoSocket(req) {
  const bruto = req.socket?.remoteAddress || "";
  /* O Node devolve IPv4 mapeado em IPv6 (`::ffff:127.0.0.1`) quando escuta nos
     dois. Sem normalizar, o MESMO cliente conta como dois endereços diferentes
     no limitador, e o orçamento de tentativas dele dobra. */
  return bruto.startsWith("::ffff:") ? bruto.slice(7) : bruto;
}

function ipDe(req, proxiesConfiaveis = 1) {
  const direto = ipDoSocket(req);

  /* Sem proxy declarado, o cabeçalho é ignorado por completo. Não é excesso:
     rodando sem nginx na frente, QUALQUER X-Forwarded-For que chegue veio do
     cliente, e obedecê-lo é entregar a identidade a quem pedir. */
  if (proxiesConfiaveis <= 0) return direto;

  const cabecalho = req.headers["x-forwarded-for"];
  if (!cabecalho) return direto;

  const lista = String(cabecalho).split(",").map((s) => s.trim()).filter(Boolean);
  if (!lista.length) return direto;

  /* Do FIM para trás: descarta um item por proxy confiável. Com 1 proxy, pega
     o último. Se a lista for mais curta que o esperado (requisição que não
     passou pelo caminho normal), cai no endereço do socket em vez de aceitar
     o que sobrou — sobra é justamente a parte que o cliente escreveu. */
  const i = lista.length - proxiesConfiaveis;
  if (i < 0) return direto;

  const escolhido = lista[i];
  return valido(escolhido) ? normalizar(escolhido) : direto;
}

const normalizar = (ip) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);

/* Conferência de forma, não de alcance. Um valor que não parece IP nunca deve
   virar chave do limitador: `a".repeat(10000)` como chave é memória gasta a
   pedido do atacante. */
function valido(ip) {
  if (!ip || ip.length > 45) return false;
  const v = normalizar(ip);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split(".").every((o) => Number(o) <= 255);
  return /^[0-9a-fA-F:]+$/.test(v) && v.includes(":");
}

/* ==========================================================================
   IP EM HASH — para a auditoria (§31, §34)

   O log precisa responder "foram 400 tentativas do mesmo lugar" sem manter um
   cadastro de onde cada funcionário estava em cada hora. O hash com sal da
   instalação resolve os dois lados: endereços iguais continuam iguais, e o
   valor não volta a ser um endereço.

   O sal vem do segredo do passe — que já é obrigatório e já é por instalação.
   Sem sal, um hash de IPv4 é quebrado por força bruta em segundos: são só
   4 bilhões de possibilidades.
   ========================================================================== */
function ipEmHash(ip, sal) {
  if (!ip) return "";
  return crypto.createHmac("sha256", String(sal)).update(String(ip)).digest("hex").slice(0, 24);
}

/* ==========================================================================
   ENDEREÇO DE LOOPBACK — o sintoma de `CHAT_PROXIES` errado

   Em produção, o IP resolvido de um visitante NUNCA é 127.0.0.1 nem ::1. Se
   for, o número de proxies está errado para menos, e todas as consequências
   são silenciosas:

     · o limitador conta a EMPRESA INTEIRA como um endereço só, e uma pessoa
       errando a senha tranca todo mundo junto;
     · a auditoria grava o mesmo hash para todos, e deixa de responder
       "de onde veio isso?".

   O caso que mais engana é o ARRANJO A (o recomendado): ali existem DOIS
   saltos — nginx → site, e site → chat, pelo conector. `CHAT_PROXIES=1`, que
   é o certo para nginx direto, faz o chat enxergar o próprio conector.
   ========================================================================== */
function ehLoopback(ip) {
  const v = normalizar(String(ip || ""));
  return v === "::1" || v === "0:0:0:0:0:0:0:1" || v.startsWith("127.");
}

module.exports = { ipDe, ipDoSocket, ipEmHash, valido, ehLoopback };
