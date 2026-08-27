/* ==========================================================================
   janela.js — a reunião numa janela que sobrevive à navegação

   Esta janela é aberta pela aba de origem (`window.open`) e passa a ser a dona
   da reunião. A partir daqui, a aba de origem pode navegar o sistema inteiro —
   abrir prontuário, anotar, consultar histórico — sem que a chamada sinta.

   ---------------------------------------------------------------------------
   DOIS CAMINHOS QUE CHEGAM AQUI, E COMO ESTA PÁGINA OS DISTINGUE

   1. COMEÇAR AQUI. A pessoa clicou em "entrar em janela separada" antes de
      entrar na reunião. Ninguém está conectado a ela ainda; é uma entrada
      comum, pelo caminho comum.

   2. RECEBER A REUNIÃO. Ela já estava na chamada, na gaveta, e mandou trazer
      para cá. Os outros participantes têm conexões ESTABELECIDAS com o
      contexto que está sendo abandonado — e essas conexões precisam ser
      refeitas do zero, porque o certificado DTLS é outro.

   A página não descobre isso por um parâmetro no endereço. Ela PERGUNTA: grita
   "estou assumindo" no canal, e quem responder "pode assumir" é a aba de
   origem entregando a reunião. Silêncio significa que não havia ninguém — o
   caso 1.

   Um parâmetro poderia mentir (endereço copiado, janela reaberta pelo
   histórico, aba de origem já fechada). O handshake não: ou existe alguém do
   outro lado, ou não existe.
   ========================================================================== */
