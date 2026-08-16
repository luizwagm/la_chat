/* ==========================================================================
   repositorios/auditoria.js (§31)

   REGRA NÚMERO UM: A AUDITORIA NÃO GUARDA CONTEÚDO.

   É a regra mais fácil de quebrar e a mais cara quando quebrada. Um log que
   registra "MESSAGE_SENT: 'preciso falar sobre a demissão do João'" vira uma
   SEGUNDA CÓPIA de todas as mensagens — sem cifragem, sem controle de acesso
   de conversa, e num lugar que ninguém lembra de proteger quando pensa em
   proteger o chat. Todo o trabalho de cifrar o corpo seria desfeito por uma
   linha de log bem-intencionada.

   O que entra: QUEM, QUANDO, O QUÊ (o nome do evento) e SOBRE QUAL id.
   O que nunca entra: corpo de mensagem, nome de arquivo, e-mail, senha,
   token, conteúdo de busca.

   `detalhe` existe para o excepcional (o motivo de um bloqueio, o tamanho de
   um upload recusado) e passa por uma peneira que corta o que for grande
   demais — porque campo livre é por onde o conteúdo volta a entrar.
   ========================================================================== */
"use strict";

const { ulid } = require("../../../dominio/ids.js");
const { agora } = require("../banco.js");

/* Os eventos são uma LISTA FECHADA. Não é burocracia: com string livre, cada
   lugar do código inventa um nome ("login", "LOGIN", "user_login") e a
   auditoria deixa de ser pesquisável exatamente quando alguém precisa dela. */
const EVENTOS = new Set([
  "SESSAO_ABERTA", "SESSAO_ENCERRADA", "PASSE_RECUSADO",
  "USUARIO_CRIADO", "USUARIO_BLOQUEADO", "USUARIO_LIBERADO", "PERFIL_ATUALIZADO",
  "CONVERSA_CRIADA", "CONVERSA_ENTROU", "CONVERSA_SAIU",
  "MENSAGEM_ENVIADA", "MENSAGEM_APAGADA", "MENSAGEM_EDITADA",
  "ARQUIVO_ENVIADO", "ARQUIVO_BAIXADO", "ARQUIVO_RECUSADO",
  "LIMITE_ATINGIDO", "ACESSO_NEGADO", "ORIGEM_RECUSADA",
  "CONFIGURACAO_ALTERADA",
  /* Faltava desde a 1.2 do conector: a sincronização de elenco gravava, o
     evento não estava na lista, e o registro era DESCARTADO com um aviso no
     console. Ou seja: a auditoria não tinha como responder "quando alguém
     entrou ou saiu da equipe?", que é justamente o que ela existe para
     responder. */
  "ELENCO_SINCRONIZADO",
]);

function criar(Q, { registrarIp = true } = {}) {
  return {
    EVENTOS,

    /* Nunca lança. Um erro ao gravar auditoria não pode derrubar a ação que
       estava sendo auditada — o usuário perderia a mensagem por causa do log.
       Falha vai para o console, que é onde o operador olha. */
    async registrar({ contextoId, usuarioId = null, evento, alvoTipo = "", alvoId = "",
                      ipHash = "", detalhe = "" }) {
      try {
        if (!EVENTOS.has(evento)) {
          console.warn("  ⚠ auditoria: evento desconhecido —", evento);
          return;
        }
        await Q.run(
          `INSERT INTO auditoria (id, contexto_id, usuario_id, evento, alvo_tipo, alvo_id,
                                  ip_hash, detalhe, criado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ulid(), contextoId || "", usuarioId, evento, String(alvoTipo).slice(0, 40),
          String(alvoId).slice(0, 40),
          registrarIp ? String(ipHash).slice(0, 64) : "",
          /* 200 caracteres. O teto é a peneira: é o que impede um `detalhe`
             de virar o lugar onde alguém, um dia, cola a mensagem inteira
             "só para facilitar a investigação". */
          String(detalhe).slice(0, 200),
          agora());
      } catch (e) {
        console.error("  ⚠ auditoria não gravou:", e.message);
      }
    },

    async listar(contextoId, { evento = null, usuarioId = null, desde = null, limite = 100 } = {}) {
      const cond = ["contexto_id = ?"];
      const p = [contextoId];
      if (evento) { cond.push("evento = ?"); p.push(evento); }
      if (usuarioId) { cond.push("usuario_id = ?"); p.push(usuarioId); }
      if (desde) { cond.push("criado_em >= ?"); p.push(desde); }
      return Q.all(
        `SELECT * FROM auditoria WHERE ${cond.join(" AND ")}
          ORDER BY criado_em DESC LIMIT ?`, ...p, Math.min(500, limite));
    },

    /* Retenção. Roda na faxina periódica; o prazo é configuração, porque é
       decisão do cliente e tem implicação jurídica (§34). */
    async expurgar(diasParaGuardar) {
      if (!diasParaGuardar || diasParaGuardar <= 0) return 0;
      const r = await Q.run("DELETE FROM auditoria WHERE criado_em < ?",
        agora() - diasParaGuardar * 24 * 3600e3);
      return r.linhas;
    },
  };
}

module.exports = { criar, EVENTOS };
