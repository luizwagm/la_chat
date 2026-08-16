/* ==========================================================================
   banco.js — a ÚNICA porta para o banco, nos dois motores

   O chat precisa rodar em SQLite e em PostgreSQL. Dezesseis dos vinte sites do
   parque só têm SQLite, e exigir um servidor de banco para instalar um chat
   mataria a instalação. Os quatro que têm PostgreSQL são justamente os que vão
   ter volume.

   ---------------------------------------------------------------------------
   A DECISÃO QUE MAIS IMPORTA AQUI: A API É ASSÍNCRONA NOS DOIS

   O `better-sqlite3` é SÍNCRONO. Seria natural expor `db.get()` devolvendo a
   linha direto quando o motor é SQLite, e uma Promise quando é PostgreSQL.
   Isso seria um desastre silencioso, e o `pg.js` deste parque já documenta o
   porquê num projeto onde a conversão custou caro:

       const linha = Q.get("SELECT ...");   // esqueceu o await
       if (linha) { ... }                   // Promise é objeto → PASSA
       linha.id                             // undefined
                                            // NADA ESTOURA

   O sistema segue rodando e grava errado. Com uma API assíncrona nos DOIS
   motores, um `await` esquecido quebra igual em desenvolvimento (SQLite) e em
   produção (PostgreSQL) — a classe inteira de erro morre.

   ---------------------------------------------------------------------------
   O QUE A CAMADA TRADUZ

   O SQL é escrito UMA vez, no dialeto do SQLite (`?`), e traduzido para o
   PostgreSQL na hora:

     1. `?` → `$1, $2…`
     2. `LIKE` → `ILIKE`  — ARMADILHA SILENCIOSA. No SQLite `LIKE` ignora
        maiúsculas para ASCII; no PostgreSQL, não. Sem traduzir, procurar
        "maria" pararia de achar "Maria" e a busca morreria sem erro nenhum.

   As duas traduções pulam o que está dentro de aspas e de comentários.

   O QUE A CAMADA **NÃO** FAZ: montar SQL por concatenação. Todo valor vindo do
   usuário vai por parâmetro, sempre. É o que fecha o §17 (SQL Injection) na
   origem, e não com filtro de string.
   ========================================================================== */
"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

/* ==========================================================================
   TEMPO — inteiro de milissegundos, nos dois motores

   Nem `DATETIME` do SQLite (que é texto) nem `timestamptz` do PostgreSQL: um
   inteiro. O motivo é que os dois motores formatam data de jeitos diferentes, e
   uma comparação de texto entre "2026-08-14 09:00" e "2026-08-14T09:00Z" falha
   sem erro — ordena errado o histórico e a paginação começa a pular mensagens.

   Inteiro compara igual em toda parte, indexa bem, e não tem fuso.
   Formatar para humano é problema da tela, que é onde o fuso do leitor existe.
   ========================================================================== */
const agora = () => Date.now();

/* ==========================================================================
   TRADUÇÃO DO SQL — pulando aspas e comentários
   ========================================================================== */
function paraPostgres(sql) {
  let saida = "";
  let n = 0;
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];

    /* ======================================================================
       COMENTÁRIOS PRIMEIRO — a ordem destes blocos é um defeito à espera.

       Se as aspas fossem conferidas antes, um apóstrofo dentro de comentário
       ("marca d'água", "não") abriria uma string FALSA que só fecharia no
       próximo apóstrofo, muitas linhas adiante. Todos os `?` no meio deixariam
       de virar `$n` — e o sintoma seria um erro do PostgreSQL sobre parâmetro
       faltando, apontando para uma consulta que não tem defeito nenhum.

       Comentário não é texto de dado. Ele é reconhecido antes.
       ====================================================================== */
    if (c === "-" && sql[i + 1] === "-") {
      const fim = sql.indexOf("\n", i);
      const ate = fim === -1 ? sql.length : fim;
      saida += sql.slice(i, ate);
      i = ate;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const fim = sql.indexOf("*/", i + 2);
      const ate = fim === -1 ? sql.length : fim + 2;
      saida += sql.slice(i, ate);
      i = ate;
      continue;
    }

    /* Texto entre aspas simples ou duplas passa intocado: um valor que contenha
       "?" ou a palavra LIKE não é sintaxe. */
    if (c === "'" || c === '"') {
      const fecha = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === fecha) {
          if (sql[j + 1] === fecha) { j += 2; continue; }   // aspa escapada ('')
          break;
        }
        j++;
      }
      saida += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (c === "?") { saida += "$" + ++n; i++; continue; }

    /* LIKE → ILIKE, só quando é palavra inteira. `ILIKE` já escrito não vira
       `IILIKE`, e uma coluna chamada `like_count` não é tocada. */
    if ((c === "L" || c === "l") && /^like\b/i.test(sql.slice(i)) && !/[\w]/.test(sql[i - 1] || "")) {
      saida += "ILIKE";
      i += 4;
      continue;
    }

    saida += c;
    i++;
  }
  return saida;
}

