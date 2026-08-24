/* ==========================================================================
   007-espera — a sala de espera do convidado

   ---------------------------------------------------------------------------
   POR QUE O CONVIDADO PASSA A ESPERAR

   Até aqui, quem tinha o link e digitava um nome entrava. O anfitrião precisava
   estar presente (ver `podeEntrar`), então havia sempre alguém da casa na sala —
   mas descobrir quem chegou era olhar a tela e ver um rosto novo.

   Isso serve para uma reunião combinada e serve mal para o resto: link
   encaminhado a mais gente do que se pretendia, link colado num grupo, ou
   simplesmente a pessoa errada entrando na hora errada. A porta era aberta por
   quem tem o endereço, e não por quem conduz.

   Agora o link dá acesso à FILA, não à reunião. Quem decide é o anfitrião, e a
   decisão é sobre um nome concreto.

   ---------------------------------------------------------------------------
   TRÊS ESTADOS, E O PADRÃO É `dentro`

       esperando   pediu para entrar, ninguém decidiu ainda
       dentro      aprovado — está na reunião ou pode voltar a ela
       negado      recusado; o cookie dele morre junto

   O padrão da coluna é `dentro` de propósito: numa base existente, todo
   convidado já registrado ENTROU sob a regra antiga, e marcá-lo como
   `esperando` o expulsaria de uma reunião em andamento no momento da migração.

   ---------------------------------------------------------------------------
   POR QUE NÃO HÁ CHECK

   `ALTER TABLE ... ADD COLUMN` não aceita CHECK no SQLite, e uma constraint que
   existe num motor e não no outro é pior que nenhuma: dá a sensação de garantia
   sem a garantia. Quem escreve valores nesta coluna é `repositorios/salas.js`,
   num punhado de linhas, e é lá que a lista vive.
   ========================================================================== */
"use strict";

const versao = "007-espera";

const sql = `
ALTER TABLE sala_convidados ADD COLUMN estado TEXT NOT NULL DEFAULT 'dentro';

/* Quando o anfitrião decidiu. Responde "quanto tempo essa pessoa esperou?",
   que é a pergunta que aparece quando alguém reclama de ter ficado de fora. */
ALTER TABLE sala_convidados ADD COLUMN decidido_em BIGINT;
`;

/* A fila de uma sala é consultada a cada pedido novo e a cada abertura do
   painel do anfitrião. O índice a mantém barata mesmo numa sala que já viu
   muita gente passar. */
const indice = `
  CREATE INDEX IF NOT EXISTS ix_convidados_estado
    ON sala_convidados (sala_id, estado);
`;

const extra = { sqlite: indice, pg: indice };

module.exports = { versao, sql, extra };
