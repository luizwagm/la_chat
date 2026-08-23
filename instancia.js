/* ==========================================================================
   instancia.js — sobe o chat com o ambiente de UM arquivo

       node instancia.js .env.kenosis

   Para que serve: rodar DUAS (ou mais) instâncias do chat a partir do mesmo
   código, cada uma com porta, banco, segredos e origens próprios — um chat
   por cliente, sem nada compartilhado além do código.

   Em produção isto não é necessário: o systemd faz o mesmo com uma unit por
   instância e `EnvironmentFile=` apontando para o arquivo dela. Este lançador
   existe para o DESENVOLVIMENTO, onde não há systemd.

   Como funciona: o config.js lê o `.env` da pasta, mas o que JÁ ESTIVER no
   ambiente vence. Então basta carregar o arquivo da instância ANTES de
   entregar o controle ao server.js — os valores dele passam a ser "o
   ambiente", e o `.env` padrão só preencheria o que faltasse.

   Por isso a regra: o arquivo da instância precisa declarar TUDO que a
   distingue (PORT, CHAT_SQLITE, CHAT_ARQUIVOS, os três segredos e as
   origens). Chave esquecida cai no `.env` da instância padrão — e duas
   instâncias dividindo o MESMO banco em silêncio é exatamente o acidente
   que este arquivo existe para impedir. As críticas são conferidas abaixo.
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const arq = process.argv[2];
if (!arq) {
  console.error("uso: node instancia.js <arquivo.env>   (ex.: node instancia.js .env.kenosis)");
  process.exit(1);
}
const caminho = path.resolve(__dirname, arq);

/* As chaves que separam uma instância da outra. Faltando qualquer uma, esta
   instância herdaria o valor da padrão — banco compartilhado, segredo
   compartilhado — e o erro só apareceria misturando dados de dois clientes. */
const OBRIGATORIAS = ["PORT", "CHAT_SQLITE", "CHAT_ARQUIVOS",
  "CHAT_SEGREDO_PASSE", "CHAT_SEGREDO_BUSCA", "CHAT_DADOS_CHAVE", "CHAT_ORIGENS"];

/* No systemd, quem lê o arquivo é o PRÓPRIO systemd (como root, via
   EnvironmentFile=) — quando este processo nasce, as variáveis JÁ ESTÃO no
   ambiente, e o arquivo pode ser ilegível para o usuário do serviço (600
   root:root). Exigir a leitura aqui derrubava a unit com EACCES mesmo com o
   ambiente completo. Então: se o arquivo não puder ser lido mas as chaves
   obrigatórias já estiverem postas, segue — o arquivo era só o mensageiro. */
let definidas = null;
try {
  const texto = fs.readFileSync(caminho, "utf8");
  definidas = new Set();
  for (const linha of texto.split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || linha.trim().startsWith("#")) continue;
    const valor = m[2].replace(/^["']|["']$/g, "");
    process.env[m[1]] = valor;          // a instância VENCE o que já houver
    definidas.add(m[1]);
  }
} catch (e) {
  const jaPostas = OBRIGATORIAS.every((k) => process.env[k]);
  if (!jaPostas) {
    console.error(`✖ não consegui ler ${caminho} (${e.code || e.message}) e o ambiente não traz as chaves da instância.`);
    console.error(`  Ou torne o arquivo legível para o usuário do serviço, ou defina no ambiente: ${OBRIGATORIAS.join(", ")}`);
    process.exit(1);
  }
  console.log(`  · ambiente herdado do systemd (${path.basename(caminho)} ilegível para este usuário — ok)`);
}

const faltam = OBRIGATORIAS.filter((k) => definidas ? !definidas.has(k) : !process.env[k]);
if (faltam.length) {
  console.error(`✖ ${path.basename(caminho)} precisa declarar: ${faltam.join(", ")}`);
  console.error("  (sem elas a instância herdaria banco/segredos da instância padrão)");
  process.exit(1);
}

console.log(`  · instância: ${path.basename(caminho)} (porta ${process.env.PORT})`);
/* O server.js só se inicia sozinho quando é o módulo PRINCIPAL
   (require.main === module). Requerido daqui, ele exporta `principal` e
   espera ser chamado — sem esta linha o processo imprime a instância e
   encerra com código 0, parecendo que subiu. */
require("./server.js").principal();
