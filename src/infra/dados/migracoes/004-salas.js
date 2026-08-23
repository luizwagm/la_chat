/* ==========================================================================
   004-salas — reunião por link, com convidado de fora

   ---------------------------------------------------------------------------
   O QUE ESTA MIGRAÇÃO MUDA NO MODELO DE SEGURANÇA — leia antes de mexer

   Até aqui uma frase sustentava o sistema inteiro: **quem pode entrar é quem é
   membro da conversa**. A autorização nunca era nova; ela reusava
   `exigirMembro`, que vive dentro do SQL e tem suíte em cima.

   A sala por link quebra isso DE PROPÓSITO. Ela cria:

     · participante NÃO autenticado;
     · uma URL que É a credencial (quem tem o link, entra);
     · identidade DECLARADA pela própria pessoa ("digite seu nome").

   Cada um desses é um risco que o chat não tinha. O que os contém:

   1. O CONVIDADO NÃO GANHA SESSÃO DE CHAT. Ele recebe uma sessão própria,
      com cookie próprio, que autoriza UMA sala e nada mais. Nenhuma rota de
      conversa, mensagem, busca ou pessoa a aceita. Ver seguranca/convidado.js.

   2. O CONVIDADO EXISTE COMO `usuarios`, MAS MARCADO. A coluna `convidado`
      existe para ele poder participar da malha sem duplicar a lógica de
      chamada — e para ser excluído de TODA listagem, busca e criação de grupo.
      É defesa em profundidade: a proteção real é a do item 1.

   3. O CÓDIGO DO LINK NÃO É GRAVADO EM CLARO. Guarda-se o hash (para achar a
      sala) e o código CIFRADO (para o anfitrião reabrir o link depois). Um
      dump vazado não entrega nenhuma sala viva.

   4. TODA SALA MORRE. Por prazo do link, por duração da chamada, ou por
      revogação. Sala anônima permanente seria um buraco permanente.
   ========================================================================== */
"use strict";

const versao = "004-salas";

const sql = `

/* ==========================================================================
   A MARCA DE CONVIDADO

   Sem ela, um convidado apareceria na lista de pessoas da empresa, na busca do
   diretório e na tela de criar grupo — e daria para pôr um estranho dentro de
   um grupo interno.

   O padrão 0 é o que faz as linhas que já existem continuarem sendo gente da
   casa sem nenhuma conversão.
   ========================================================================== */
ALTER TABLE usuarios ADD COLUMN convidado INTEGER NOT NULL DEFAULT 0;

/* ==========================================================================
   SALAS

   codigo_hash    o que se procura. SHA-256 do código; o código em si nunca é
                  gravado em claro, do mesmo jeito que o token de sessão.
   codigo_cifrado o mesmo código, cifrado com a chave da instalação, para o
                  anfitrião conseguir copiar o link de novo. Sem ele, o link
                  seria mostrado uma vez só — o que é correto para uma chave de
                  API e irritante para um convite de reunião.

   duracao_min    a chamada encerra sozinha ao fim deste tempo. Não é sugestão:
                  é o que impede uma sala anônima de ficar aberta a noite toda.

   expira_em      validade do LINK, diferente da duração da chamada. O link
                  pode valer o dia e a reunião durar 40 minutos.

   exige_anfitriao  o convidado só entra depois que alguém DA CASA abriu a
                  sala. Ligado por padrão — ver o comentário em dominio/salas.js
                  sobre estranhos conversando pelo seu relay.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS salas (
  id               TEXT PRIMARY KEY,
  contexto_id      TEXT NOT NULL,
  codigo_hash      TEXT NOT NULL,
  codigo_cifrado   TEXT NOT NULL DEFAULT '',
  criada_por       TEXT NOT NULL REFERENCES usuarios(id),
  titulo           TEXT NOT NULL DEFAULT '',
  duracao_min      INTEGER NOT NULL DEFAULT 60,
  expira_em        BIGINT NOT NULL,
  exige_anfitriao  INTEGER NOT NULL DEFAULT 1,
  max_convidados   INTEGER NOT NULL DEFAULT 5,
  estado           TEXT NOT NULL DEFAULT 'aberta',
  conversa_id      TEXT REFERENCES conversas(id),
  chamada_id       TEXT REFERENCES chamadas(id),
  iniciada_em      BIGINT,
  encerra_em       BIGINT,
  encerrada_em     BIGINT,
  criada_em        BIGINT NOT NULL,
  CHECK (estado IN ('aberta','ativa','encerrada','revogada'))
);

/* O caminho de TODA visita ao link: achar a sala pelo hash do código. Único
   porque duas salas com o mesmo código seria uma sala que abre a outra. */
CREATE UNIQUE INDEX IF NOT EXISTS ix_salas_codigo ON salas (codigo_hash);
CREATE INDEX IF NOT EXISTS ix_salas_dono ON salas (criada_por, criada_em);
CREATE INDEX IF NOT EXISTS ix_salas_expira ON salas (estado, expira_em);

/* ==========================================================================
   CONVIDADOS

   Uma linha por pessoa de fora que entrou. Serve à auditoria — que é o único
   registro que existe de quem esteve numa sala anônima — e ao teto de
   convidados.

   nome é CIFRADO: é dado pessoal de alguém que nem cliente é, e não há
   motivo para ficar legível num dump.

   ip_hash, e nunca o IP: responde "foram 40 tentativas do mesmo lugar" sem
   manter cadastro de onde cada visitante estava.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS sala_convidados (
  id          TEXT PRIMARY KEY,
  sala_id     TEXT NOT NULL REFERENCES salas(id) ON DELETE CASCADE,
  usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL DEFAULT '',
  ip_hash     TEXT NOT NULL DEFAULT '',
  agente      TEXT NOT NULL DEFAULT '',
  entrou_em   BIGINT NOT NULL,
  saiu_em     BIGINT,
  expulso     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_convidados_sala ON sala_convidados (sala_id, entrou_em);
CREATE UNIQUE INDEX IF NOT EXISTS ix_convidados_usuario ON sala_convidados (usuario_id);
`;

/* ==========================================================================
   O ÍNDICE PARCIAL DA EXCLUSÃO DO DIRETÓRIO

   A consulta de pessoas passa a filtrar `convidado = 0`. Com muita gente de
   fora acumulada, um índice sobre a coluna evita que a lista da empresa fique
   mais lenta a cada reunião com convidado.

   A chave é `pg`, e não `postgres` — o `migrar.js` procura `extra[T.tipo]`, e
   `T.tipo` vale "sqlite" ou "pg". Escrito errado, o bloco não roda e ninguém
   percebe: foi o que aconteceu na 002.
   ========================================================================== */
const indice = `
  CREATE INDEX IF NOT EXISTS ix_usuarios_casa
    ON usuarios (contexto_id, convidado, nome);
`;

const extra = { sqlite: indice, pg: indice };

module.exports = { versao, sql, extra };
