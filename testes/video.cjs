/* ==========================================================================
   testes/video.cjs — a reunião, e os ataques contra ela

       node testes/video.cjs

   O que esta suíte NÃO testa: mídia. Não há como abrir uma câmera dentro do
   Node, e não faria sentido — em malha, a mídia nunca passa pelo servidor.

   O que ela testa é tudo que o SERVIDOR faz numa reunião: quem pode iniciar,
   quem pode entrar, quem recebe o toque, quem recebe cada sinal, quem NÃO
   recebe, e o que acontece quando o último sai ou quando o socket cai.

   É onde a segurança do vídeo mora. A mídia é ponta a ponta por construção
   (DTLS-SRTP é obrigatório no WebRTC); o que dá para atacar é a sinalização —
   e é ela que está aqui.
   ========================================================================== */
"use strict";

const WebSocket = require("ws");
const { criarPlacar, subirChat, entrar, espera, pedir } = require("./ajuda.cjs");

const VIDEO = { CHAT_VIDEO: "1", CHAT_VIDEO_TETO: "3" };

/* Um "navegador" com socket aberto que guarda tudo que chega. */
async function socketDe(chat, aba) {
  const { bilhete } = (await aba.vai("/bilhete", { metodo: "POST" })).dados;
  const ws = new WebSocket(`ws://127.0.0.1:${chat.porta}/chat/ws?t=${encodeURIComponent(bilhete)}`,
    { headers: { Origin: "http://127.0.0.1:5299" } });

  const recebidas = [];
  ws.on("message", (d) => { try { recebidas.push(JSON.parse(d.toString())); } catch { } });
  ws.on("error", () => { });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("socket não abriu")), 5000);
    ws.on("open", () => { clearTimeout(t); resolve(); });
    ws.on("unexpected-response", (_, r) => { clearTimeout(t); reject(new Error("recusado " + r.statusCode)); });
  });

  return {
    ws, recebidas,
    limpar: () => (recebidas.length = 0),
    manda: (o) => ws.send(JSON.stringify(o)),
    async esperar(tipo, ms = 4000) {
      const ate = Date.now() + ms;
      for (;;) {
        const achou = recebidas.find((m) => m.t === tipo);
        if (achou) return achou;
        if (Date.now() > ate) return null;
        await espera(40);
      }
    },
    fechar: () => new Promise((r) => { ws.on("close", r); ws.close(); setTimeout(r, 600); }),
    arrancar: () => new Promise((r) => { ws.on("close", r); ws.terminate(); setTimeout(r, 300); }),
  };
}

