/* ==========================================================================
   publico/sala.js — a página do convidado

   Roda numa página SEM sessão, aberta por alguém que talvez nunca tenha
   ouvido falar deste sistema. Três decisões governam o arquivo:

   1. O CÓDIGO DA SALA VEM DO ENDEREÇO, não do HTML. O servidor entrega a
      página sem interpolar nada; assim não existe caminho de texto para
      HTML, e XSS aqui é impossível por construção — não por escapamento
      correto (ver o comentário no topo de `sala.html`).

   2. A PÁGINA NÃO SABE FAZER REUNIÃO. Ela negocia a entrada e entrega o
      resultado ao componente `<la-chat modo="sala">`, que é o mesmo do chat
      interno. Duplicar aqui a negociação WebRTC seria duplicar o código mais
      difícil do projeto.

   3. TODA RECUSA É A MESMA RECUSA. A página nunca inventa explicação: exibe
      o que o servidor mandou. Link inexistente, revogado e expirado dizem a
      mesma frase de propósito — tentativa e erro não pode virar mapa.
   ========================================================================== */
(function () {
  "use strict";

  /* ==========================================================================
     ONDE ESTAMOS

     O endereço é `<prefixo>/call/<codigo>`. O prefixo é descoberto, e não
     configurado, porque este chat pode estar montado em `/chat` ou em
     `/restrito/chat` — e uma constante aqui quebraria na segunda instalação
     sem dizer por quê.
     ========================================================================== */
  const partes = location.pathname.split("/").filter(Boolean);
  const codigo = partes[partes.length - 1] || "";
  const base = "/" + partes.slice(0, -2).join("/");
  const BASE = base === "/" ? "" : base;

  const tel = (id) => document.getElementById(id);

  const TELAS = ["tela-carregando", "tela-recusa", "tela-espera", "tela-nome", "reuniao", "tela-fim"];
  function mostrar(id) {
    for (const t of TELAS) tel(t).classList.toggle("vendo", t === id);
  }

  /* Texto SEMPRE por textContent. A regra é a mesma do componente e vale
     inclusive para o que veio do nosso próprio servidor: um dia o título da
     sala passa a vir do banco, e nesse dia esta linha já estará certa. */
  const dizer = (id, texto) => { tel(id).textContent = String(texto || ""); };

  /* ==========================================================================
     PEDIR AO SERVIDOR

     `credentials: "same-origin"` é o necessário e o suficiente: a página e a
     API estão na mesma origem por construção (a página É servida pelo chat).
     `include` funcionaria igual e afrouxaria a regra sem ganho nenhum.
     ========================================================================== */
  async function pedir(caminho, opcoes = {}) {
    const r = await fetch(BASE + caminho, {
      method: opcoes.metodo || "GET",
      credentials: "same-origin",
      headers: opcoes.corpo ? { "Content-Type": "application/json" } : {},
      body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
    });
    let dados = null;
    try { dados = await r.json(); } catch { }
    if (!r.ok) {
      const e = new Error(dados?.erro || "Não foi possível falar com o servidor.");
      e.status = r.status;
      throw e;
    }
    return dados;
  }

  /* ==========================================================================
     A PRÉVIA DA CÂMERA

     Responde à única pergunta que toda pessoa faz antes de entrar: "estou
     aparecendo?". A permissão pedida aqui é a MESMA que a reunião vai usar,
     então o convidado responde ao navegador uma vez só — e responde antes de
     estar diante de outras pessoas, que é a hora certa de descobrir que a
     câmera não funciona.

     Os trilhos são soltos ao entrar. Sem isso a luz da câmera fica acesa por
     um fluxo que ninguém mais assiste.
     ========================================================================== */
  let previa = null;

  async function abrirPrevia() {
    const video = tel("previa-video");
    const aviso = tel("previa-aviso");

    if (!navigator.mediaDevices?.getUserMedia) {
      aviso.textContent = "Este navegador não permite câmera. Você ainda pode entrar e ouvir.";
      return;
    }

    try {
      previa = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      video.srcObject = previa;
      video.hidden = false;
      aviso.hidden = true;
    } catch (e) {
      /* Negar a câmera NÃO impede de entrar — impede de ser visto. A frase
         precisa dizer isso, ou a pessoa desiste da reunião por um problema
         que não é da reunião. */
      const negou = e?.name === "NotAllowedError" || e?.name === "SecurityError";
      aviso.textContent = negou
        ? "Câmera bloqueada neste navegador. Você pode entrar mesmo assim — com áudio."
        : "Nenhuma câmera encontrada. Você pode entrar mesmo assim — com áudio.";
    }
  }

  function fecharPrevia() {
    if (!previa) return;
    for (const t of previa.getTracks()) { try { t.stop(); } catch { } }
    previa = null;
    const v = tel("previa-video");
    v.srcObject = null;
  }

  /* ==========================================================================
     O CONVITE — vale? já começou?
     ========================================================================== */
  let tentativasDeEspera = 0;
  let relogioDaEspera = null;

  async function conferir({ silencioso = false } = {}) {
    let info;
    try {
      info = await pedir("/call/" + encodeURIComponent(codigo) + "/info");
    } catch (e) {
      /* Uma falha de rede no meio da espera não pode virar "link inválido":
         seria acusar o convite de um problema que é do caminho até aqui. */
      if (silencioso) return agendarEspera();
      dizer("recusa-msg", e.status === 429
        ? "Muitas tentativas a partir da sua rede. Aguarde um instante e recarregue."
        : "Não foi possível falar com o servidor. Verifique sua conexão e recarregue.");
      return mostrar("tela-recusa");
    }

    if (info.ok) {
      clearTimeout(relogioDaEspera);
      if (info.titulo) dizer("nome-titulo", info.titulo);
      if (info.duracaoMin) dizer("nome-sub",
        "Este nome aparece para todos na reunião. Duração prevista: "
        + info.duracaoMin + " minutos.");
      mostrar("tela-nome");
      tel("nome").focus();
      if (!previa) abrirPrevia();
      return;
    }

    /* "Aguardando o anfitrião" é o único não-ok que vale esperar. Os outros
       são definitivos, e insistir neles seria manter a pessoa numa tela que
       nunca vai mudar. */
    if (info.aguardando) {
      if (info.titulo) dizer("espera-titulo", info.titulo);
      mostrar("tela-espera");
      return agendarEspera();
    }

    clearTimeout(relogioDaEspera);
    dizer("recusa-msg", info.mensagem || "Link inválido ou expirado.");
    mostrar("tela-recusa");
  }

  /* O intervalo cresce: quem deixou a aba aberta a manhã inteira não deve
     bater no servidor a cada cinco segundos para sempre. E o freio da rota
     `/info` é de 20 por minuto por IP — num escritório inteiro atrás de um
     mesmo endereço, uma espera apertada demais tranca todo mundo junto. */
  function agendarEspera() {
    clearTimeout(relogioDaEspera);
    const espera = Math.min(30_000, 5_000 + tentativasDeEspera * 2_500);
    tentativasDeEspera++;
    relogioDaEspera = setTimeout(() => conferir({ silencioso: true }), espera);
  }

  /* Voltar para a aba acelera a próxima conferência: a pessoa acabou de
     olhar, e é agora que ela quer saber se já começou. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!tel("tela-espera").classList.contains("vendo")) return;
    tentativasDeEspera = 0;
    conferir({ silencioso: true });
  });

  /* ==========================================================================
     ENTRAR
     ========================================================================== */
  let componente = null;

  tel("forma").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const botao = tel("entrar");
    const erro = tel("nome-erro");
    const nome = tel("nome").value.trim();

    erro.hidden = true;

    if (nome.length < 2) {
      erro.textContent = "Escreva seu nome, com pelo menos 2 letras.";
      erro.hidden = false;
      return tel("nome").focus();
    }

    botao.disabled = true;
    botao.textContent = "Entrando…";

    let r;
    try {
      r = await pedir("/call/" + encodeURIComponent(codigo) + "/entrar",
        { metodo: "POST", corpo: { nome } });
    } catch (e) {
      botao.disabled = false;
      botao.textContent = "Entrar na reunião";
      erro.textContent = e.message;
      erro.hidden = false;
      /* Se a sala morreu enquanto a pessoa digitava, a tela precisa mudar —
         insistir no botão não a levaria a lugar nenhum. */
      if (e.status === 404) { dizer("recusa-msg", e.message); mostrar("tela-recusa"); }
      return;
    }

    clearTimeout(relogioDaEspera);
    fecharPrevia();
    await entrarNaReuniao(r);
  });

  async function entrarNaReuniao(r) {
    mostrar("reuniao");

    componente = document.createElement("la-chat");
    componente.setAttribute("modo", "sala");
    componente.setAttribute("tema", "escuro");
    componente.setAttribute("base", BASE || "/");
    /* `manual` impede o componente de tentar abrir sozinho. Quem abre é a
       linha `entrarNaSala` logo abaixo, com a identidade em mãos. */
    componente.setAttribute("manual", "");

    componente.addEventListener("chat:sala-fim", (ev) => encerrar(ev.detail));
    tel("reuniao").appendChild(componente);

    if (typeof componente.entrarNaSala !== "function") {
      /* Vídeo desligado no servidor: o arquivo do vídeo não é servido e o
         componente não tem este método. Sem esta conferência o sintoma seria
         um "undefined is not a function" no console e uma tela preta. */
      dizer("recusa-msg", "As reuniões por vídeo estão desativadas neste servidor.");
      return mostrar("tela-recusa");
    }

    try {
      await componente.entrarNaSala(r);
    } catch (e) {
      encerrar({ motivo: "erro", mensagem: e?.message || "A reunião não pôde ser aberta." });
    }
  }

  /* ==========================================================================
     ACABOU

     Um só caminho de saída, com o motivo que veio de quem decidiu. Sair, ser
     removido, o link ser revogado e o tempo esgotar são coisas diferentes
     para quem está do lado de cá, e a tela final é o único lugar onde essa
     diferença ainda pode ser dita.
     ========================================================================== */
  function encerrar(detalhe) {
    const motivo = detalhe?.motivo || "encerrada";

    if (componente) { try { componente.remove(); } catch { } componente = null; }

    dizer("fim-titulo", motivo === "saiu" ? "Você saiu da reunião" : "A reunião terminou");
    dizer("fim-msg", detalhe?.mensagem || "Obrigado por participar.");

    /* "Entrar de novo" só faz sentido se ainda houver reunião para entrar.
       Depois do tempo esgotado ou de uma remoção, o botão seria uma promessa
       que o servidor vai recusar. */
    const podeVoltar = motivo === "saiu";
    tel("voltar").hidden = !podeVoltar;

    mostrar("tela-fim");
  }

  tel("voltar").addEventListener("click", () => {
    tentativasDeEspera = 0;
    tel("entrar").disabled = false;
    tel("entrar").textContent = "Entrar na reunião";
    mostrar("tela-carregando");
    conferir();
  });

  /* FECHAR A ABA NÃO PRECISA DE AVISO — e a primeira versão desta página
     tinha um `sendBeacon` aqui, que era pior que nada: `sendBeacon` não
     manda cabeçalho, então o pedido morreria no CSRF do convidado, e o
     código ficaria no arquivo parecendo uma proteção que não protege.

     Quem tira a pessoa da reunião é a QUEDA DO SOCKET, tratada em
     `realtime/websocket.js` — o mesmo caminho que já cobre queda de rede,
     computador suspenso e navegador fechado à força, que nenhum aviso de
     saída cobriria de qualquer forma.

     */

  /* ==========================================================================
     RETOMAR — recarregar não é entrar de novo

     No celular isto acontece o tempo todo: a pessoa gira a tela, troca de
     aplicativo, o navegador descarta a aba em segundo plano. Antes, cada
     recarga voltava à tela de nome — e entrar de novo criava um convidado
     NOVO, com id novo, gastando mais uma vaga do teto. Uma sala de cinco
     lugares se esgotava com uma pessoa e quatro recargas.

     O cookie do convidado vale 4 horas justamente para isto. Se ele ainda
     valer, a pessoa volta direto para a reunião, sem digitar nada.
     ========================================================================== */
  async function retomar() {
    try {
      const r = await pedir("/call/" + encodeURIComponent(codigo) + "/eu");
      if (!r?.eu?.id) return false;
      await entrarNaReuniao(r);
      return true;
    } catch {
      /* Qualquer recusa — cookie vencido, removido da sala, reunião encerrada
         — cai no caminho normal, que dirá o motivo certo. Insistir aqui só
         atrasaria a mensagem. */
      return false;
    }
  }

  /* ==========================================================================
     COMEÇO
     ========================================================================== */
  (async () => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{11}$/.test(codigo)) {
      dizer("recusa-msg", "Link inválido ou expirado.");
      return mostrar("tela-recusa");
    }
    if (await retomar()) return;
    conferir();
  })();
})();
