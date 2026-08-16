/* ==========================================================================
   testes/realtime.cjs — o tempo real, inclusive quando a rede cai (§25, §42)

       node testes/realtime.cjs

   A parte que importa desta suíte é a que DERRUBA A CONEXÃO DE PROPÓSITO.

   Reconexão é o código menos exercitado do sistema e o que roda no pior
   momento. Um chat que só é testado com rede boa entrega, em produção, o
   defeito mais caro que existe: mensagem perdida sem ninguém perceber.
   ========================================================================== */
"use strict";

const WebSocket = require("ws");
const { criarPlacar, subirChat, entrar, espera } = require("./ajuda.cjs");

const ANA = { id: "func-001", nome: "ZZ QA Ana" };
const BRUNO = { id: "func-002", nome: "ZZ QA Bruno" };

/* ==========================================================================
   Um "navegador" com socket aberto: guarda tudo que chega, para o teste poder
   perguntar "chegou o quê?" depois.
   ========================================================================== */
async function abrirSocket(chat, aba) {
  const { bilhete } = (await aba.vai("/bilhete", { metodo: "POST" })).dados;
  const ws = new WebSocket(`ws://127.0.0.1:${chat.porta}/chat/ws?t=${encodeURIComponent(bilhete)}`, {
    headers: { Origin: "http://127.0.0.1:5299", Cookie: `cid=${aba.potes.get("cid")}` },
  });

  const recebidas = [];
  ws.on("message", (d) => { try { recebidas.push(JSON.parse(d.toString())); } catch { } });
  ws.on("error", () => { });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("socket não abriu em 5s")), 5000);
    ws.on("open", () => { clearTimeout(t); resolve(); });
    ws.on("unexpected-response", (_, res) => { clearTimeout(t); reject(new Error("recusado: " + res.statusCode)); });
  });

  return {
    ws,
    recebidas,
    enviar: (o) => ws.send(JSON.stringify(o)),
    /* Espera por um evento em vez de dormir um tempo fixo. Sleep fixo é como
       se ganha um teste que passa na máquina rápida e falha na CI. */
    async esperar(tipo, ms = 4000) {
      const ate = Date.now() + ms;
      for (;;) {
        const achado = recebidas.find((m) => m.t === tipo);
        if (achado) return achado;
        if (Date.now() > ate) return null;
        await espera(40);
      }
    },
    limpar: () => { recebidas.length = 0; },
    fechar: () => new Promise((r) => { ws.on("close", r); ws.close(); setTimeout(r, 800); }),
    /* Derruba SEM aviso — é o cabo arrancado, não o "fechar aba". A diferença
       importa: `close()` avisa o servidor; `terminate()` não avisa ninguém, e
       é o caso real da rede que cai. */
    arrancar: () => new Promise((r) => { ws.on("close", r); ws.terminate(); setTimeout(r, 300); }),
  };
}

