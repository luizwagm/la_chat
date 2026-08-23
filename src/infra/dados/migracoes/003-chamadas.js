/* ==========================================================================
   003-chamadas — reunião por vídeo

   ---------------------------------------------------------------------------
   O QUE ESTE ESQUEMA NÃO GUARDA

   Nenhum byte de mídia. Nenhuma gravação. Nenhuma transcrição.

   Não é omissão: é a decisão. Numa topologia de MALHA, o vídeo vai direto de
   um navegador ao outro, cifrado por DTLS-SRTP — o servidor nunca tem acesso a
   ele, nem que quisesse. Guardar áudio de reunião de equipe de clínica exigiria
   consentimento explícito, aviso na tela, guarda cifrada, prazo de retenção e
   política de acesso; e, em malha, exigiria um servidor recebendo a mídia só
   para gravar, que é metade de um SFU.

   O que fica aqui é o ESQUELETO da reunião: quem chamou, quem entrou, quando,
   por quanto tempo. É o que responde "houve reunião?" sem responder "o que foi
   dito lá".

   ---------------------------------------------------------------------------
   A CHAMADA PERTENCE A UMA CONVERSA — e isso não é organização

   É AUTORIZAÇÃO. Quem pode entrar numa chamada é exatamente quem é membro da
   conversa dela, e essa conferência já existe, já é testada e já vive dentro do
   SQL (`conversas.membroDe`). Não há superfície de autorização nova.

   A alternativa — sala com link, como o Teams faz — precisaria de um conceito
   próprio de "quem pode entrar", de convite para gente de fora, de sala de
   espera e de expiração de link. Cada um desses é um lugar novo onde errar.

   ---------------------------------------------------------------------------
   UMA CHAMADA VIVA POR CONVERSA — arbitrado pelo BANCO

   Duas pessoas clicam em "chamar" no mesmo segundo. Sem trava, nascem duas
   chamadas: cada uma numa sala, nenhuma vê a outra, e as duas ficam tocando
   para o mesmo grupo. É a mesma corrida da `chave_direta`, e a resposta é a
   mesma: índice único PARCIAL, no banco, porque entre o `SELECT` e o `INSERT`
   cabe a outra requisição.
   ========================================================================== */
"use strict";

const versao = "003-chamadas";

const sql = `

CREATE TABLE IF NOT EXISTS chamadas (
  id            TEXT PRIMARY KEY,
  contexto_id   TEXT NOT NULL,
  conversa_id   TEXT NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  iniciada_por  TEXT NOT NULL REFERENCES usuarios(id),
  tipo          TEXT NOT NULL DEFAULT 'direta',
  estado        TEXT NOT NULL DEFAULT 'tocando',
  iniciada_em   BIGINT NOT NULL,
  atendida_em   BIGINT,
  encerrada_em  BIGINT,
  motivo        TEXT NOT NULL DEFAULT '',
  pico          INTEGER NOT NULL DEFAULT 0,
  CHECK (tipo IN ('direta','reuniao')),
  CHECK (estado IN ('tocando','ativa','encerrada'))
);

/* A consulta quente: "esta conversa tem chamada rolando?" — feita a cada
   abertura de conversa e a cada evento de tempo real. */
CREATE INDEX IF NOT EXISTS ix_chamadas_conversa
  ON chamadas (conversa_id, estado);

CREATE INDEX IF NOT EXISTS ix_chamadas_tempo
  ON chamadas (contexto_id, iniciada_em);

/* ==========================================================================
   PARTICIPANTES

   estado é uma máquina pequena e explícita:

       convidado ──> tocando ──> dentro ──> saiu
                        │           ^
                        ├─> recusou │
                        └─> perdeu ─┘   (voltou depois)

   perdeu existe separado de recusou de propósito: a tela mostra "chamada
   perdida" para um e "recusou" para o outro, e no histórico da conversa a
   diferença é o que a pessoa quer saber.

   O estado dos DISPOSITIVOS (microfone, câmera, tela) mora aqui porque quem
   entra no meio precisa saber quem já está mudo — sem isso, cada participante
   veria um estado diferente conforme o momento em que chegou.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS chamada_participantes (
  chamada_id   TEXT NOT NULL REFERENCES chamadas(id) ON DELETE CASCADE,
  usuario_id   TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  estado       TEXT NOT NULL DEFAULT 'convidado',
  entrou_em    BIGINT,
  saiu_em      BIGINT,
  microfone    INTEGER NOT NULL DEFAULT 1,
  camera       INTEGER NOT NULL DEFAULT 1,
  tela         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chamada_id, usuario_id),
  CHECK (estado IN ('convidado','tocando','dentro','saiu','recusou','perdeu'))
);

CREATE INDEX IF NOT EXISTS ix_participantes_usuario
  ON chamada_participantes (usuario_id, estado);
`;

/* ==========================================================================
   O ÍNDICE PARCIAL — a trava contra duas chamadas na mesma conversa

   Fica no `extra` porque é a única parte que os dois motores escrevem igual
   mas que vale a pena comentar em separado. A CHAVE É `pg`, e não `postgres`:
   o `migrar.js` procura `extra[T.tipo]`, e `T.tipo` vale "sqlite" ou "pg".
   Escrito errado, o bloco não roda e ninguém percebe — foi o que aconteceu na
   migração 002.
   ========================================================================== */
const indiceUnico = `
  CREATE UNIQUE INDEX IF NOT EXISTS ix_chamada_viva
    ON chamadas (conversa_id)
    WHERE estado <> 'encerrada';
`;

const extra = { sqlite: indiceUnico, pg: indiceUnico };

module.exports = { versao, sql, extra };
