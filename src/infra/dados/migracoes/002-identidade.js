/* ==========================================================================
   002-identidade — quem a pessoa É, separado da conta que ela usa

   ---------------------------------------------------------------------------
   O QUE ACONTECEU

   O `externo_id` guarda o id que o hospedeiro manda, e no BemEstarClinic esse
   id é o da CONTA DE ACESSO. Conta é descartável: o cliente apagou o usuário de
   um profissional, reativou a pessoa depois e criou uma conta nova para ela.

   Conta nova → id novo → pessoa nova aqui → **conversa nova**. A barra lateral
   passou a mostrar duas linhas com o mesmo nome: uma com o histórico e outra
   vazia. Nenhum erro em lugar nenhum; só o histórico partido ao meio.

   ---------------------------------------------------------------------------
   POR QUE UMA COLUNA NOVA, E NÃO REESCREVER O `externo_id`

   A primeira tentativa foi migrar o próprio `externo_id` para a identidade. Ela
   funciona — e cria uma armadilha de mão única: no dia em que o hospedeiro
   parasse de mandar `identidade` (um rollback, uma versão antiga do conector),
   a chave voltaria a ser o id da conta, ninguém casaria, e a equipe INTEIRA
   nasceria de novo duplicada — desativando de quebra todo mundo que já estava.
   O teste pegou isso na hora: as sessões abertas passaram a responder 401.

   Com coluna própria, as duas chaves coexistem. A busca tenta a identidade e
   cai no `externo_id`; voltar atrás continua encontrando as mesmas pessoas.

   ---------------------------------------------------------------------------
   O ÍNDICE É PARCIAL

   `WHERE identidade <> ''` — a maioria dos hospedeiros não manda identidade
   nenhuma, e um índice único sobre string vazia faria a segunda pessoa sem
   identidade colidir com a primeira.
   ========================================================================== */
const versao = "002-identidade";

const sql = `
  ALTER TABLE usuarios ADD COLUMN identidade TEXT NOT NULL DEFAULT '';
`;

const extra = {
  sqlite: `
    CREATE UNIQUE INDEX IF NOT EXISTS ix_usuarios_identidade
      ON usuarios (contexto_id, identidade)
      WHERE identidade <> '';
  `,
  /* A CHAVE É `pg`, e não `postgres`.

     O `migrar.js` procura `m.extra[T.tipo]`, e `T.tipo` vale "sqlite" ou "pg"
     (ver banco.js). Escrito como `postgres`, este bloco NUNCA rodava: no
     PostgreSQL o índice único de identidade simplesmente não existia, e a
     trava contra pessoa duplicada valia só no SQLite — em silêncio, que é o
     pior jeito de uma trava não existir.

     Achado ao ler as convenções para a migração 003. */
  pg: `
    CREATE UNIQUE INDEX IF NOT EXISTS ix_usuarios_identidade
      ON usuarios (contexto_id, identidade)
      WHERE identidade <> '';
  `,
};

module.exports = { versao, sql, extra };
