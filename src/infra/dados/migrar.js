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
const fs = require("node:fs");
const { abrir, agora } = require("./banco.js");

/* A ordem é a do array, e não a ordem alfabética de arquivos numa pasta:
   listagem de diretório muda entre sistemas de arquivos, e uma migração fora
   de ordem cria tabela antes da que ela referencia. */
const MIGRACOES = [
  require("./migracoes/001-inicial.js"),
  require("./migracoes/002-identidade.js"),
  require("./migracoes/003-chamadas.js"),
  require("./migracoes/004-salas.js"),
  require("./migracoes/005-arquivo.js"),
  require("./migracoes/006-podesala.js"),
  require("./migracoes/007-espera.js"),
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
    /* A dica NÃO diz mais "rode: npm run migrar". Num servidor com instâncias
       esse é justamente o comando que migra o BANCO ERRADO — ver
       `conferirInstancia`. Quem precisa do caminho certo o recebe lá, com o
       nome das instâncias que existem naquela máquina. */
    console.log(faltam ? `\n  ${faltam} migração(ões) pendente(s)\n` : "\n  Em dia.\n");
  } finally {
    await Q.fechar();
  }
}

/* ==========================================================================
   O BANCO CERTO — a recusa que evita "migrei e não mudou nada"

   Num servidor com instâncias, cada cliente tem o próprio banco em
   `/var/lib/lachat/<instancia>/chat.db`, apontado pelo `CHAT_SQLITE` do
   arquivo de ambiente dele. Rodar `npm run migrar` de dentro do diretório do
   código, sem carregar esse ambiente, usa o caminho PADRÃO — e cria ou migra um
   banco avulso ali dentro.

   O comando termina com "✓" em todas as migrações. O banco do cliente continua
   exatamente como estava. E o sintoma aparece depois, na cara do usuário, como
   uma funcionalidade que "não subiu".

   Dois sinais denunciam o engano, e os dois são conferíveis: existe pelo menos
   um `/etc/lachat-*.env` (logo, há instâncias) e o `CHAT_SQLITE` não foi
   informado (logo, ninguém carregou o ambiente de nenhuma).

   `CHAT_MIGRAR_AVULSO=1` libera, para o caso legítimo de um banco de
   desenvolvimento na máquina de quem programa.
   ========================================================================== */
function conferirInstancia() {
  if (process.env.CHAT_SQLITE || process.env.CHAT_MIGRAR_AVULSO === "1") return true;
  if (String(process.env.CHAT_BANCO || "sqlite") !== "sqlite") return true;

  let instancias = [];
  try {
    instancias = fs.readdirSync("/etc")
      .filter((f) => /^lachat-.+\.env$/.test(f))
      .map((f) => f.replace(/^lachat-|\.env$/g, ""));
  } catch { return true; }          // sem /etc legível: não é este servidor

  if (!instancias.length) return true;

  console.error(`
  ✖ SEM O AMBIENTE DA INSTÂNCIA, ISTO MIGRARIA O BANCO ERRADO.

    Este servidor tem ${instancias.length} instância(s): ${instancias.join(", ")}
    Cada uma tem o próprio banco, e nenhum deles é o do diretório do código.

    Rodando assim, as migrações seriam aplicadas a um banco avulso e o do
    cliente continuaria atrasado — com "✓" em tudo na tela.

    O jeito certo, para TODAS as instâncias:

        sudo ${__dirname.replace(/src.*$/, "")}deploy.sh --atualizar-todas

    Ou para UMA:

        sudo sh -c 'set -a; . /etc/lachat-${instancias[0]}.env; set +a; \\
          cd ${__dirname.replace(/[\\/]src[\\/].*$/, "")} && node src/infra/dados/migrar.js'

    Se for mesmo um banco de desenvolvimento: CHAT_MIGRAR_AVULSO=1
`);
  return false;
}

if (require.main === module) {
  if (!conferirInstancia()) { process.exitCode = 1; return; }
  const alvo = process.argv.includes("--status") ? status() : migrar();
  alvo.catch((e) => {
    /* Mensagem amigável na tela; detalhe técnico só no log (§57). Um `stack`
       jogado na cara de quem opera esconde a linha que importa. */
    console.error("\n  ✖ falha ao migrar:", e.message, "\n");
    if (process.env.CHAT_DEBUG) console.error(e);
    process.exitCode = 1;
  });
}

module.exports = { migrar, status, MIGRACOES, conferirInstancia };