(function () {
  "use strict";

  /* ==========================================================================
     ONDE ESTAMOS

     O endereço é `<prefixo>/janela?c=<chamadaId>`. O prefixo é descoberto, e
     não configurado: este chat pode estar montado em `/chat` ou em
     `/restrito/chat`, e uma constante aqui quebraria na segunda instalação sem
     dizer por quê.
     ========================================================================== */
  const partes = location.pathname.split("/").filter(Boolean);
  const base = "/" + partes.slice(0, -1).join("/");
  const BASE = base === "/" ? "" : base;

  const chamadaId = new URLSearchParams(location.search).get("c") || "";

  const tel = (id) => document.getElementById(id);
  const TELAS = ["tela-carregando", "tela-recusa", "reuniao", "tela-fim"];
  const mostrar = (id) => {
    for (const t of TELAS) tel(t).classList.toggle("vendo", t === id);
  };
  /* Texto SEMPRE por textContent — a mesma regra do componente. */
  const dizer = (id, txt) => { tel(id).textContent = txt; };

  function recusar(titulo, msg) {
    dizer("recusa-titulo", titulo);
    dizer("recusa-msg", msg);
    mostrar("tela-recusa");
  }

  /* ==========================================================================
     O CANAL ENTRE AS DUAS JANELAS

     `BroadcastChannel` fala entre contextos da MESMA ORIGEM sem que um precise
     guardar referência ao outro. É melhor que `postMessage` no `window.opener`
     por dois motivos concretos: a referência ao opener some se ele navegar
     (que é justamente o que vai acontecer aqui), e o canal continua servindo
     se a pessoa abrir a janela a partir de outra aba qualquer.

     A origem é a mesma por construção — esta página é servida pelo próprio
     chat, no mesmo domínio da aba que a abriu.
     ========================================================================== */
  const canal = typeof BroadcastChannel === "function"
    ? new BroadcastChannel("lachat-reuniao") : null;

  /* Quanto se espera pela resposta da aba de origem. Curto de propósito: no
     caso 1 NÃO HÁ ninguém para responder, e este tempo é o atraso que a pessoa
     sente antes de a reunião abrir. */
  const ESPERA_ENTREGA_MS = 1500;

  function pedirEntrega() {
    if (!canal || !chamadaId) return Promise.resolve(false);

    return new Promise((resolve) => {
      let respondido = false;
      const fim = (transferida) => {
        if (respondido) return;
        respondido = true;
        clearTimeout(relogio);
        canal.removeEventListener("message", ouvir);
        resolve(transferida);
      };

      const ouvir = (ev) => {
        const m = ev.data;
        if (m?.t === "livre" && m.chamada === chamadaId) fim(true);
      };

      canal.addEventListener("message", ouvir);
      canal.postMessage({ t: "assumir", chamada: chamadaId });

      /* Silêncio é resposta: não havia ninguém segurando esta reunião. */
      const relogio = setTimeout(() => fim(false), ESPERA_ENTREGA_MS);
    });
  }

  /* ========================================================================== */
  let componente = null;

  async function abrir() {
    if (!chamadaId) {
      return recusar("Endereço incompleto",
        "Esta janela precisa ser aberta pelo botão da reunião.");
    }

    componente = document.createElement("la-chat");
    componente.setAttribute("modo", "janela");
    componente.setAttribute("tema", "escuro");
    componente.setAttribute("base", BASE || "/");
    /* `manual` impede o componente de se abrir sozinho: quem manda entrar é a
       linha `assumirChamada` abaixo, depois do handshake. Sem isto a gaveta
       apareceria por um instante antes da reunião. */
    componente.setAttribute("manual", "");

    componente.addEventListener("chat:sala-fim", (ev) => encerrar(ev.detail));
    tel("reuniao").appendChild(componente);

    if (typeof componente.assumirChamada !== "function") {
      /* Vídeo desligado no servidor: o arquivo do vídeo não é concatenado e o
         componente não tem este método. Sem esta conferência, o sintoma seria
         "undefined is not a function" no console e uma janela preta. */
      return recusar("Reuniões desativadas",
        "As reuniões por vídeo estão desativadas neste servidor.");
    }

    /* O handshake ANTES de qualquer chamada de rede: se a aba de origem vai
       entregar a reunião, ela precisa soltar as conexões dela primeiro. */
    const transferida = await pedirEntrega();

    mostrar("reuniao");

    try {
      await componente.assumirChamada(chamadaId, { transferida, canal });
    } catch (e) {
      /* 401 é o caso que mais vai acontecer na prática: a janela ficou aberta
         a noite toda e a sessão expirou. Dizer "faça login de novo na aba do
         sistema" é mais útil que repetir o texto do servidor. */
      if (e?.status === 401) {
        return recusar("Sua sessão expirou",
          "Entre de novo no sistema, na aba principal, e abra a reunião outra vez.");
      }
      return recusar("Não foi possível entrar",
        e?.message || "A reunião não pôde ser aberta nesta janela.");
    }
  }

  /* ==========================================================================
     ACABOU

     Diferente da página do convidado, aqui não se oferece "entrar de novo": a
     aba de origem é que manda na reunião, e voltar por esta janela criaria uma
     segunda entrada sem que ninguém tivesse pedido.
     ========================================================================== */
  function encerrar(detalhe) {
    if (componente) { try { componente.remove(); } catch { } componente = null; }
    dizer("fim-titulo", detalhe?.motivo === "saiu"
      ? "Você saiu da reunião" : "A reunião terminou");
    dizer("fim-msg", detalhe?.mensagem || "Pode fechar esta janela.");
    mostrar("tela-fim");
  }

  tel("fechar").addEventListener("click", () => {
    /* `window.close()` só é permitido em janela aberta por script — que é
       exatamente o caso desta. Se o navegador recusar, a pessoa fecha no X, e
       a tela já diz isso. */
    try { window.close(); } catch { }
  });

  /* ==========================================================================
     FECHAR A JANELA É SAIR DA REUNIÃO

     E o servidor já sabe disso: quando a ÚLTIMA conexão da pessoa cai, ele a
     tira das chamadas em que estava (`socketCaiu`). Fechar esta janela derruba
     este socket — e se a aba de origem tiver navegado, ele era o último.

     O aviso explícito existe para o caso oposto: com a aba de origem ainda
     aberta, o socket dela mantém a pessoa "dentro", e ela ficaria um retrato
     congelado no grid dos outros até alguém desistir. Uma linha resolve, e
     `keepalive` é o que a faz sobreviver ao fechamento da janela.
     ========================================================================== */
  window.addEventListener("pagehide", () => {
    try { componente?.avisarQueSaiu?.(); } catch { }
  }, { once: true });

  abrir();
})();
