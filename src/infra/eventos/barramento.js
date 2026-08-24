/* ==========================================================================
   eventos/barramento.js (§40)

   Um lugar onde as coisas que ACONTECERAM são anunciadas, para que quem
   precisa reagir não precise ser chamado por quem causou.

   POR QUE ISSO NÃO É ARQUITETURA DECORATIVA AQUI

   Sem barramento, `enviarMensagem` teria de chamar, em sequência: o transporte
   em tempo real, a auditoria, o contador de notificações, o disparo de e-mail
   e o que mais aparecer. Cada nova reação vira uma linha dentro do caso de uso,
   e o caso de uso vira o lugar onde tudo se acumula — que é exatamente o
   "controller que faz tudo" que o §35 proíbe.

   Com barramento, `enviarMensagem` anuncia `mensagem.enviada` e acabou. O
   tempo real, a auditoria e a notificação escutam. Acrescentar e-mail (§41) é
   escrever um ouvinte novo, sem tocar no caso de uso.

   ---------------------------------------------------------------------------
   AS TRÊS REGRAS QUE FAZEM ELE NÃO VIRAR UM PROBLEMA

   1. OUVINTE QUE FALHA NÃO DERRUBA QUEM ANUNCIOU. Se o disparo de e-mail
      quebrar, a mensagem continua enviada. O contrário — perder a mensagem
      porque o servidor de e-mail caiu — seria absurdo, e é o que acontece
      quando se chama tudo em sequência dentro do caso de uso.

   2. NÃO É FILA E NÃO PROMETE ENTREGA. É memória do processo. Reiniciou,
      perdeu o que estava em voo. O que PRECISA sobreviver (a mensagem, a
      notificação pendente) está no banco antes de o evento ser anunciado —
      nunca depois.

   3. A ORDEM DOS OUVINTES NÃO IMPORTA. Se um ouvinte depende de outro ter
      rodado antes, os dois são na verdade um caso de uso, e devem ser
      chamados explicitamente, em ordem, dentro dele.
   ========================================================================== */
"use strict";

/* Lista fechada, pelo mesmo motivo da auditoria: com string livre, um
   `emitir("mensagemEnviada")` e um `escutar("mensagem.enviada")` convivem sem
   nunca se encontrarem, e o defeito é silencioso — a reação simplesmente não
   acontece, sem erro nenhum. */
const EVENTOS = Object.freeze({
  MENSAGEM_ENVIADA: "mensagem.enviada",
  MENSAGEM_APAGADA: "mensagem.apagada",
  MENSAGEM_EDITADA: "mensagem.editada",
  MENSAGEM_LIDA: "mensagem.lida",
  CONVERSA_CRIADA: "conversa.criada",
  /* A conversa saiu para TODO MUNDO. Quem estiver com ela aberta precisa
     saber na hora — senão continua escrevendo numa conversa que já não
     existe, e as mensagens somem sem explicação. */
  CONVERSA_REMOVIDA: "conversa.removida",
  USUARIO_ENTROU: "usuario.entrou",
  USUARIO_SAIU: "usuario.saiu",
  /* "Corte o acesso desta pessoa AGORA." Emitido ao bloquear e ao sair.
     Existe porque encerrar a sessão no banco não fecha um WebSocket que já
     está aberto — e um socket aberto continua recebendo mensagens. */
  USUARIO_EXPULSO: "usuario.expulso",
  USUARIO_STATUS: "usuario.status",
  USUARIO_DIGITANDO: "usuario.digitando",
  /* "A lista de gente mudou." Emitido quando o hospedeiro sincroniza o elenco
     e algo de fato entrou, saiu ou mudou de cargo. Sem isto, quem estava com o
     chat aberto quando um funcionário foi cadastrado só o veria no F5 —
     e a aba "Pessoas" carregava uma vez e nunca mais. */
  ELENCO_MUDOU: "elenco.mudou",
  /* ---------------------------------------------------------- reunião
     O `sinal` é o único evento do barramento que NÃO é difusão: ele carrega
     `paraIds` com uma pessoa só. Está aqui mesmo assim porque o caso de uso
     não deve conhecer o transporte — quem entrega continua sendo o mesmo
     ouvinte que entrega todo o resto. */
  CHAMADA_TOCANDO: "chamada.tocando",
  CHAMADA_ENTROU: "chamada.entrou",
  CHAMADA_SAIU: "chamada.saiu",
  CHAMADA_ENCERRADA: "chamada.encerrada",
  CHAMADA_DISPOSITIVOS: "chamada.dispositivos",
  CHAMADA_SINAL: "chamada.sinal",

  /* ------------------------------------------------------------ sala por link
     O aviso dos últimos minutos e o encerramento saem do SERVIDOR, e não do
     relógio do navegador — que é do visitante e se adianta com um clique. */
  SALA_AVISO: "sala.aviso",
  /* O prazo mudou. Vai para TODOS que estão dentro — o relógio de cada tela
     precisa concordar, ou a reunião acaba antes do que uns estão vendo. */
  SALA_PRORROGADA: "sala.prorrogada",
  SALA_ENCERRADA: "sala.encerrada",
  ARQUIVO_ENVIADO: "arquivo.enviado",
});

function criar() {
  const ouvintes = new Map();   // nome -> Set<fn>

  return {
    EVENTOS,

    escutar(nome, fn) {
      if (!Object.values(EVENTOS).includes(nome))
        throw new Error(`evento desconhecido: ${nome} — acrescente em EVENTOS antes de usar`);
      if (!ouvintes.has(nome)) ouvintes.set(nome, new Set());
      ouvintes.get(nome).add(fn);
      /* Devolve como se descadastrar. Sem isso, um teste que escute deixa o
         ouvinte vivo para o teste seguinte, e as suítes passam a interferir
         umas nas outras de um jeito que depende da ordem de execução. */
      return () => ouvintes.get(nome)?.delete(fn);
    },

    /* Não é `await`ado por quem anuncia. Os ouvintes rodam e, se algum falhar,
       o erro vai para o console — nunca para quem emitiu. */
    emitir(nome, dados) {
      const alvo = ouvintes.get(nome);
      if (!alvo?.size) return;
      for (const fn of alvo) {
        try {
          const r = fn(dados);
          if (r && typeof r.catch === "function")
            r.catch((e) => console.error(`  ⚠ ouvinte de ${nome} falhou:`, e.message));
        } catch (e) {
          console.error(`  ⚠ ouvinte de ${nome} falhou:`, e.message);
        }
      }
    },

    quantos: (nome) => ouvintes.get(nome)?.size || 0,
  };
}

module.exports = { criar, EVENTOS };