/* ==========================================================================
   MOTOR SQLITE

   A escolha de driver repete a lição do `db.js` do parque: `better-sqlite3` é
   o estável, mas é módulo NATIVO e pode faltar num servidor onde ninguém rodou
   `npm ci`. Se o require estourasse no topo, o chat inteiro sairia do ar por
   causa de uma dependência.

   E o `require` sozinho NÃO basta como teste: ele carrega só JavaScript e
   passa mesmo quando o binário não serve para este Node. O erro real
   (`ERR_DLOPEN_FAILED`, `invalid ELF header`) só aparece ao CONSTRUIR o
   primeiro banco. Por isso abrimos um banco de mentira aqui dentro do try —
   foi exatamente assim que a primeira subida de outro projeto caiu.
   ========================================================================== */
function abrirSqlite(arquivo) {
  let criar = null;
  let driver = "";

  try {
    const Better = require("better-sqlite3");
    new Better(":memory:").close();
    criar = (arq) => new Better(arq);
    driver = "better-sqlite3";
  } catch {
    const { DatabaseSync } = require("node:sqlite");
    criar = (arq) => new DatabaseSync(arq);
    driver = "node:sqlite (experimental)";
  }

  const db = criar(arquivo);

  /* WAL: leitura e escrita deixam de esperar uma pela outra. Num chat, onde
     alguém está sempre gravando, é a diferença entre responder e travar.
     `foreign_keys` NÃO vem ligada por padrão no SQLite — sem esta linha as
     chaves estrangeiras do esquema seriam decoração. */
  try { db.exec("PRAGMA journal_mode = WAL;"); } catch { }
  try { db.exec("PRAGMA foreign_keys = ON;"); } catch { }
  /* `busy_timeout`: em vez de devolver SQLITE_BUSY na hora, espera. Sem isso,
     duas gravações no mesmo milissegundo viram erro na cara do usuário. */
  try { db.exec("PRAGMA busy_timeout = 5000;"); } catch { }

  const preparar = (sql) => db.prepare(sql);

  return {
    tipo: "sqlite",
    driver,

    async get(sql, ...p) { return preparar(sql).get(...p) ?? null; },
    async all(sql, ...p) { return preparar(sql).all(...p); },
    async run(sql, ...p) {
      const r = preparar(sql).run(...p);
      return { linhas: Number(r.changes ?? 0), id: r.lastInsertRowid ?? null };
    },
    async exec(sql) { db.exec(sql); },

    /* Transação. O `better-sqlite3` tem `db.transaction()`, mas ele exige
       função SÍNCRONA — e os nossos casos de uso são async (cifram, calculam
       token, gravam anexo). Então é BEGIN/COMMIT na mão, com IMMEDIATE para
       pegar a trava de escrita já na abertura: sem isso, duas transações que
       começam lendo e depois escrevem colidem no COMMIT e uma perde. */
    async transacao(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = await fn(this);
        db.exec("COMMIT");
        return r;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { }
        throw e;
      }
    },

    async fechar() { try { db.close(); } catch { } },
    async saude() { await this.get("SELECT 1 AS ok"); return true; },
  };
}

/* ==========================================================================
   MOTOR POSTGRESQL

   O `require("pg")` fica dentro do try pelo mesmo motivo do `db.js` do parque:
   o pacote pode faltar num servidor sem `npm ci`, e a falta tem de virar erro
   claro na primeira consulta — nunca processo morto na partida.
   ========================================================================== */
