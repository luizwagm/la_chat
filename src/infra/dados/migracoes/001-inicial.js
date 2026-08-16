/* ==========================================================================
   001-inicial — o esquema do chat

   Escrito UMA vez, num SQL que os dois motores entendem. Onde eles divergem,
   há um bloco extra por motor no fim do arquivo — e a divergência está
   explicada, nunca escondida.

   ---------------------------------------------------------------------------
   AS TRÊS DECISÕES QUE MOLDAM TUDO AQUI

   1. seq — UM CONTADOR POR CONVERSA, VINDO DO BANCO

      Cada mensagem recebe um número inteiro sequencial DENTRO da conversa
      (1, 2, 3…), atribuído dentro da transação que grava a mensagem.

      Ele resolve quatro problemas de uma vez, e é por isso que existe:
        · ORDEM — a tela ordena por seq, não por relógio. Relógio de
          servidor pula (NTP), e relógio de cliente é mentira do usuário.
        · RETOMADA — reconectou? "me dê tudo com seq > 830". Uma comparação,
          com índice. É isto que faz o §25 funcionar.
        · NÃO LIDAS — ultima_seq - ultima_lida_seq. Sem contador para
          dessincronizar.
        · BURACO — se o cliente recebe 831 e 833, ele SABE que perdeu a 832 e
          pede. Sem seq, mensagem perdida é silenciosa.

      Vem do banco, e não da memória do processo, porque no dia em que houver
      dois processos a memória de cada um daria a mesma numeração para
      mensagens diferentes.

   2. ESTADO DE LEITURA POR MARCA D'ÁGUA — e não uma linha por mensagem

      O §21 do briefing pede uma tabela message_status. Ela NÃO existe aqui,
      e a troca é deliberada.

      Uma linha por (mensagem × destinatário) num grupo de 30 pessoas com
      100.000 mensagens são TRÊS MILHÕES de linhas que só dizem "li". Elas
      crescem mais rápido que as próprias mensagens, e são escritas em rajada
      toda vez que alguém abre uma conversa antiga.

      Como seq é contíguo e crescente, dois inteiros por membro dizem a mesma
      coisa com exatidão total:

          ultima_entregue_seq = 831   → tudo até 831 chegou no aparelho
          ultima_lida_seq     = 824   → tudo até 824 foi visto

      O estado de UMA mensagem sai daí: para o autor, a mensagem seq=800 está
      LIDA quando todos os outros membros têm ultima_lida_seq >= 800. É uma
      consulta sobre conversa_membros, que tem uma linha por pessoa — não
      três milhões.

      O que se perde: o instante exato em que cada pessoa leu cada mensagem.
      Guarda-se o instante da marca d'água, que é o que a tela mostra
      ("visto às 09:41"). Auditoria de leitura mensagem a mensagem, se um dia
      for exigida por contrato, entra como tabela própria e OPCIONAL — não como
      peso permanente no caminho quente.

   3. CONTEXTO EM TUDO (§22)

      contexto_id está em usuários, conversas e mensagens — inclusive onde é
      redundante (a conversa já diz o contexto). A redundância é a defesa: toda
      consulta filtra por contexto, e uma consulta que esqueça o filtro devolve
      vazio em vez de devolver dados de outra empresa.
   ========================================================================== */
"use strict";

const versao = "001-inicial";

