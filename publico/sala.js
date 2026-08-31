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

  const TELAS = ["tela-carregando", "tela-recusa", "tela-espera", "tela-nome",
    "tela-fila", "reuniao", "tela-fim"];
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

  /* ==========================================================================
     AS MESMAS EXIGÊNCIAS DA REUNIÃO — e é o ponto todo

     Este objeto é uma cópia deliberada do que `abrirCamera` usa no componente.
     Pedir aqui menos do que a reunião vai pedir depois é o que fazia o
     navegador perguntar DUAS VEZES.

     A primeira versão pedia `{ video: true, audio: false }`. O microfone ficava
     de fora, e quando a reunião montava e pedia áudio, o navegador tinha uma
     permissão NOVA para perguntar — no pior momento possível, com todo mundo
     já na tela esperando.
     ========================================================================== */
  const EXIGENCIAS = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
  };

  async function abrirPrevia() {
    const video = tel("previa-video");
    const aviso = tel("previa-aviso");

    if (!navigator.mediaDevices?.getUserMedia) {
      aviso.textContent = "Este navegador não permite câmera. Você ainda pode entrar e ouvir.";
      return;
    }

    try {
      previa = await navigator.mediaDevices.getUserMedia(EXIGENCIAS);

      /* ====================================================================
         O MICROFONE VEM, MAS CHEGA DESLIGADO

         Pedir o áudio agora é o que evita a segunda pergunta. Mas a pessoa
         ainda não entrou em reunião nenhuma, e um microfone captando enquanto
         ela digita o nome e espera aprovação não é o que ela concordou.

         `enabled = false` corta a captura na origem: a trilha existe, a
         permissão está dada, e não sai som. Quem entra liga de volta.
         ==================================================================== */
      for (const t of previa.getAudioTracks()) t.enabled = false;
      video.srcObject = previa;
      video.hidden = false;
      aviso.hidden = true;
    } catch (e) {
      /* Negar a câmera NÃO impede de entrar — impede de ser visto. A frase
         precisa dizer isso, ou a pessoa desiste da reunião por um problema
         que não é da reunião. */
      /* ====================================================================
         "BLOQUEADA" É UM BECO SEM SAÍDA — a menos que se diga a saída

         Quem nega uma vez NÃO É PERGUNTADO DE NOVO. O navegador guarda a
         recusa por origem, e a partir daí todo link de reunião abre com a
         câmera desligada e nenhum diálogo à vista. A pessoa não fez nada de
         errado e não tem como desfazer: não há o que clicar.

         Dizer onde fica o interruptor é a diferença entre "não funciona neste
         celular" e trinta segundos de conserto. E a frase termina lembrando
         que dá para entrar assim mesmo — senão ela desiste da consulta por
         causa de uma configuração.
         ==================================================================== */
      const negou = e?.name === "NotAllowedError" || e?.name === "SecurityError";
      aviso.textContent = negou
        ? "Câmera bloqueada neste navegador. Para liberar, toque no cadeado ao "
          + "lado do endereço e permita Câmera e Microfone. Você pode entrar "
          + "mesmo assim — só com áudio."
        : "Nenhuma câmera encontrada. Você pode entrar mesmo assim — com áudio.";
    }
  }

  /* ==========================================================================
     O INTERRUPTOR FOI LIGADO — e a tela percebe sozinha

     Quem seguiu a instrução acima mexe numa configuração DO NAVEGADOR, fora
     da página. Sem isto, nada acontece: a pessoa libera a câmera, volta, e
     continua vendo "bloqueada" — porque a página não tem como saber, e ela
     não imagina que precisa recarregar.

     A API de permissões avisa. O evento chega no instante em que o cadeado
     muda, e a prévia abre sem recarregar nada.

     Cada consulta vai no seu try porque nem todo navegador conhece os dois
     nomes: 'microphone' falha em alguns, e uma exceção aqui derrubaria a
     página do convidado inteira por causa de uma comodidade.
     ========================================================================== */
  async function vigiarPermissao() {
    if (!navigator.permissions?.query) return;
    for (const nome of ["camera", "microphone"]) {
      try {
        const estado = await navigator.permissions.query({ name: nome });
        estado.onchange = () => {
          if (estado.state === "granted" && !previa) abrirPrevia();
        };
      } catch { /* navegador que não conhece este nome: segue sem o atalho */ }
    }
  }

  /* Desistiu, foi negado, deu errado: a câmera apaga. */
  function fecharPrevia() {
    if (!previa) return;
    for (const t of previa.getTracks()) { try { t.stop(); } catch { } }
    previa = null;
    const v = tel("previa-video");
    v.srcObject = null;
  }

  /* ==========================================================================
     ENTREGAR A PRÉVIA À REUNIÃO — sem parar nada

     A diferença para `fecharPrevia` é uma linha, e é a linha que importa:
     aqui as trilhas NÃO param. É o mesmo fluxo, a mesma câmera, o mesmo
     microfone — a reunião continua de onde a prévia estava.

     Parar e pedir de novo funcionava, e cobrava caro: a luz da câmera apagava
     e reacendia bem na hora de entrar, com um atraso de meio segundo em que a
     pessoa aparecia como um retrato vazio para quem já estava lá. E no celular
     reabrir a câmera às vezes falha, o que transformava um piscar em "entrei
     sem imagem".
     ========================================================================== */
  function entregarPrevia() {
    const fluxo = previa;
    previa = null;
    const v = tel("previa-video");
    v.srcObject = null;
    if (fluxo) for (const t of fluxo.getAudioTracks()) t.enabled = true;
    return fluxo;
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
        "É este nome que quem conduz a reunião vai ler para aprovar sua entrada. "
        + "Duração prevista: " + info.duracaoMin + " minutos.");
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
    botao.textContent = "Enviando pedido…";

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

    /* ==================================================================
       O LINK DÁ ACESSO À FILA, NÃO À REUNIÃO

       Quem conduz decide quem entra, e a decisão é sobre um nome concreto.
       Até ela vir, a câmera fica LIGADA de propósito: a pessoa continua se
       vendo, sabe que está enquadrada, e não descobre um problema de vídeo
       depois de ser aprovada, na frente de todo mundo.
       ================================================================== */
    if (r?.estado === "esperando") {
      dizer("fila-nome", r.eu?.nome || nome);
      if (r.sala?.titulo) dizer("fila-titulo", r.sala.titulo);
      mostrar("tela-fila");
      /* A prévia continua viva durante a espera, de propósito: a pessoa se vê
         enquadrada, e a permissão já está dada quando a aprovação chegar. */
      return esperarDecisao();
    }

    await entrarNaReuniao(r, entregarPrevia());
  });

  /* ==========================================================================
     ESPERANDO A DECISÃO

     Por PERGUNTA, e não por aviso. O socket entregaria a decisão mais rápido,
     mas ele é entrega ao vivo: se a conexão oscilar no segundo em que o
     anfitrião clicar, a resposta se perde e a pessoa espera para sempre — e
     esperar para sempre é justamente o que esta tela não pode fazer.

     Perguntar de dois em dois segundos é barato, não perde nada e sobrevive a
     qualquer queda de rede. A rota é a mesma da retomada, que já sabe dizer em
     que estado a pessoa está.
     ========================================================================== */
  let relogioDaFila = null;

  function esperarDecisao() {
    clearTimeout(relogioDaFila);
    relogioDaFila = setTimeout(async () => {
      let r;
      try {
        r = await pedir("/call/" + encodeURIComponent(codigo) + "/eu");
      } catch (e) {
        /* 403 é a NEGATIVA — a única resposta definitiva. Qualquer outra
           falha é rede, e rede se tenta de novo. */
        if (e.status === 403) {
          dizer("fim-titulo", "Entrada não aprovada");
          dizer("fim-msg", e.message || "Quem conduz a reunião não aprovou sua entrada.");
          tel("voltar").hidden = true;
          return mostrar("tela-fim");
        }
        return esperarDecisao();
      }

      if (r?.estado === "esperando") return esperarDecisao();

      await entrarNaReuniao(r, entregarPrevia());
    }, 2000);
  }

  async function entrarNaReuniao(r, fluxoPronto) {
    mostrar("reuniao");

    componente = document.createElement("la-chat");
    componente.setAttribute("modo", "sala");
    componente.setAttribute("tema", "escuro");
    componente.setAttribute("base", BASE || "/");
    /* A sessão do convidado tem cookie PRÓPRIO (`cvd`). Sem dizer isto, o
       componente procuraria o token CSRF do funcionário, não acharia, e o
       convidado jamais abriria o socket. O componente já assume `cvd` no
       modo sala; aqui fica explícito porque esta página é o único lugar
       que sabe, de fato, quem está entrando. */
    componente.setAttribute("cookie", "cvd");
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
      /* O fluxo já conquistado viaja junto. Sem ele o componente pede de novo,
         e é aí que a segunda pergunta aparecia. */
      await componente.entrarNaSala(r, { fluxo: fluxoPronto });
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
    tel("entrar").textContent = "Pedir para entrar";
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

      /* Recarregar no meio da fila não perde o lugar: a pessoa volta a
         esperar, e não à tela de nome. */
      if (r.estado === "esperando") {
        dizer("fila-nome", r.eu.nome || "");
        if (r.sala?.titulo) dizer("fila-titulo", r.sala.titulo);
        mostrar("tela-fila");
        esperarDecisao();
        return true;
      }

      await entrarNaReuniao(r, entregarPrevia());
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
    vigiarPermissao();
    if (await retomar()) return;
    conferir();
  })();
})();