async function rodar() {
  const P = criarPlacar("Vídeo");
  const chat = await subirChat({ porta: 5286, origens: "http://127.0.0.1:5299", extra: VIDEO });
  const abertos = [];

  try {
    const ana = await entrar(chat, { id: "v-ana", nome: "ZZ QA Ana" });
    const bruno = await entrar(chat, { id: "v-bruno", nome: "ZZ QA Bruno" });
    const carla = await entrar(chat, { id: "v-carla", nome: "ZZ QA Carla" });
    const dino = await entrar(chat, { id: "v-dino", nome: "ZZ QA Dino" });
    const estranho = await entrar(chat, { id: "v-estranho", nome: "ZZ QA Estranho" });

    const sAna = await socketDe(chat, ana); abertos.push(sAna);
    const sBruno = await socketDe(chat, bruno); abertos.push(sBruno);
    const sCarla = await socketDe(chat, carla); abertos.push(sCarla);
    const sEstranho = await socketDe(chat, estranho); abertos.push(sEstranho);
    await espera(300);

    const conversa = (await ana.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: bruno.usuario.id },
    })).dados.id;

    /* ====================================================================== */
    P.secao("estado da conversa");

    const semChamada = await ana.vai(`/conversas/${conversa}/chamada`);
    P.eq(semChamada.status, 200, "a conversa responde sobre chamada");
    P.eq(semChamada.dados.ativo, true, "o vídeo está ligado nesta instalação");
    P.eq(semChamada.dados.chamada, null, "e não há chamada rolando");

    P.recusa(await estranho.vai(`/conversas/${conversa}/chamada`), 404,
      "quem não é membro NÃO sabe se há reunião na conversa alheia");

    /* ====================================================================== */
    P.secao("iniciar e tocar");

    sBruno.limpar();
    const inicio = await ana.vai(`/conversas/${conversa}/chamada`, { metodo: "POST" });
    P.eq(inicio.status, 200, "Ana inicia a chamada");
    const chamadaId = inicio.dados.id;
    P.eq(inicio.dados.estado, "tocando", "e ela nasce tocando");
    P.eq(inicio.dados.souOIniciador, true, "Ana é a iniciadora");
    P.ok(!!inicio.dados.credenciais?.iceServers?.length,
      "as credenciais de ICE vêm junto (STUN pelo menos)");

    const toque = await sBruno.esperar("cham.toca");
    P.ok(!!toque, "o telefone do Bruno TOCA pelo socket");
    P.eq(toque?.de, ana.usuario.id, "e diz quem está chamando");

    await espera(300);
    P.eq(sAna.recebidas.filter((m) => m.t === "cham.toca").length, 0,
      "o telefone de quem CHAMOU não toca");
    P.eq(sEstranho.recebidas.filter((m) => m.t === "cham.toca").length, 0,
      "e o de quem não é da conversa também não");

    /* ====================================================================== */
    P.secao("entrar");

    P.recusa(await estranho.vai(`/chamadas/${chamadaId}/entrar`, { metodo: "POST" }), 404,
      "estranho NÃO entra numa reunião de conversa alheia");

    sAna.limpar();
    const entrou = await bruno.vai(`/chamadas/${chamadaId}/entrar`, { metodo: "POST" });
    P.eq(entrou.status, 200, "Bruno entra");
    P.eq(entrou.dados.estado, "ativa", "e a chamada deixa de tocar");
    P.ok(!!entrou.dados.credenciais?.iceServers, "Bruno também recebe credenciais");

    const aviso = await sAna.esperar("cham.entrou");
    P.ok(!!aviso, "Ana é avisada de que alguém entrou");
    P.eq(aviso?.u, bruno.usuario.id, "e de quem foi");

    /* ==================================================================
       O NOME VAI NO AVISO — e a falta dele apagava o de TODO MUNDO.

       Esta lista é gravada por cima da que o cliente já tinha. Sem `nome`,
       a primeira pessoa a entrar fazia todos os retratos da reunião
       perderem a identificação de uma vez: quadros escritos "…", inclusive
       os de quem já estava lá havia meia hora com o nome certo na tela.

       Passou meses despercebido porque a suíte conferia QUEM entrou (`u`) e
       nunca o conteúdo da lista — e porque, com duas pessoas em teste, um
       "…" a mais não chama atenção. Na tela do cliente, com quatro, chama.
       ================================================================== */
    const naLista = (aviso?.participantes || []).find((p) => p.id === bruno.usuario.id);
    P.ok(!!naLista, "e a lista do aviso traz quem entrou");
    P.ok(!!naLista?.nome, "COM O NOME — sem ele, o cliente apaga o nome de todos",
      JSON.stringify(naLista));
    P.ok(naLista?.nome?.includes("Bruno"), "e é o nome certo", naLista?.nome);
    P.ok("avatar" in (naLista || {}), "e o avatar vai junto, pelo mesmo motivo");

    const jaEstava = (aviso?.participantes || []).find((p) => p.id !== bruno.usuario.id);
    P.ok(!!jaEstava?.nome, "quem JÁ ESTAVA dentro também vem nomeado", JSON.stringify(jaEstava));

    /* Entrar duas vezes é idempotente — acontece quando a aba recarrega. */
    const denovo = await bruno.vai(`/chamadas/${chamadaId}/entrar`, { metodo: "POST" });
    P.eq(denovo.status, 200, "entrar de novo não é erro");
    const dentro = denovo.dados.participantes.filter((p) => p.estado === "dentro");
    P.eq(dentro.length, 2, "e continuam sendo 2 pessoas dentro");

    /* ====================================================================== */
    P.secao("sinal — a rota mais sensível");

    sBruno.limpar();
    sAna.manda({ t: "cham.sinal", c: chamadaId, para: bruno.usuario.id, tipo: "oferta", dados: { sdp: "v=0 fake" } });
    const sinal = await sBruno.esperar("cham.sinal");
    P.ok(!!sinal, "o sinal de Ana chega ao Bruno");
    P.eq(sinal?.de, ana.usuario.id, "carimbado com quem MANDOU");
    P.eq(sinal?.tipo, "oferta", "com o tipo preservado");
    P.eq(sinal?.dados?.sdp, "v=0 fake", "e o envelope intacto");

    /* A falsificação de origem: Bruno tenta mandar um sinal DIZENDO ser a Ana. */
    sCarla.limpar();
    sBruno.limpar();
    sBruno.manda({
      t: "cham.sinal", c: chamadaId, para: ana.usuario.id,
      tipo: "oferta", de: "v-carla-forjado", dados: { sdp: "forjado" },
    });
    await espera(600);
    const noAna = sAna.recebidas.filter((m) => m.t === "cham.sinal");
    P.ok(noAna.length > 0, "o sinal do Bruno chega");
    P.eq(noAna[noAna.length - 1]?.de, bruno.usuario.id,
      "mas o `de` é o do SOCKET, não o que o cliente escreveu");

    /* O estranho tenta injetar sinal na reunião alheia. */
    sAna.limpar();
    sEstranho.manda({ t: "cham.sinal", c: chamadaId, para: ana.usuario.id, tipo: "oferta", dados: { sdp: "x" } });
    await espera(600);
    P.eq(sAna.recebidas.filter((m) => m.t === "cham.sinal").length, 0,
      "estranho NÃO consegue injetar sinal numa reunião de que não participa");
    P.ok(sEstranho.recebidas.some((m) => m.t === "erro"),
      "e recebe uma recusa educada");

    /* Membro da conversa que NÃO entrou na chamada também não sinaliza. */
    sAna.limpar();
    const conversaTri = (await ana.vai("/conversas/grupo", {
      metodo: "POST", corpo: { titulo: "ZZ QA Trio", membros: [bruno.usuario.id, carla.usuario.id] },
    })).dados.id;
    const chamadaTri = (await ana.vai(`/conversas/${conversaTri}/chamada`, { metodo: "POST" })).dados.id;
    sCarla.limpar();
    sCarla.manda({ t: "cham.sinal", c: chamadaTri, para: ana.usuario.id, tipo: "oferta", dados: { sdp: "y" } });
    await espera(600);
    P.eq(sAna.recebidas.filter((m) => m.t === "cham.sinal").length, 0,
      "membro que ainda NÃO entrou na chamada não sinaliza");

    /* Sinal fora de forma. */
    sAna.limpar();
    sBruno.manda({ t: "cham.sinal", c: chamadaId, para: ana.usuario.id, tipo: "hackear", dados: {} });
    sBruno.manda({ t: "cham.sinal", c: chamadaId, para: ana.usuario.id, tipo: "oferta", dados: "z".repeat(40000) });
    await espera(600);
    P.eq(sAna.recebidas.filter((m) => m.t === "cham.sinal").length, 0,
      "tipo inventado e sinal gigante são recusados");

    /* ====================================================================== */
    P.secao("dispositivos");

    sAna.limpar();
    const mudo = await bruno.vai(`/chamadas/${chamadaId}/dispositivos`, {
      metodo: "PATCH", corpo: { microfone: false },
    });
    P.eq(mudo.status, 200, "Bruno se silencia");
    const disp = await sAna.esperar("cham.disp");
    P.ok(!!disp, "Ana é avisada");
    P.eq(disp?.microfone, false, "com o estado certo");

    const estadoAgora = await ana.vai(`/conversas/${conversa}/chamada`);
    const b = estadoAgora.dados.chamada.participantes.find((x) => x.id === bruno.usuario.id);
    P.eq(b?.microfone, false,
      "e o estado fica GRAVADO — quem entrar depois já vê quem está mudo");

    P.recusa(await estranho.vai(`/chamadas/${chamadaId}/dispositivos`, {
      metodo: "PATCH", corpo: { microfone: false },
    }), 404, "estranho não muda o microfone de reunião alheia");

    /* ====================================================================== */
    P.secao("o teto da malha");

    /* O teto do teste é 3. A conversa do trio tem 3 membros e já tem chamada. */
    await bruno.vai(`/chamadas/${chamadaTri}/entrar`, { metodo: "POST" });
    await carla.vai(`/chamadas/${chamadaTri}/entrar`, { metodo: "POST" });
    const cheia = await ana.vai(`/conversas/${conversaTri}/chamada`);
    P.eq(cheia.dados.chamada.participantes.filter((x) => x.estado === "dentro").length, 3,
      "três pessoas dentro, no teto");

    /* Uma conversa com mais gente que o teto nem abre reunião. */
    const grupao = (await ana.vai("/conversas/grupo", {
      metodo: "POST",
      corpo: { titulo: "ZZ QA Grupao", membros: [bruno.usuario.id, carla.usuario.id, dino.usuario.id] },
    })).dados.id;
    const recusada = await ana.vai(`/conversas/${grupao}/chamada`, { metodo: "POST" });
    P.recusa(recusada, 400, "conversa maior que o teto NÃO abre reunião");
    P.ok(String(recusada.dados?.erro || "").includes("comporta"),
      "e a recusa explica o motivo em português", recusada.dados?.erro);

    /* ====================================================================== */
    P.secao("uma chamada por conversa");

    const segunda = await bruno.vai(`/conversas/${conversa}/chamada`, { metodo: "POST" });
    P.eq(segunda.status, 200, "clicar em chamar com reunião rolando responde ok");
    P.eq(segunda.dados.id, chamadaId,
      "e ENTRA na que já existe, em vez de abrir uma segunda");

    /* ====================================================================== */
    P.secao("sair, e o histórico");

    sBruno.limpar();
    const saiu = await ana.vai(`/chamadas/${chamadaId}/sair`, { metodo: "POST" });
    P.eq(saiu.status, 200, "Ana sai");
    P.ok(saiu.dados.encerrada,
      "e a chamada ENCERRA, porque sobrou uma pessoa só");

    const fim = await sBruno.esperar("cham.fim");
    P.ok(!!fim, "Bruno é avisado de que a reunião acabou");

    const hist = await ana.vai(`/conversas/${conversa}/mensagens?limite=10`);
    const sistema = hist.dados.mensagens.filter((m) => m.tipo === "sistema");
    P.ok(sistema.length >= 1, "a chamada virou uma linha no histórico da conversa");
    const evento = JSON.parse(sistema[sistema.length - 1].corpo);
    P.eq(evento.ev, "chamada", "a linha é um evento de chamada");
    /* `sozinho`, e não `normal`: a reunião não acabou porque alguém desligou —
       acabou porque sobrou uma pessoa só depois de a outra sair. A distinção
       existe para o histórico poder dizer o que houve, e para separar isto de
       `ninguem_atendeu` e `recusada`, que são chamadas que nunca aconteceram. */
    P.eq(evento.motivo, "sozinho",
      "o desfecho diz POR QUE acabou (ficou uma pessoa só)");
    P.ok(evento.dur >= 0, "e registra a duração", String(evento.dur));
    P.ok(evento.n >= 2, "e o número de participantes", JSON.stringify(evento));

    const depois = await ana.vai(`/conversas/${conversa}/chamada`);
    P.eq(depois.dados.chamada, null, "a conversa volta a não ter chamada");

    /* E agora dá para abrir outra — a trava não ficou presa. */
    const nova = await ana.vai(`/conversas/${conversa}/chamada`, { metodo: "POST" });
    P.eq(nova.status, 200, "e uma reunião NOVA pode começar");
    P.ok(nova.dados.id !== chamadaId, "com id diferente");
    await ana.vai(`/chamadas/${nova.dados.id}/sair`, { metodo: "POST" });

    /* ====================================================================== */
    P.secao("recusar");

    const paraRecusar = (await ana.vai(`/conversas/${conversa}/chamada`, { metodo: "POST" })).dados.id;
    sAna.limpar();
    const rec = await bruno.vai(`/chamadas/${paraRecusar}/recusar`, { metodo: "POST" });
    P.eq(rec.status, 200, "Bruno recusa");
    P.ok(rec.dados.encerrada, "e a chamada direta encerra");

    const histRec = await ana.vai(`/conversas/${conversa}/mensagens?limite=5`);
    const ultimaSistema = histRec.dados.mensagens.filter((m) => m.tipo === "sistema").pop();
    P.eq(JSON.parse(ultimaSistema.corpo).motivo, "recusada",
      "o histórico registra RECUSADA, não 'chamada de 0 segundo'");

    /* ====================================================================== */
    P.secao("a queda do socket tira da reunião");

    const cQueda = (await ana.vai(`/conversas/${conversa}/chamada`, { metodo: "POST" })).dados.id;
    await bruno.vai(`/chamadas/${cQueda}/entrar`, { metodo: "POST" });
    await espera(200);

    /* Carla entra num trio para a chamada não encerrar por ficar com uma
       pessoa só quando o Bruno cair. */
    const dentroAntes = (await ana.vai(`/conversas/${conversa}/chamada`))
      .dados.chamada.participantes.filter((x) => x.estado === "dentro").length;
    P.eq(dentroAntes, 2, "duas pessoas na reunião antes da queda");

    await sBruno.arrancar();
    await espera(1200);

    const estadoPos = await ana.vai(`/conversas/${conversa}/chamada`);
    P.ok(!estadoPos.dados.chamada,
      "o cabo arrancado do Bruno encerra a reunião (sobrou uma pessoa)",
      JSON.stringify(estadoPos.dados.chamada));

    /* ======================================================================
       A JANELA SEPARADA

       A reunião numa janela própria existe para que quem atende possa usar o
       sistema enquanto conversa — abrir prontuário, anotar. Navegar destrói o
       contexto JavaScript da aba, e com ele o socket e todas as conexões; a
       janela flutuante não resolve, porque ela empresta os nós do DOM e deixa
       os objetos onde estavam.
       ====================================================================== */
    P.secao("a reunião em janela separada");

    {
      const pagina = await pedir(chat.base + "/janela?c=" + chamadaId);
      P.eq(pagina.status, 200, "a página da janela é servida");
      P.ok(pagina.texto.includes("<la-chat") || pagina.texto.includes("janela.js"),
        "e traz o script que monta o componente");

      /* NADA INTERPOLADO. O id da chamada vai no endereço e quem o lê é o
         JavaScript — não existe caminho de texto para HTML nesta página. */
      P.ok(!pagina.texto.includes(chamadaId),
        "o id da chamada NÃO aparece no HTML — nada é interpolado");

      P.ok(/noindex/.test(pagina.cabecalhos["x-robots-tag"] || ""),
        "com noindex — janela de reunião no índice de busca é convite",
        pagina.cabecalhos["x-robots-tag"]);
      P.eq(pagina.cabecalhos["x-frame-options"], "DENY",
        "e não pode ser embutida em página nenhuma");
      P.ok(!/unsafe-inline/.test(
        (pagina.cabecalhos["content-security-policy"] || "").split("style-src")[0]),
        "e a CSP não libera script inline",
        pagina.cabecalhos["content-security-policy"]);

      const script = await pedir(chat.base + "/janela.js");
      P.eq(script.status, 200, "o script da janela é servido");
      P.ok(script.texto.includes("assumirChamada"),
        "e é o que assume a reunião nesta janela");

      /* ==================================================================
         AUTORIZADO PELO LUGAR, NÃO PELA EXTENSÃO

         "Todo .js dentro de publico/ pode ser servido" é a regra que um dia
         responde 200 a GET /server.js. Já aconteceu neste parque, noutro
         projeto. Cada arquivo é nomeado, um por um — e este teste é o que
         acusa se alguém trocar a lista por um padrão.
         ================================================================== */
      for (const proibido of ["/server.js", "/config.js", "/la-chat.js.map", "/../server.js"]) {
        const r = await pedir(chat.base + proibido);
        P.ok(r.status !== 200 || !String(r.texto).includes("require("),
          `${proibido} NÃO entrega código do servidor`, String(r.status));
      }

      /* A janela é para quem é DA CASA. O HTML é público porque não diz nada;
         quem exige sessão é a API que ela chama em seguida. */
      const semSessao = await pedir(chat.base + "/chamadas/" + chamadaId + "/entrar",
        { metodo: "POST" });
      P.ok(semSessao.status === 401 || semSessao.status === 403,
        "e sem sessão não se entra na chamada por ela", String(semSessao.status));
    }

    /* ====================================================================== */
    P.secao("com o vídeo DESLIGADO");

    const semVideo = await subirChat({ porta: 5285, origens: "http://127.0.0.1:5299" });
    try {
      const x = await entrar(semVideo, { id: "sv-a", nome: "ZZ QA SemVideo A" });
      const y = await entrar(semVideo, { id: "sv-b", nome: "ZZ QA SemVideo B" });
      const conv = (await x.vai("/conversas/direta", {
        metodo: "POST", corpo: { usuarioId: y.usuario.id },
      })).dados.id;

      const estado = await x.vai(`/conversas/${conv}/chamada`);
      P.eq(estado.dados.ativo, false, "a instalação diz que o vídeo está desligado");
      P.recusa(await x.vai(`/conversas/${conv}/chamada`, { metodo: "POST" }), 400,
        "e iniciar chamada é recusado");

      /* Sem reunião não há janela de reunião. Página e script somem juntos —
         arquivo servido "por via das dúvidas" é superfície de graça.

         A página responde 404 porque é servida antes da conferência de sessão.
         O script cai no padrão-RECUSA do roteador e responde 401, exatamente
         como `sala.js` já fazia. São números diferentes para a mesma verdade, e
         o que se afirma aqui é a verdade: não sai código. */
      P.eq((await pedir(semVideo.base + "/janela")).status, 404,
        "a página da janela não existe nesta instalação");
      const scriptSem = await pedir(semVideo.base + "/janela.js");
      P.ok(scriptSem.status !== 200, "e o script dela não é servido",
        String(scriptSem.status));
      P.ok(!String(scriptSem.texto || "").includes("assumirChamada"),
        "nem por engano, no corpo da recusa");

      /* ==================================================================
         A PROMESSA DO ARQUIVO SEPARADO

         Com o vídeo desligado, o código de reunião não é só inerte: ele NÃO É
         ENTREGUE. Nada de WebRTC chega ao navegador de quem não contratou
         reunião — nem para ficar esperando atrás de um `if`.
         ================================================================== */
      const clienteSem = await pedir(semVideo.base + "/cliente.js");
      P.eq(clienteSem.status, 200, "o cliente é servido normalmente");
      P.ok(clienteSem.texto.includes("customElements.define"),
        "e é o componente do chat");
      P.ok(!clienteSem.texto.includes("RTCPeerConnection"),
        "mas SEM uma linha de WebRTC");
      P.ok(!clienteSem.texto.includes("getUserMedia"),
        "e sem nada que peça câmera");

      /* E com o vídeo LIGADO, vem junto — no mesmo arquivo, sem pedido extra. */
      const clienteCom = await pedir(chat.base + "/cliente.js");
      P.ok(clienteCom.texto.includes("RTCPeerConnection"),
        "com o vídeo ligado, o WebRTC vem no MESMO arquivo");
      P.ok(clienteCom.texto.length > clienteSem.texto.length,
        "que é maior que o do chat sem vídeo");
      P.ok(!!clienteCom.cabecalhos.etag && clienteCom.cabecalhos.etag.includes("."),
        "e o ETag cobre as DUAS partes (senão a correção do vídeo não chegaria)",
        clienteCom.cabecalhos.etag);
    } finally {
      await semVideo.derrubar();
    }

  } finally {
    for (const s of abertos) { try { await s.fechar(); } catch { } }
    await chat.derrubar();
  }

  return P.fim();
}

if (require.main === module) {
  rodar().then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((e) => { console.error("\n  EXPLODIU:", e.message, "\n", e.stack); process.exitCode = 1; });
}

module.exports = { rodar };