function abrirPostgres(conf) {
  let pg = null;
  try { pg = require("pg"); }
  catch { throw new Error("o pacote 'pg' não está instalado — rode: npm ci --omit=dev"); }

  /* ==========================================================================
     BIGINT VOLTA COMO TEXTO — e isto quebraria o chat inteiro em silêncio.

     O driver `pg` entrega `int8` (BIGINT) como STRING, e não como número. A
     razão dele é boa: BIGINT vai até 9.2×10^18 e o `number` do JavaScript só é
     exato até 9×10^15.

     O problema é que TODAS as colunas de tempo e o `seq` deste esquema são
     BIGINT. Sem esta conversão, o mesmo código se comportaria assim:

         SQLite:      831 > 830          → true    (número)
         PostgreSQL:  "831" > "830"      → true    (texto, por sorte)
         PostgreSQL:  "1000" > "830"     → FALSE   (texto: "1" < "8")

     Ou seja: a retomada após reconexão pararia de entregar mensagens assim que
     o `seq` da conversa passasse de 999, e a ordenação embaralharia o
     histórico. Nada estouraria. O sintoma seria "às vezes some mensagem", só
     em produção, só nas conversas antigas.

     A conversão é segura para este esquema porque os valores reais aqui são
     milissegundos de época (~1.7×10^12) e contadores de mensagem — ordens de
     grandeza abaixo do limite de precisão do `number`.

     20 = OID do int8; 1700 = numeric, que o mesmo raciocínio alcança.
     ========================================================================== */
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

  const pool = new pg.Pool({
    host: conf.host, port: conf.porta, database: conf.banco,
    user: conf.usuario, password: conf.senha, max: conf.maximo,
    /* Conexão ociosa é devolvida em 30 s; conectar tem 10 s para responder.
       Sem o teto, uma queda de rede deixa o pedido pendurado para sempre e a
       tela do usuário fica girando sem erro. */
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  /* ==========================================================================
     ERRO DE CLIENTE OCIOSO NÃO PODE DERRUBAR O PROCESSO.

     O PostgreSQL do parque cai por ~5 s durante o upgrade automático de
     madrugada. Quando isso acontece, o pool emite 'error' num cliente ocioso —
     e um 'error' sem ouvinte no Node é EXCEÇÃO NÃO TRATADA: o serviço inteiro
     morre por causa de uma conexão que ninguém estava usando.

     Com este ouvinte, o pool descarta o cliente ruim e abre outro sozinho. O
     chat treme por segundos em vez de sair do ar.
     ========================================================================== */
  pool.on("error", (e) => {
    console.error("  ⚠ PostgreSQL: conexão ociosa caiu —", e.message, "(o pool religa sozinho)");
  });

  /* A transação precisa que TODAS as consultas de dentro dela usem o MESMO
     cliente. Sem isso elas sairiam por conexões diferentes do pool e o
     BEGIN/COMMIT valeria para uma conexão enquanto os INSERTs iam por outra —
     o rollback não desfaria nada, e o defeito só apareceria sob concorrência. */
  const contexto = new AsyncLocalStorage();
  const executor = () => contexto.getStore() || pool;

  async function consultar(sql, p) {
    return executor().query(paraPostgres(sql), p);
  }

  return {
    tipo: "pg",
    driver: "pg",

    async get(sql, ...p) { const r = await consultar(sql, p); return r.rows[0] ?? null; },
    async all(sql, ...p) { const r = await consultar(sql, p); return r.rows; },
    async run(sql, ...p) {
      const r = await consultar(sql, p);
      return { linhas: r.rowCount ?? 0, id: r.rows?.[0]?.id ?? null };
    },
    async exec(sql) { await executor().query(sql); },

    async transacao(fn) {
      const cliente = await pool.connect();
      try {
        await cliente.query("BEGIN");
        const r = await contexto.run(cliente, () => fn(this));
        await cliente.query("COMMIT");
        return r;
      } catch (e) {
        try { await cliente.query("ROLLBACK"); } catch { }
        throw e;
      } finally {
        cliente.release();
      }
    },

    async fechar() { try { await pool.end(); } catch { } },
    async saude() { await this.get("SELECT 1 AS ok"); return true; },
  };
}

/* ==========================================================================
   ABRIR

   Devolve sempre o mesmo formato — `Q` — independentemente do motor. Nenhum
   repositório acima daqui sabe em qual banco está.
   ========================================================================== */
function abrir(conf) {
  if (conf.motor === "pg") return abrirPostgres(conf.pg);

  const fs = require("node:fs");
  const path = require("node:path");
  fs.mkdirSync(path.dirname(conf.arquivo), { recursive: true });
  return abrirSqlite(conf.arquivo);
}

module.exports = { abrir, paraPostgres, agora };
