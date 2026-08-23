/* ==========================================================================
   005-arquivo — arquivar (por pessoa) e remover (pelo administrador)

   ---------------------------------------------------------------------------
   DUAS AÇÕES QUE PARECEM A MESMA E NÃO SÃO

   Elas vivem em tabelas diferentes de propósito, porque respondem a perguntas
   diferentes:

     ARQUIVAR   é de QUEM ARQUIVOU. Some da lista dela e de mais ninguém; os
                colegas continuam vendo a conversa normalmente. Mora em
                `conversa_membros`, que é a tabela do vínculo entre uma pessoa
                e uma conversa — o mesmo lugar de `silenciada`.

     REMOVER    é da CONVERSA. Some para todo mundo, e só o administrador pode.
                Mora em `conversas.apagada_em`, que já existia.

   Se arquivar morasse em `conversas`, arquivar para si esconderia a conversa
   da equipe inteira — e o defeito só apareceria quando o segundo membro
   reclamasse que a conversa sumiu sozinha.

   ---------------------------------------------------------------------------
   REMOVER NÃO APAGA LINHA NENHUMA

   `apagada_em` é uma marca, não um `DELETE`. A conversa e as mensagens
   continuam no banco, invisíveis para o sistema inteiro.

   Não é indecisão: é que remoção de conversa é operação de administrador sobre
   o histórico dos OUTROS, e um clique errado ali não pode ser definitivo.
   Quem precisa mesmo apagar de vez — pedido de LGPD, por exemplo — faz pelo
   banco, com consciência do que está fazendo, e não por um menu de três
   pontinhos.

   ---------------------------------------------------------------------------
   POR QUE A MENSAGEM NOVA DESARQUIVA

   Arquivar é "não quero ver isto agora", não "não quero mais falar com essa
   pessoa". Se a conversa arquivada continuasse escondida, a mensagem seguinte
   chegaria para um lugar que ninguém olha — e o efeito seria perder mensagem,
   que é o pior defeito possível num chat.

   Quem quer silêncio de verdade tem `silenciada`, que é outra coisa e já
   existe.
   ========================================================================== */
"use strict";

const versao = "005-arquivo";

const sql = `
/* Por PESSOA. NULL = não arquivada. Guarda-se o instante, e não um booleano,
   porque "quando foi arquivada" é a informação que permite ordenar a lista de
   arquivadas por recência — e um booleano nunca vira data depois. */
ALTER TABLE conversa_membros ADD COLUMN arquivada_em BIGINT;

/* Quem removeu. apagada_em já existia em conversas desde a 001; faltava
   dizer POR QUEM, que é o que transforma a marca em resposta a uma pergunta
   de auditoria. */
ALTER TABLE conversas ADD COLUMN apagada_por TEXT;
`;

/* ==========================================================================
   O ÍNDICE DA LISTA

   "Quais conversas eu tenho?" é a consulta mais quente do sistema, e ela passa
   a filtrar `arquivada_em IS NULL`. Um índice parcial mantém a barra lateral
   barata mesmo para quem arquiva muito.

   A chave é `pg`, e não `postgres` — o `migrar.js` procura `extra[T.tipo]`, e
   `T.tipo` vale "sqlite" ou "pg". Escrito errado, o bloco não roda e ninguém
   percebe: foi o que aconteceu na 002.
   ========================================================================== */
const indice = `
  CREATE INDEX IF NOT EXISTS ix_membros_ativas
    ON conversa_membros (usuario_id, arquivada_em);
`;

const extra = { sqlite: indice, pg: indice };

module.exports = { versao, sql, extra };