const sql = `

/* ==========================================================================
   CONTEXTOS — o inquilino (§22)
   Uma instalação típica tem um só. A coluna existe desde o primeiro dia porque
   acrescentar isolamento depois exige reescrever toda consulta do sistema.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS contextos (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  ativo       INTEGER NOT NULL DEFAULT 1,
  criado_em   BIGINT NOT NULL
);

/* ==========================================================================
   USUÁRIOS

   externo_id é quem a pessoa é NO HOSPEDEIRO. O chat não guarda senha e não
   tem login próprio: quem autentica é o site, e o passe assinado traz este id.
   Não há coluna de senha em lugar nenhum deste esquema — de propósito.

   email chega CIFRADO (AES-256-GCM). É dado pessoal, e um banco de chat
   vazado não deve entregar a lista de e-mails da empresa de brinde.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS usuarios (
  id             TEXT PRIMARY KEY,
  contexto_id    TEXT NOT NULL REFERENCES contextos(id),
  externo_id     TEXT NOT NULL,
  nome           TEXT NOT NULL,
  sobrenome      TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  avatar         TEXT NOT NULL DEFAULT '',
  cargo          TEXT NOT NULL DEFAULT '',
  departamento   TEXT NOT NULL DEFAULT '',
  papel          TEXT NOT NULL DEFAULT 'membro',
  situacao       TEXT NOT NULL DEFAULT 'ativa',
  ultimo_acesso  BIGINT,
  criado_em      BIGINT NOT NULL,
  atualizado_em  BIGINT NOT NULL,
  CHECK (papel IN ('membro','admin')),
  CHECK (situacao IN ('ativa','bloqueada','desativada'))
);

/* A mesma pessoa do hospedeiro é UMA pessoa aqui. Sem este índice, dois
   passes emitidos ao mesmo tempo (duas abas abrindo o chat juntas) criariam
   dois usuários para o mesmo funcionário, e as conversas dele se dividiriam
   entre os dois — sem erro nenhum aparecendo. */
CREATE UNIQUE INDEX IF NOT EXISTS ix_usuarios_externo
  ON usuarios (contexto_id, externo_id);

/* Busca de pessoa pela barra lateral. */
CREATE INDEX IF NOT EXISTS ix_usuarios_nome ON usuarios (contexto_id, nome);

/* ==========================================================================
   PREFERÊNCIAS — uma linha por pessoa
   ========================================================================== */
CREATE TABLE IF NOT EXISTS usuario_preferencias (
  usuario_id     TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  som            INTEGER NOT NULL DEFAULT 1,
  notificacoes   INTEGER NOT NULL DEFAULT 1,
  tema           TEXT NOT NULL DEFAULT 'sistema',
  atualizado_em  BIGINT NOT NULL,
  CHECK (tema IN ('sistema','claro','escuro'))
);

/* ==========================================================================
   STATUS (§6)

   Duas fontes que NÃO se confundem:
     manual  — o que a pessoa escolheu ("ocupado"). Sobrevive a desconexão.
     expira_em — sinal de vida. Renovado pelo pong do WebSocket.

   O status EFETIVO é calculado, nunca gravado: se expira_em já passou, a
   pessoa está offline por mais que ela tenha escolhido "online". Gravar o
   efetivo criaria a possibilidade de ele ficar errado para sempre quando um
   processo caísse sem limpar nada — que é exatamente como se ganha uma lista
   de pessoas eternamente online.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS usuario_status (
  usuario_id     TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  manual         TEXT NOT NULL DEFAULT 'online',
  expira_em      BIGINT NOT NULL DEFAULT 0,
  conexoes       INTEGER NOT NULL DEFAULT 0,
  visto_em       BIGINT NOT NULL DEFAULT 0,
  CHECK (manual IN ('online','ocupado','ausente','offline'))
);
CREATE INDEX IF NOT EXISTS ix_status_expira ON usuario_status (expira_em);

/* ==========================================================================
   SESSÕES

   GRAVADAS, ao contrário do resto do parque, que guarda sessão em memória.
   O motivo está na análise: um painel de gestão pode pedir login de novo
   depois de um deploy; um chat aberto o dia inteiro, não — cair a cada deploy
   seria sentido como defeito.

   token_hash, nunca o token. Quem ler o banco (backup, dump, SELECT) não
   consegue se passar por ninguém. É a mesma regra da senha, aplicada à sessão.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS sessoes (
  id           TEXT PRIMARY KEY,
  usuario_id   TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  ip_hash      TEXT NOT NULL DEFAULT '',
  agente       TEXT NOT NULL DEFAULT '',
  criada_em    BIGINT NOT NULL,
  ultimo_uso   BIGINT NOT NULL,
  expira_em    BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_sessoes_token ON sessoes (token_hash);
CREATE INDEX IF NOT EXISTS ix_sessoes_usuario ON sessoes (usuario_id);
CREATE INDEX IF NOT EXISTS ix_sessoes_expira ON sessoes (expira_em);

/* ==========================================================================
   PASSES JÁ USADOS — trava de repetição (replay)

   O passe emitido pelo hospedeiro vale 60 s. Dentro desses 60 s ele poderia
   ser reapresentado por quem o interceptasse. Guardar o jti até ele expirar
   faz o segundo uso ser recusado.

   A tabela é minúscula por construção: só cabem nela os passes dos últimos
   60 segundos, e a faxina roda junto com a das sessões.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS passes_usados (
  jti        TEXT PRIMARY KEY,
  expira_em  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_passes_expira ON passes_usados (expira_em);

/* ==========================================================================
   CONVERSAS

   tipo nasce com 'direta' e 'grupo' desde o primeiro dia, e a tabela de
   membros aceita N pessoas mesmo quando são 2. Transformar 1‑para‑1 em grupo
   depois seria migração de dados; nascer com N e usar 2 não custa nada.

   chave_direta é o que impede DUAS conversas entre as mesmas duas pessoas.
   Sem ela, dois cliques simultâneos em "conversar" criam duas conversas, e as
   mensagens se dividem entre elas — cada lado vendo metade do assunto, sem
   erro nenhum na tela. É índice único porque a corrida acontece no banco, e é
   no banco que ela tem de ser perdida.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS conversas (
  id                 TEXT PRIMARY KEY,
  contexto_id        TEXT NOT NULL REFERENCES contextos(id),
  tipo               TEXT NOT NULL DEFAULT 'direta',
  titulo             TEXT NOT NULL DEFAULT '',
  chave_direta       TEXT,
  criada_por         TEXT REFERENCES usuarios(id),
  criada_em          BIGINT NOT NULL,
  ultima_seq         BIGINT NOT NULL DEFAULT 0,
  ultima_mensagem_em BIGINT NOT NULL DEFAULT 0,
  apagada_em         BIGINT,
  CHECK (tipo IN ('direta','grupo'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_conversas_direta ON conversas (chave_direta);

/* ==========================================================================
   MEMBROS — e as duas marcas d'água (ver o cabeçalho, decisão 2)
   ========================================================================== */
CREATE TABLE IF NOT EXISTS conversa_membros (
  conversa_id          TEXT NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  usuario_id           TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  papel                TEXT NOT NULL DEFAULT 'membro',
  entrou_em            BIGINT NOT NULL,
  saiu_em              BIGINT,
  ultima_lida_seq      BIGINT NOT NULL DEFAULT 0,
  ultima_entregue_seq  BIGINT NOT NULL DEFAULT 0,
  lida_em              BIGINT NOT NULL DEFAULT 0,
  silenciada           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversa_id, usuario_id),
  CHECK (papel IN ('membro','admin'))
);

/* A consulta mais quente do sistema é "quais conversas eu tenho?". Este índice
   é o que faz a barra lateral abrir sem varrer a tabela inteira. */
CREATE INDEX IF NOT EXISTS ix_membros_usuario ON conversa_membros (usuario_id, conversa_id);

/* ==========================================================================
   MENSAGENS

   corpo é CIFRADO. formato diz como interpretar o texto depois de
   decifrado ('texto' ou 'md' — markdown restrito, já sanitizado na gravação).

   As colunas de expansão do §54 já existem e estão VAZIAS: responde_a,
   encaminhada_de, editada_em, apagada_em. Criá-las agora custa nada;
   acrescentá-las depois, numa tabela de milhões de linhas, custa uma janela de
   manutenção.

   id_cliente é o ULID que o NAVEGADOR gera antes de enviar. É ele que faz o
   reenvio após reconexão não duplicar: o servidor reconhece o id e devolve a
   mensagem que já gravou, em vez de gravar outra. Sem isso, o §25 é
   impossível — quem reenvia por precaução duplica, e quem não reenvia perde.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS mensagens (
  id              TEXT PRIMARY KEY,
  conversa_id     TEXT NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  contexto_id     TEXT NOT NULL,
  autor_id        TEXT NOT NULL REFERENCES usuarios(id),
  seq             BIGINT NOT NULL,
  tipo            TEXT NOT NULL DEFAULT 'texto',
  corpo           TEXT NOT NULL DEFAULT '',
  formato         TEXT NOT NULL DEFAULT 'md',
  id_cliente      TEXT NOT NULL DEFAULT '',
  responde_a      TEXT REFERENCES mensagens(id),
  encaminhada_de  TEXT,
  criada_em       BIGINT NOT NULL,
  editada_em      BIGINT,
  apagada_em      BIGINT,
  apagada_por     TEXT,
  CHECK (tipo IN ('texto','arquivo','imagem','sistema'))
);

/* O ÍNDICE MAIS IMPORTANTE DO SISTEMA.
   Serve a três caminhos quentes de uma vez: abrir a conversa (últimas N),
   paginar para trás (seq < cursor) e retomar após reconexão (seq > marca). */
CREATE UNIQUE INDEX IF NOT EXISTS ix_mensagens_conversa_seq ON mensagens (conversa_id, seq);

/* Deduplicação do reenvio. Único por (conversa, autor, id do cliente): dois
   POSTs iguais chegando juntos — que é o caso do clique duplo e da reconexão —
   perdem no banco, não no if da aplicação. */
CREATE UNIQUE INDEX IF NOT EXISTS ix_mensagens_id_cliente
  ON mensagens (conversa_id, autor_id, id_cliente);

CREATE INDEX IF NOT EXISTS ix_mensagens_autor ON mensagens (autor_id, criada_em);

/* ==========================================================================
   ÍNDICE CEGO DA BUSCA (§16)

   Uma linha por (mensagem × palavra distinta). Não guarda a palavra: guarda o
   HMAC dela. Ver seguranca/indice-cego.js, que explica o que isto vaza e o
   que não vaza.

   conversa_id está repetido aqui de propósito: sem ele, buscar exigiria
   juntar com mensagens só para descobrir se a pessoa pode ver aquela linha —
   e o filtro de autorização ficaria DEPOIS do índice, que é onde ele custa caro.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS mensagem_tokens (
  mensagem_id  TEXT NOT NULL REFERENCES mensagens(id) ON DELETE CASCADE,
  conversa_id  TEXT NOT NULL,
  token        TEXT NOT NULL,
  PRIMARY KEY (mensagem_id, token)
);
CREATE INDEX IF NOT EXISTS ix_tokens_busca ON mensagem_tokens (token, conversa_id);

/* ==========================================================================
   ANEXOS (§11)

   caminho é o nome GERADO no disco — nunca o que o usuário enviou. nome é
   o original, cifrado (nome de arquivo revela assunto: "demissao-joao.pdf").

   hash permite detectar o mesmo arquivo enviado duas vezes e, mais
   importante, confere integridade no download: byte trocado no disco vira erro
   em vez de arquivo corrompido entregue como se estivesse bom.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS anexos (
  id           TEXT PRIMARY KEY,
  mensagem_id  TEXT REFERENCES mensagens(id) ON DELETE CASCADE,
  conversa_id  TEXT NOT NULL,
  enviado_por  TEXT NOT NULL REFERENCES usuarios(id),
  nome         TEXT NOT NULL,
  tipo_mime    TEXT NOT NULL,
  tamanho      BIGINT NOT NULL,
  caminho      TEXT NOT NULL,
  hash         TEXT NOT NULL DEFAULT '',
  largura      INTEGER,
  altura       INTEGER,
  miniatura    TEXT NOT NULL DEFAULT '',
  criado_em    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_anexos_mensagem ON anexos (mensagem_id);
CREATE INDEX IF NOT EXISTS ix_anexos_conversa ON anexos (conversa_id);

/* ==========================================================================
   NOTIFICAÇÕES (§41)

   Guardadas para que quem estava offline receba ao voltar, e para que o mesmo
   aviso não seja mostrado duas vezes em dois aparelhos.
   ========================================================================== */
CREATE TABLE IF NOT EXISTS notificacoes (
  id           TEXT PRIMARY KEY,
  usuario_id   TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  conversa_id  TEXT,
  mensagem_id  TEXT,
  tipo         TEXT NOT NULL DEFAULT 'mensagem',
  entregue_em  BIGINT,
  lida_em      BIGINT,
  criada_em    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notif_pendentes ON notificacoes (usuario_id, lida_em);

/* ==========================================================================
   AUDITORIA (§31)

   O que ela NÃO guarda é tão importante quanto o que guarda: nenhum corpo de
   mensagem, nenhum nome de arquivo, nenhum e-mail. Um log de auditoria que
   copia o conteúdo vira uma segunda cópia não cifrada de tudo — e ninguém
   pensa nele na hora de proteger o sistema.

   O IP vai em HASH: responde "foram 400 tentativas do mesmo lugar" sem manter
   um cadastro de onde cada funcionário estava a cada hora (§34).
   ========================================================================== */
CREATE TABLE IF NOT EXISTS auditoria (
  id           TEXT PRIMARY KEY,
  contexto_id  TEXT NOT NULL,
  usuario_id   TEXT,
  evento       TEXT NOT NULL,
  alvo_tipo    TEXT NOT NULL DEFAULT '',
  alvo_id      TEXT NOT NULL DEFAULT '',
  ip_hash      TEXT NOT NULL DEFAULT '',
  detalhe      TEXT NOT NULL DEFAULT '',
  criado_em    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_auditoria_tempo ON auditoria (contexto_id, criado_em);
CREATE INDEX IF NOT EXISTS ix_auditoria_usuario ON auditoria (usuario_id, criado_em);
CREATE INDEX IF NOT EXISTS ix_auditoria_evento ON auditoria (evento, criado_em);
`;

/* ==========================================================================
   ONDE OS MOTORES DIVERGEM

   Só duas coisas, e as duas são otimização — o esquema acima funciona sem elas.
   ========================================================================== */
const extra = {
  sqlite: `
    /* Nada específico. As PRAGMAs importantes (WAL, foreign_keys, busy_timeout)
       são aplicadas na ABERTURA da conexão, e não aqui: PRAGMA gravada numa
       migração valeria só para a conexão que rodou a migração. */
  `,

  pg: `
    /* Índice PARCIAL: a busca só percorre conversa viva. No PostgreSQL isso
       tira as apagadas do índice, que fica menor e mais rápido. O SQLite
       também aceita índice parcial, mas o ganho lá é pequeno o bastante para
       não valer a divergência de esquema. */
    CREATE INDEX IF NOT EXISTS ix_conversas_vivas
      ON conversas (contexto_id, ultima_mensagem_em DESC)
      WHERE apagada_em IS NULL;
  `,
};

module.exports = { versao, sql, extra };