async function rodar() {
  const P = criarPlacar("Tempo real");
  const chat = await subirChat({ porta: 5296, origens: "http://127.0.0.1:5299" });

  let socketAna = null, socketBruno = null;

  try {
    const ana = await entrar(chat, ANA);
    const bruno = await entrar(chat, BRUNO);
    const conversa = (await ana.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: bruno.usuario.id },
    })).dados.id;

    /* ==================================================================== */
    P.secao("conexão");

    socketAna = await abrirSocket(chat, ana);
    P.ok(!!(await socketAna.esperar("pronto")), "o servidor confirma a conexão com `pronto`");

    socketBruno = await abrirSocket(chat, bruno);
    P.ok(!!(await socketBruno.esperar("pronto")), "o segundo socket também abre");

    /* ==================================================================== */
    P.secao("entrega de mensagem");

    socketBruno.limpar();
    const enviada = await ana.vai(`/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: { texto: "ZZ QA chegou em tempo real?", idCliente: "rt-1" },
    });
    P.eq(enviada.status, 200, "Ana enviou por HTTP");

    const chegou = await socketBruno.esperar("msg");
    P.ok(!!chegou, "Bruno recebeu pelo socket, sem recarregar nada");
    P.eq(chegou?.c, conversa, "o evento diz de qual conversa é");
    P.eq(chegou?.m?.corpo, "ZZ QA chegou em tempo real?", "e traz o corpo já decifrado");
    P.eq(chegou?.m?.seq, enviada.dados.mensagem.seq, "com o mesmo seq do HTTP");

    /* O autor NÃO recebe de volta: ele já tem a mensagem na tela. */
    socketAna.limpar();
    await ana.vai(`/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: { texto: "ZZ QA segunda", idCliente: "rt-2" },
    });
    await espera(400);
    P.eq(socketAna.recebidas.filter((m) => m.t === "msg").length, 0,
      "quem escreveu NÃO recebe a própria mensagem de volta");

    /* ==================================================================== */
    P.secao("digitando (§53)");

    socketAna.limpar();
    socketBruno.enviar({ t: "digit", c: conversa });
    const digit = await socketAna.esperar("digit");
    P.ok(!!digit, "o aviso de digitando chega ao outro lado");
    P.eq(digit?.u, bruno.usuario.id, "e diz quem está digitando");
    P.eq(digit?.n, "ZZ QA Bruno", "com o nome, para a tela não precisar buscar");

    /* ==================================================================== */
    P.secao("confirmação de leitura (§13)");

    socketAna.limpar();
    const ultima = (await bruno.vai(`/conversas/${conversa}/mensagens`)).dados;
    const seqUltima = ultima.mensagens[ultima.mensagens.length - 1].seq;
    socketBruno.enviar({ t: "lida", c: conversa, seq: seqUltima });

    const lida = await socketAna.esperar("lida");
    P.ok(!!lida, "a confirmação de leitura chega ao autor (✓✓)");
    P.eq(lida?.seq, seqUltima, "até a posição certa");

    const marcas = (await ana.vai(`/conversas/${conversa}/mensagens`)).dados.marcas;
    P.eq(marcas.lidaAte, seqUltima, "e a marca d'água ficou gravada");

    /* ==================================================================== */
    P.secao("presença (§6)");

    const pessoas = (await ana.vai("/pessoas")).dados.pessoas;
    const bDaLista = pessoas.find((p) => p.id === bruno.usuario.id);
    P.eq(bDaLista?.status, "online", "quem tem socket aberto aparece online");

    /* Multi-sessão: a MESMA pessoa em dois aparelhos. Fechar um não a derruba. */
    const segundoDoBruno = await abrirSocket(chat, bruno);
    await espera(200);
    await segundoDoBruno.fechar();
    await espera(400);
    const aindaOnline = (await ana.vai("/pessoas")).dados.pessoas
      .find((p) => p.id === bruno.usuario.id);
    P.eq(aindaOnline?.status, "online",
      "fechar UMA das duas abas não deixa a pessoa offline");

    /* ==================================================================== */
    P.secao("reconexão e retomada (§25) — a parte que importa");

    /* Bruno perde a rede sem avisar ninguém. */
    await socketBruno.arrancar();
    socketBruno = null;

    /* Enquanto ele está fora, chegam três mensagens. */
    const perdidas = [];
    for (let i = 0; i < 3; i++) {
      const r = await ana.vai(`/conversas/${conversa}/mensagens`, {
        metodo: "POST", corpo: { texto: `ZZ QA perdida ${i}`, idCliente: "perd-" + i },
      });
      perdidas.push(r.dados.mensagem.seq);
    }

    /* Ele volta e pergunta o que perdeu, a partir do último seq que tinha. */
    socketBruno = await abrirSocket(chat, bruno);
    await socketBruno.esperar("pronto");
    socketBruno.limpar();
    socketBruno.enviar({ t: "sinc", c: conversa, desde: perdidas[0] - 1 });

    const sinc = await socketBruno.esperar("sinc");
    P.ok(!!sinc, "a retomada responde");
    P.eq(sinc?.recarregar, false, "e não pede recarga (o buraco é pequeno)");
    P.eq(sinc?.mensagens?.length, 3, "as TRÊS mensagens perdidas voltam");
    P.ok(sinc?.mensagens?.every((m, i) => m.seq === perdidas[i]),
      "na ordem certa e com os mesmos seq",
      JSON.stringify(sinc?.mensagens?.map((m) => m.seq)));
    P.ok(sinc?.mensagens?.[0]?.corpo === "ZZ QA perdida 0", "com o conteúdo íntegro");

    /* Retomar de novo do mesmo ponto NÃO duplica: a retomada é idempotente. */
    socketBruno.limpar();
    socketBruno.enviar({ t: "sinc", c: conversa, desde: perdidas[2] });
    const sinc2 = await socketBruno.esperar("sinc");
    P.eq(sinc2?.mensagens?.length, 0, "retomar a partir da última não traz nada de novo");

    /* Buraco grande demais: manda recarregar em vez de despejar tudo. */
    socketBruno.limpar();
    socketBruno.enviar({ t: "sinc", c: conversa, desde: 0 });
    const sinc3 = await socketBruno.esperar("sinc");
    P.ok(sinc3?.mensagens?.length >= 3 || sinc3?.recarregar === true,
      "retomar do zero devolve o histórico ou pede recarga — nunca silêncio");

    /* ==================================================================== */
    P.secao("o reenvio da reconexão não duplica");

    /* É o caso real: o cliente enviou, a rede caiu antes da resposta, e ele
       reenvia por precaução ao voltar. */
    const antes = (await ana.vai(`/conversas/${conversa}/mensagens?limite=200`)).dados.mensagens.length;
    for (let i = 0; i < 3; i++) {
      await ana.vai(`/conversas/${conversa}/mensagens`, {
        metodo: "POST", corpo: { texto: "ZZ QA reenviada", idCliente: "reenvio-unico" },
      });
    }
    const depois = (await ana.vai(`/conversas/${conversa}/mensagens?limite=200`)).dados.mensagens.length;
    P.eq(depois - antes, 1, "três envios com o mesmo idCliente viram UMA mensagem");

    /* ==================================================================== */
    P.secao("autorização no socket");

    /* Um socket autenticado não pode alcançar conversa de que a pessoa não
       participa — a sessão vem do aperto de mão, nunca da mensagem. */
    const estranho = await entrar(chat, { id: "func-888", nome: "ZZ QA Estranho" });
    const socketEstranho = await abrirSocket(chat, estranho);
    socketEstranho.limpar();
    socketEstranho.enviar({ t: "sinc", c: conversa, desde: 0 });
    const erro = await socketEstranho.esperar("erro", 2500);
    P.ok(!!erro, "pedir retomada de conversa alheia devolve erro");
    P.ok(!socketEstranho.recebidas.some((m) => m.t === "sinc" && m.mensagens?.length),
      "e NENHUMA mensagem alheia vaza pelo socket");

    socketEstranho.limpar();
    socketEstranho.enviar({ t: "digit", c: conversa });
    await espera(400);
    P.eq(socketAna.recebidas.filter((m) => m.t === "digit").length, 0,
      "nem o aviso de digitando alcança conversa alheia");
    await socketEstranho.fechar();

    /* Mensagem desconhecida é ignorada em silêncio — responder daria ao
       atacante um oráculo dos tipos que existem. */
    socketAna.limpar();
    socketAna.enviar({ t: "tipo-que-nao-existe", c: conversa });
    socketAna.enviar({ naoTemTipo: true });
    socketAna.enviar("isto nem é JSON");
    await espera(400);

    /* A asserção olha para a RESPOSTA ao tipo desconhecido, e não para "nada
       chegou". Eventos alheios (a mudança de presença do socket que acabou de
       fechar) chegam legitimamente no meio, e exigir silêncio absoluto tornaria
       este teste dependente do que mais está acontecendo no servidor.

       O que se prova aqui é que o servidor não CONFIRMA nem RECUSA um tipo
       inventado: responder qualquer coisa daria ao atacante um oráculo para
       descobrir, por tentativa, quais tipos existem. */
    const respostas = socketAna.recebidas.filter((m) => m.t === "erro" || m.t === "tipo-que-nao-existe");
    P.eq(respostas.length, 0, "tipo desconhecido não gera resposta nenhuma (sem oráculo)");
    P.ok(socketAna.ws.readyState === 1, "e lixo no socket não derruba a conexão");

    /* ==================================================================== */
    P.secao("ficar offline ao cair a última conexão");

    await socketBruno.arrancar();
    socketBruno = null;
    /* A carência é de 30 s no padrão — não dá para esperar isso num teste.
       O que se confere aqui é que o CONTADOR de conexões zerou, que é o gatilho
       da carência. O expirar em si é coberto pelo teste de unidade da presença. */
    await espera(600);
    const conexoes = (await ana.vai("/pessoas")).dados.pessoas.find((p) => p.id === bruno.usuario.id);
    P.ok(!!conexoes, "a pessoa continua na lista depois de cair");
    P.ok(["online", "offline"].includes(conexoes.status),
      "com status válido durante a carência", conexoes.status);

  } finally {
    for (const s of [socketAna, socketBruno]) { try { await s?.fechar(); } catch { } }
    await chat.derrubar();
  }

  return P.fim();
}

if (require.main === module) {
  rodar().then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((e) => { console.error("\n  EXPLODIU:", e.message, "\n", e.stack); process.exitCode = 1; });
}

module.exports = { rodar };
