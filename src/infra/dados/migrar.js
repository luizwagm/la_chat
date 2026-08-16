/* ==========================================================================
   migrar.js — aplica o esquema, uma vez cada

       node src/infra/dados/migrar.js            aplica o que falta
       node src/infra/dados/migrar.js --status   só mostra o que falta

   POR QUE MIGRAÇÃO VERSIONADA, e não `CREATE TABLE IF NOT EXISTS` no boot

   O `IF NOT EXISTS` no boot resolve a primeira instalação e nada mais. Ele não
   sabe ACRESCENTAR uma coluna a uma tabela que já existe — e a segunda versão
   do chat vai querer acrescentar. Sem registro do que já rodou, a atualização
   vira "rode este SQL à mão no servidor do cliente", que é onde os bancos
   divergem entre instalações e param de ser reproduzíveis.

   Aqui cada migração roda UMA vez, o registro fica no próprio banco, e
   `--status` responde "este servidor está na 001?" sem ninguém adivinhar.

   TUDO DENTRO DE UMA TRANSAÇÃO. Uma migração que falhe no meio deixaria o
   banco com metade das tabelas e nenhum registro do que aconteceu — o pior
   estado possível, porque a próxima tentativa esbarraria em tabela existente
   e pararia. Os dois motores aceitam DDL em transação; é o que faz falhar
   significar "nada mudou".
   ========================================================================== */
"use strict";

const { CONF } = require("../../../config.js");
const { abrir, agora } = require("./banco.js");

/* A ordem é a do array, e não a ordem alfabética de arquivos numa pasta:
   listagem de diretório muda entre sistemas de arquivos, e uma migração fora
   de ordem cria tabela antes da que ela referencia. */
const MIGRACOES = [
  require("./migracoes/001-inicial.js"),
];

async function garantirRegistro(Q) {
  await Q.exec(`
    CREATE TABLE IF NOT EXISTS migracoes (
      versao       TEXT PRIMARY KEY,
      aplicada_em  BIGINT NOT NULL
    );
  `);
}

async function aplicadas(Q) {
  const linhas = await Q.all("SELECT versao FROM migracoes");
  return new Set(linhas.map((l) => l.versao));
}

async function migrar({ Q, silencioso = false } = {}) {
  const proprio = !Q;
  if (proprio) Q = abrir(CONF.banco);

  const registro = [];
  try {
    await garantirRegistro(Q);
    const feitas = await aplicadas(Q);

    for (const m of MIGRACOES) {
      if (feitas.has(m.versao)) continue;

      await Q.transacao(async (T) => {
        await T.exec(m.sql);
        const especifico = m.extra?.[T.tipo];
        if (especifico && especifico.trim()) await T.exec(especifico);
        await T.run("INSERT INTO migracoes (versao, aplicada_em) VALUES (?, ?)", m.versao, agora());
      });

      registro.push(m.versao);
      if (!silencioso) console.log(`  ✓ ${m.versao}`);
    }

    if (!silencioso && !registro.length) console.log("  · banco já está em dia");
    return registro;
  } finally {
    if (proprio) await Q.fechar();
  }
}

async function status() {
  const Q = abrir(CONF.banco);
  try {
    await garantirRegistro(Q);
    const feitas = await aplicadas(Q);
    console.log(`\n  Banco: ${Q.tipo} (${Q.driver})`);
    if (Q.tipo === "sqlite") console.log(`  Arquivo: ${CONF.banco.arquivo}`);
    console.log("");
    for (const m of MIGRACOES) console.log(`  ${feitas.has(m.versao) ? "✓" : "·"}  ${m.versao}`);
    const faltam = MIGRACOES.filter((m) => !feitas.has(m.versao)).length;
    console.log(faltam ? `\n  ${faltam} migração(ões) pendente(s) — rode: npm run migrar\n` : "\n  Em dia.\n");
  } finally {
    await Q.fechar();
  }
}

if (require.main === module) {
  const alvo = process.argv.includes("--status") ? status() : migrar();
  alvo.catch((e) => {
    /* Mensagem amigável na tela; detalhe técnico só no log (§57). Um `stack`
       jogado na cara de quem opera esconde a linha que importa. */
    console.error("\n  ✖ falha ao migrar:", e.message, "\n");
    if (process.env.CHAT_DEBUG) console.error(e);
    process.exitCode = 1;
  });
}

module.exports = { migrar, status, MIGRACOES };
