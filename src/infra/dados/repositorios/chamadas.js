/* ==========================================================================
   repositorios/chamadas.js

   O esqueleto da reunião: quem chamou, quem entrou, quando, por quanto tempo.
   **Nenhum byte de mídia passa por aqui** — em malha, o vídeo vai direto de um
   navegador ao outro e o servidor nunca o vê. Ver 003-chamadas.js.
   ========================================================================== */
"use strict";

const { ulid, ehUlid } = require("../../../dominio/ids.js");
const { agora } = require("../banco.js");
const dom = require("../../../dominio/chamadas.js");

function criar(Q) {
  const repo = {
    /* ======================================================================
       ABRIR

       A CORRIDA: duas pessoas clicam em "chamar" no mesmo segundo. Sem trava
       nascem duas chamadas, cada uma numa sala, e as duas tocam para o mesmo
       grupo — ninguém encontra ninguém.

       Quem arbitra é o índice único parcial `ix_chamada_viva`. O INSERT
       perdedor estoura, e aqui a gente RELÊ: o resultado correto para quem
       chamou é "a chamada é esta", não um erro. É a mesma forma da
       `chave_direta` das conversas diretas.
       ====================================================================== */
    async abrir({ contextoId, conversaId, iniciadaPor, tipo = "direta", membros = [] }) {
      const viva = await repo.viva(conversaId);
      if (viva) return { chamada: viva, jaExistia: true };

      const id = ulid();
      const t = agora();

      try {
        await Q.transacao(async (T) => {
          await T.run(
            `INSERT INTO chamadas (id, contexto_id, conversa_id, iniciada_por, tipo,
                                   estado, iniciada_em, pico)
             VALUES (?, ?, ?, ?, ?, 'tocando', ?, 0)`,
            id, contextoId, conversaId, iniciadaPor, tipo, t);

          /* Quem iniciou já entra DENTRO: ele não precisa atender a própria
             chamada. Os outros nascem `convidado` e viram `tocando` quando o
             transporte confirma que há socket aberto para eles. */
          for (const u of [...new Set([iniciadaPor, ...membros])]) {
            const ehDono = u === iniciadaPor;
            await T.run(
              `INSERT INTO chamada_participantes
                 (chamada_id, usuario_id, estado, entrou_em, microfone, camera, tela)
               VALUES (?, ?, ?, ?, 1, 1, 0)`,
              id, u, ehDono ? "dentro" : "convidado", ehDono ? t : null);
          }

          await T.run("UPDATE chamadas SET pico = 1 WHERE id = ?", id);
        });
      } catch (e) {
        const nascida = await repo.viva(conversaId);
        if (nascida) return { chamada: nascida, jaExistia: true };
        throw e;
      }

      return { chamada: await repo.porIdCru(id), jaExistia: false };
    },

    /* A chamada viva de uma conversa. `estado <> 'encerrada'` é exatamente o
       predicado do índice único — as duas coisas têm de continuar iguais, ou a
       trava passa a proteger uma condição diferente da que se consulta. */
    async viva(conversaId) {
      if (!ehUlid(conversaId)) return null;
      return Q.get(
        "SELECT * FROM chamadas WHERE conversa_id = ? AND estado <> 'encerrada'", conversaId);
    },

    async porIdCru(id) {
      return Q.get("SELECT * FROM chamadas WHERE id = ?", id);
    },

    /* Com o contexto, para a rota HTTP: id de outra empresa devolve nada. */
    async porId(contextoId, id) {
      if (!ehUlid(id)) return null;
      return Q.get("SELECT * FROM chamadas WHERE id = ? AND contexto_id = ?", id, contextoId);
    },

    /* ======================================================================
       PARTICIPANTES
       ====================================================================== */
    async participantes(chamadaId) {
      return Q.all(
        `SELECT p.usuario_id, p.estado, p.entrou_em, p.saiu_em,
                p.microfone, p.camera, p.tela,
                u.nome, u.sobrenome, u.avatar
           FROM chamada_participantes p
           JOIN usuarios u ON u.id = p.usuario_id
          WHERE p.chamada_id = ?
          ORDER BY p.entrou_em`, chamadaId);
    },

    async participante(chamadaId, usuarioId) {
      return Q.get(
        "SELECT * FROM chamada_participantes WHERE chamada_id = ? AND usuario_id = ?",
        chamadaId, usuarioId);
    },

    /* Só os ids de quem está DENTRO — é o que o fan-out e a conta de vagas
       precisam, e puxar nome e foto a cada evento carregaria o banco à toa. */
    async dentro(chamadaId) {
      const linhas = await Q.all(
        "SELECT usuario_id FROM chamada_participantes WHERE chamada_id = ? AND estado = 'dentro'",
        chamadaId);
      return linhas.map((l) => l.usuario_id);
    },

    async quantosDentro(chamadaId) {
      const r = await Q.get(
        "SELECT COUNT(*) AS n FROM chamada_participantes WHERE chamada_id = ? AND estado = 'dentro'",
        chamadaId);
      return Number(r?.n || 0);
    },

    /* ======================================================================
       ACRESCENTAR ALGUÉM A UMA CHAMADA JÁ ABERTA

       Existe para a sala por link: o convidado não estava na conversa quando a
       chamada começou, então não tem linha de participante — e sem ela o
       `entrar` recusa com "nao_convidado", que é o comportamento certo para
       todo o resto do sistema.

       `INSERT` idempotente: entrar duas vezes (recarregar a página) não pode
       criar duas linhas nem estourar.
       ====================================================================== */
    async acrescentarParticipante(chamadaId, usuarioId) {
      const existe = await repo.participante(chamadaId, usuarioId);
      if (existe) return false;
      await Q.run(
        `INSERT INTO chamada_participantes (chamada_id, usuario_id, estado, microfone, camera, tela)
         VALUES (?, ?, 'convidado', 1, 1, 0)`,
        chamadaId, usuarioId);
      return true;
    },

    /* ======================================================================
       ENTRAR — a transição que precisa de trava

       O teto da malha é conferido DENTRO da transação, junto com a gravação.
       Conferir antes e gravar depois deixa a janela clássica: sete pessoas
       clicam "entrar" ao mesmo tempo, as sete leem "cabem 6" e as sete entram.

       `BEGIN IMMEDIATE` no SQLite e o UPDATE travando a linha no PostgreSQL
       fazem a sétima esperar a sexta terminar — e aí ela lê 6 e é recusada.
       ====================================================================== */
    async entrar(chamadaId, usuarioId, teto) {
      const t = agora();
      let resultado = { ok: false, motivo: "" };

      await Q.transacao(async (T) => {
        const p = await T.get(
          "SELECT estado FROM chamada_participantes WHERE chamada_id = ? AND usuario_id = ?",
          chamadaId, usuarioId);
        if (!p) { resultado = { ok: false, motivo: "nao_convidado" }; return; }

        /* Já está dentro: entrar de novo é idempotente, não é erro. Acontece
           quando a aba recarrega e o cliente reenvia por precaução. */
        if (p.estado === "dentro") { resultado = { ok: true, repetido: true }; return; }

        if (!dom.podeIrPara(p.estado, "dentro")) {
          resultado = { ok: false, motivo: "estado_invalido" };
          return;
        }

        const c = await T.get("SELECT estado FROM chamadas WHERE id = ?", chamadaId);
        if (!c || c.estado === "encerrada") { resultado = { ok: false, motivo: "encerrada" }; return; }

        const n = await T.get(
          "SELECT COUNT(*) AS n FROM chamada_participantes WHERE chamada_id = ? AND estado = 'dentro'",
          chamadaId);
        const vaga = dom.cabe(Number(n?.n || 0), teto);
        if (!vaga.ok) { resultado = { ok: false, motivo: "lotada", detalhe: vaga.motivo }; return; }

        await T.run(
          `UPDATE chamada_participantes
              SET estado = 'dentro', entrou_em = COALESCE(entrou_em, ?), saiu_em = NULL
            WHERE chamada_id = ? AND usuario_id = ?`,
          t, chamadaId, usuarioId);

        /* A primeira pessoa a entrar (além de quem chamou) faz a chamada
           deixar de tocar e virar reunião. `atendida_em` só é gravado uma vez —
           é ele que mede a duração no histórico. */
        await T.run(
          `UPDATE chamadas
              SET estado = 'ativa', atendida_em = COALESCE(atendida_em, ?)
            WHERE id = ? AND estado = 'tocando'`,
          t, chamadaId);

        const dentroAgora = Number(n?.n || 0) + 1;
        await T.run("UPDATE chamadas SET pico = ? WHERE id = ? AND pico < ?",
          dentroAgora, chamadaId, dentroAgora);

        resultado = { ok: true, dentro: dentroAgora };
      });

      return resultado;
    },

    /* ======================================================================
       SAIR, RECUSAR, PERDER
       ====================================================================== */
    async mudarEstado(chamadaId, usuarioId, novo) {
      const p = await repo.participante(chamadaId, usuarioId);
      if (!p) return false;
      if (p.estado === novo) return true;
      if (!dom.podeIrPara(p.estado, novo)) return false;

      const t = agora();
      const saindo = novo === "saiu";
      await Q.run(
        `UPDATE chamada_participantes
            SET estado = ?, saiu_em = ${saindo ? "?" : "saiu_em"}
          WHERE chamada_id = ? AND usuario_id = ?`,
        ...(saindo ? [novo, t, chamadaId, usuarioId] : [novo, chamadaId, usuarioId]));
      return true;
    },

    /* Quem tem socket aberto passa de `convidado` para `tocando`. Serve só para
       a tela do autor mostrar "chamando…" em vez de "aguardando" — e para o
       histórico distinguir quem nem recebeu o toque. */
    async marcarTocando(chamadaId, usuarioIds) {
      if (!usuarioIds?.length) return;
      const marcas = usuarioIds.map(() => "?").join(",");
      await Q.run(
        `UPDATE chamada_participantes SET estado = 'tocando'
          WHERE chamada_id = ? AND estado = 'convidado' AND usuario_id IN (${marcas})`,
        chamadaId, ...usuarioIds);
    },

    /* ======================================================================
       DISPOSITIVOS

       Guardado no banco, e não só empurrado pelo socket, porque quem entra no
       MEIO da reunião precisa saber quem já está mudo. Empurrando só o evento,
       cada pessoa veria um estado diferente conforme a hora em que chegou.
       ====================================================================== */
    async definirDispositivos(chamadaId, usuarioId, { microfone, camera, tela }) {
      const partes = [];
      const valores = [];
      if (microfone !== undefined) { partes.push("microfone = ?"); valores.push(microfone ? 1 : 0); }
      if (camera !== undefined) { partes.push("camera = ?"); valores.push(camera ? 1 : 0); }
      if (tela !== undefined) { partes.push("tela = ?"); valores.push(tela ? 1 : 0); }
      if (!partes.length) return false;

      const r = await Q.run(
        `UPDATE chamada_participantes SET ${partes.join(", ")}
          WHERE chamada_id = ? AND usuario_id = ? AND estado = 'dentro'`,
        ...valores, chamadaId, usuarioId);
      return r.linhas > 0;
    },

    /* ======================================================================
       ENCERRAR
       ====================================================================== */
    async encerrar(chamadaId, motivo) {
      const t = agora();
      const r = await Q.run(
        `UPDATE chamadas SET estado = 'encerrada', encerrada_em = ?, motivo = ?
          WHERE id = ? AND estado <> 'encerrada'`,
        t, String(motivo || "normal").slice(0, 30), chamadaId);

      if (r.linhas) {
        /* Ninguém fica "dentro" de uma chamada encerrada. Sem esta linha, a
           lista de participantes de uma chamada morta continuaria dizendo que
           há gente lá — e a conta de "quem está em reunião" nunca zeraria. */
        await Q.run(
          `UPDATE chamada_participantes SET estado = 'saiu', saiu_em = COALESCE(saiu_em, ?)
            WHERE chamada_id = ? AND estado IN ('dentro','tocando','convidado')`,
          t, chamadaId);
      }
      return r.linhas > 0;
    },

    /* ======================================================================
       FAXINA — as chamadas que ninguém encerrou

       Elas existem porque o encerramento normal depende de um cliente avisar,
       e cliente some: aba fechada no susto, notebook que dormiu, servidor
       reiniciado no meio da reunião.

       Sem isto, o índice único `ix_chamada_viva` viraria uma trava permanente:
       a conversa teria uma chamada "tocando" para sempre e ninguém conseguiria
       abrir outra. O sintoma seria "o botão de chamar não faz nada".
       ====================================================================== */
    async fantasmas({ tocandoMs, abandonoMs }) {
      const t = agora();
      return Q.all(
        `SELECT id, conversa_id, estado, iniciada_em, atendida_em
           FROM chamadas
          WHERE estado <> 'encerrada'
            AND ( (estado = 'tocando' AND iniciada_em < ?)
               OR (estado = 'ativa'
                   AND NOT EXISTS (SELECT 1 FROM chamada_participantes p
                                    WHERE p.chamada_id = chamadas.id AND p.estado = 'dentro')
                   AND iniciada_em < ?) )`,
        t - tocandoMs, t - abandonoMs);
    },

    /* Histórico, para a tela de administração. Sem conteúdo — não há. */
    async recentes(contextoId, { limite = 50 } = {}) {
      return Q.all(
        `SELECT id, conversa_id, tipo, estado, iniciada_em, atendida_em, encerrada_em, motivo, pico
           FROM chamadas WHERE contexto_id = ?
          ORDER BY iniciada_em DESC LIMIT ?`, contextoId, Math.min(200, limite));
    },
  };

  return repo;
}

module.exports = { criar };
