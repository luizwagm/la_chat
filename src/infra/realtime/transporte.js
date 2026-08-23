/* ==========================================================================
   realtime/transporte.js — o contrato do tempo real

   Nenhuma camada acima daqui sabe se o canal é WebSocket, long-polling ou o
   que vier depois. Ela conhece quatro verbos:

       aceitar(req, socket, cabeca)   abre o canal (aperto de mão + autenticação)
       publicar(usuarioIds, evento)   empurra um evento para quem estiver ligado
       encerrar(usuarioId)            derruba as conexões de alguém
       ligados()                      quem está com canal aberto

   POR QUE A INTERFACE EXISTE, JÁ QUE SÓ HÁ UMA IMPLEMENTAÇÃO PRINCIPAL

   Duas razões concretas, nenhuma delas "flexibilidade" abstrata:

   1. O MODO DEGRADADO — que ainda NÃO existe, e é justamente por isso que a
      interface importa. Rede corporativa que bloqueia `Upgrade` existe (proxy
      antigo, antivírus que inspeciona HTTP), e hoje o chat não funciona em
      tempo real nesses lugares: o cliente fica reconectando. Escrever um
      `TransporteLongPolling` sobre esta interface resolveria sem que o
      servidor mudasse uma linha acima do transporte.

   2. O DIA DO SEGUNDO PROCESSO. Hoje `publicar` varre as conexões locais.
      Quando houver dois processos, ele publica num canal (`LISTEN/NOTIFY` do
      PostgreSQL) e cada processo entrega às suas conexões. A troca acontece
      DENTRO desta função, e nada acima percebe.

   ---------------------------------------------------------------------------
   O FORMATO DO EVENTO

       { t: "<tipo>", ... }

   `t` curto de propósito: um chat movimentado empurra milhares de eventos por
   minuto, e cada byte é multiplicado pelo número de abas abertas.

   E a regra herdada do `restrito.js` deste parque, que vale aqui também:
   O EVENTO CARREGA O MÍNIMO. Quando o corpo da mensagem viaja junto (porque
   sem isso cada mensagem custaria uma volta ao servidor e o chat pareceria
   lento), ele viaja apenas para quem a consulta de MEMBROS autorizou — nunca
   para "todo mundo que está conectado".
   ========================================================================== */
"use strict";

const TIPOS = Object.freeze({
  /* servidor → cliente */
  PRONTO: "pronto",
  MENSAGEM: "msg",
  APAGADA: "apagada",
  EDITADA: "editada",
  LIDA: "lida",
  DIGITANDO: "digit",
  STATUS: "status",
  CONVERSA: "conversa",
  ERRO: "erro",

  /* cliente → servidor */
  PING: "ping",
  DIGITANDO_ENVIO: "digit",
  LIDA_ENVIO: "lida",
  SINCRONIZAR: "sinc",

  /* ------------------------------------------------------------- reunião
     Nomes curtos como o resto: um socket de reunião troca muitos candidatos
     ICE por segundo enquanto a conexão se estabelece. */
  CHAMADA_TOCANDO: "cham.toca",
  CHAMADA_ENTROU: "cham.entrou",
  CHAMADA_SAIU: "cham.saiu",
  CHAMADA_ENCERRADA: "cham.fim",
  CHAMADA_DISPOSITIVOS: "cham.disp",
  CHAMADA_SINAL: "cham.sinal",

  /* sala por link */
  SALA_AVISO: "sala.aviso",
  SALA_ENCERRADA: "sala.fim",
});

module.exports = { TIPOS };
