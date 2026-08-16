/* ==========================================================================
   repositorios/presenca.js — quem está online, de verdade (§6)

   O briefing avisa: "não confie apenas em um campo manual". A razão é que um
   campo manual só sabe o que a pessoa CLICOU. Ele não sabe que o notebook foi
   fechado, que o wi-fi caiu no elevador ou que a aba morreu — e nesses casos
   ele mente para todos os colegas, indefinidamente.

   ---------------------------------------------------------------------------
   DUAS FONTES, QUE NÃO SE MISTURAM

     `manual`     — a escolha da pessoa: online, ocupado, ausente.
                    Sobrevive à desconexão: quem se marcou "ocupado" continua
                    ocupado ao voltar, sem ter de marcar de novo.

     `expira_em`  — o sinal de vida, renovado pelo PONG do WebSocket.
                    Não é renovado por nada que o cliente possa falsificar sem
                    manter a conexão aberta.

   ---------------------------------------------------------------------------
   O STATUS EFETIVO É CALCULADO, NUNCA GRAVADO

   Esta é a decisão que evita o defeito clássico de lista de presença:

       if (expira_em > agora) → o que a pessoa escolheu
       senão                  → OFFLINE

   Gravar "offline" numa coluna exigiria que ALGUÉM rodasse para gravá-lo. E o
   dia em que o processo morre de repente — deploy, `pkill`, OOM — ninguém
   roda, e o banco fica dizendo que doze pessoas estão online para sempre. Com
   o cálculo, um processo morto faz todo mundo virar offline sozinho em 60 s,
   sem nenhuma faxina precisar acontecer.

   ---------------------------------------------------------------------------
   MULTI-SESSÃO (computador + celular + duas abas)

   `conexoes` conta quantos canais a pessoa tem abertos. Ele NÃO é a autoridade
   sobre presença — `expira_em` é. O contador serve para uma coisa só: saber se
   a aba que fechou era a ÚLTIMA, e então aplicar a carência antes de deixar o
   sinal expirar. Sem carência, trocar de aba faria o status piscar na tela de
   todos os colegas.

   E ele é advisory de propósito: se um processo morrer sem decrementar, o
   contador fica alto e não estraga nada, porque quem decide é o sinal de vida.
   ========================================================================== */
"use strict";

const { agora } = require("../banco.js");

const VALIDOS = new Set(["online", "ocupado", "ausente", "offline"]);

/* Calcula o status efetivo a partir da linha crua. É UMA função, usada por
   todo lugar que precisa da resposta — porque duas implementações desta regra
   divergiriam, e a divergência apareceria como "a lista diz online e o cabeçalho
   diz offline" na mesma tela. */
function efetivo(linha, t = agora()) {
  if (!linha) return "offline";
  if (!linha.expira_em || linha.expira_em <= t) return "offline";
  /* Quem escolheu "offline" fica offline mesmo conectado — é o modo invisível,
     e respeitá-lo é o mínimo. */
  return VALIDOS.has(linha.manual) ? linha.manual : "online";
}

function criar(Q) {
  async function garantirLinha(usuarioId) {
    const existe = await Q.get("SELECT usuario_id FROM usuario_status WHERE usuario_id = ?", usuarioId);
    if (!existe) {
      await Q.run(
        "INSERT INTO usuario_status (usuario_id, manual, expira_em, conexoes, visto_em) VALUES (?, 'online', 0, 0, ?)",
        usuarioId, agora());
    }
  }

  return {
    efetivo,

    /* ======================================================================
       CONECTOU — soma um canal e acende o sinal de vida.
       ====================================================================== */
    async abriuCanal(usuarioId, validadeMs) {
      await garantirLinha(usuarioId);
      const t = agora();
      await Q.run(
        `UPDATE usuario_status
            SET conexoes = conexoes + 1, expira_em = ?, visto_em = ?
          WHERE usuario_id = ?`,
        t + validadeMs, t, usuarioId);
    },

    /* PONG — a única coisa que renova o sinal de vida.

       Repare que não é "recebi qualquer mensagem": é o pong. Uma aba
       congelada pelo navegador (celular no bolso) pode ter o socket de pé sem
       executar JavaScript nenhum; o pong é respondido pela camada do
       protocolo, então ele prova que o CANAL vive. É o mais próximo de
       "presença real" que dá para ter sem inventar. */
    async batimento(usuarioId, validadeMs) {
      const t = agora();
      const r = await Q.run(
        "UPDATE usuario_status SET expira_em = ?, visto_em = ? WHERE usuario_id = ?",
        t + validadeMs, t, usuarioId);
      if (!r.linhas) { await garantirLinha(usuarioId); }
    },

    /* ======================================================================
       DESCONECTOU

       `restantes` é quantos canais AINDA existem para essa pessoa neste
       processo. Só quando chega a zero é que a carência começa a correr — e
       mesmo aí não gravamos "offline": apenas encurtamos a validade do sinal.
       Quem declara o offline é o tempo, como sempre.
       ====================================================================== */
    async fechouCanal(usuarioId, restantes, carenciaMs) {
      const t = agora();
      if (restantes > 0) {
        await Q.run(
          "UPDATE usuario_status SET conexoes = ?, visto_em = ? WHERE usuario_id = ?",
          restantes, t, usuarioId);
        return false;
      }
      await Q.run(
        `UPDATE usuario_status
            SET conexoes = 0, visto_em = ?,
                expira_em = CASE WHEN expira_em > ? THEN ? ELSE expira_em END
          WHERE usuario_id = ?`,
        t, t + carenciaMs, t + carenciaMs, usuarioId);
      return true;
    },

    /* ======================================================================
       ESCOLHA MANUAL (§7)
       ====================================================================== */
    async definirManual(usuarioId, status) {
      if (!VALIDOS.has(status)) throw new Error("status inválido");
      await garantirLinha(usuarioId);
      await Q.run("UPDATE usuario_status SET manual = ?, visto_em = ? WHERE usuario_id = ?",
        status, agora(), usuarioId);
      return status;
    },

    /* ======================================================================
       LEITURA

       Sempre em LOTE. A tela precisa do status de 40 colegas de uma vez, e
       40 consultas separadas seriam 40 idas ao banco por abertura de tela —
       o tipo de coisa que só dói quando a empresa cresce.
       ====================================================================== */
    async de(usuarioId) {
      const l = await Q.get(
        "SELECT manual, expira_em, conexoes, visto_em FROM usuario_status WHERE usuario_id = ?", usuarioId);
      return { status: efetivo(l), manual: l?.manual || "online", vistoEm: l?.visto_em || 0 };
    },

    async deVarios(ids) {
      if (!ids?.length) return new Map();
      const marcas = ids.map(() => "?").join(",");
      const linhas = await Q.all(
        `SELECT usuario_id, manual, expira_em, visto_em
           FROM usuario_status WHERE usuario_id IN (${marcas})`, ...ids);
      const t = agora();
      const mapa = new Map();
      for (const l of linhas) mapa.set(l.usuario_id, { status: efetivo(l, t), vistoEm: l.visto_em || 0 });
      /* Quem nunca abriu o chat não tem linha — e "sem linha" é offline, não
         é ausência de informação. Devolver o mapa incompleto faria a tela
         escolher um padrão próprio, e telas diferentes escolheriam diferente. */
      for (const id of ids) if (!mapa.has(id)) mapa.set(id, { status: "offline", vistoEm: 0 });
      return mapa;
    },

    /* Quem está online agora, para a barra lateral. */
    async online(contextoId, limite = 100) {
      return Q.all(
        `SELECT u.id, u.nome, u.sobrenome, u.avatar, u.cargo, s.manual
           FROM usuario_status s
           JOIN usuarios u ON u.id = s.usuario_id
          WHERE u.contexto_id = ? AND u.situacao = 'ativa'
            AND s.expira_em > ? AND s.manual <> 'offline'
          ORDER BY u.nome LIMIT ?`,
        contextoId, agora(), limite);
    },

    /* Faxina na partida do processo: quem tinha canal aberto neste processo
       não tem mais, porque o processo é outro. Zera só o CONTADOR — o sinal de
       vida continua expirando sozinho, e quem estiver de fato conectado a
       outro processo não é afetado. */
    async zerarContadores() {
      await Q.run("UPDATE usuario_status SET conexoes = 0 WHERE conexoes <> 0");
    },
  };
}

module.exports = { criar, efetivo };
