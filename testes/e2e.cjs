/* ==========================================================================
   testes/e2e.cjs — o fluxo do §51, atravessando o CONECTOR

       node testes/e2e.cjs

   As outras suítes falam direto com o chat. Esta fala com o HOSPEDEIRO, como
   o navegador de um funcionário faria:

       navegador → site do cliente (porta 5299) → conector → chat (porta 5295)

   É o único teste que prova a INSTALAÇÃO — se o repasse de rotas, o repasse do
   WebSocket ou a emissão do passe quebrarem, quebra aqui. Nas outras suítes
   tudo continuaria verde, porque elas pulam o conector.

   O fluxo testado é exatamente o do §51:
       abrir → ver contatos → escolher → conversar → enviar → confirmar →
       o outro recebe em tempo real
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");

const { criarPlacar, subirChat, pedir, criarAba, espera, RAIZ } = require("./ajuda.cjs");

const PORTA_SITE = 5299;
const PORTA_CHAT = 5295;

/* Sobe o hospedeiro de demonstração com o MESMO segredo do chat — é ele que
   faz o passe assinado de um lado ser aceito do outro. */
async function subirSite(chat, { porta = PORTA_SITE, prefixo = "chat" } = {}) {
  const processo = spawn(process.execPath, [path.join(RAIZ, "exemplo", "server.js")], {
    cwd: RAIZ,
    env: {
      ...process.env,
      PORTA_EXEMPLO: String(porta),
      CHAT_PREFIXO_LOCAL: prefixo,
      CHAT_URL: `http://127.0.0.1:${chat.porta}`,
      CHAT_SEGREDO_PASSE: chat.segredos.CHAT_SEGREDO_PASSE,
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  processo.stdout.on("data", (d) => { log += d; });
  processo.stderr.on("data", (d) => { log += d; });

  const ate = Date.now() + 15_000;
  for (;;) {
    if (processo.exitCode !== null) throw new Error(`o site morreu:\n${log}`);
    try { if ((await pedir(`http://127.0.0.1:${porta}/`)).status === 200) break; } catch { }
    if (Date.now() > ate) throw new Error(`o site não subiu:\n${log}`);
    await espera(120);
  }

  return {
    base: `http://127.0.0.1:${porta}`,
    log: () => log,
    async derrubar() {
      try { processo.kill("SIGTERM"); } catch { }
      await espera(300);
      try { processo.kill("SIGKILL"); } catch { }
    },
  };
}

/* Uma "aba" que fala com o SITE (não com o chat) — inclusive para as rotas
   `/chat/*`, que o conector repassa. É assim que o navegador real funciona. */
function abaDoSite(base) {
  const potes = new Map();
  const aba = {
    potes,
    csrf: () => potes.get("cid_csrf") || "",
    async vai(caminho, opcoes = {}) {
      const metodo = opcoes.metodo || "GET";
      const r = await pedir(base + caminho, {
        ...opcoes,
        cabecalhos: {
          Cookie: [...potes].map(([k, v]) => `${k}=${v}`).join("; "),
          Origin: base,
          ...(["GET", "HEAD"].includes(metodo) ? {} : { "X-Chat-Csrf": aba.csrf() }),
          ...(opcoes.cabecalhos || {}),
        },
      });
      for (const c of r.cookies) {
        const [par] = c.split(";");
        const i = par.indexOf("=");
        const nome = par.slice(0, i).trim();
        const valor = par.slice(i + 1).trim();
        if (valor === "") potes.delete(nome); else potes.set(nome, valor);
      }
      return r;
    },
    /* Faz o que o cliente faz ao abrir: pede o passe ao site e troca por sessão. */
    async entrarNoChat(quem) {
      await aba.vai(`/entrar?quem=${quem}`);
      const p = await aba.vai("/chat/passe");
      if (p.status !== 200) throw new Error("o site não emitiu o passe: " + p.status);
      const e = await aba.vai("/chat/entrar", { metodo: "POST", corpo: { passe: p.dados.passe } });
      if (e.status !== 200) throw new Error("o chat não aceitou o passe: " + e.status + " " + e.texto);
      aba.usuario = e.dados.usuario;
      return e.dados.usuario;
    },
  };
  return aba;
}

async function rodar() {
  const P = criarPlacar("E2E (pelo conector)");
  const chat = await subirChat({
    porta: PORTA_CHAT,
    /* Duas origens: o site padrão e o segundo, que a seção "montado FORA da
       raiz" sobe na porta seguinte. */
    origens: `http://127.0.0.1:${PORTA_SITE},http://127.0.0.1:${PORTA_SITE + 1}`,
  });
  const site = await subirSite(chat);

  const sockets = [];

  try {
    /* ==================================================================== */
    P.secao("o site do hospedeiro");

    const home = await pedir(site.base + "/");
    P.eq(home.status, 200, "o site responde");
    P.ok(home.texto.includes("Empresa Demo"), "e é o site, não o chat");

    /* ==================================================================== */
    P.secao("o passe — só para quem está logado NO SITE");

    const anonimo = await pedir(site.base + "/chat/passe");
    P.recusa(anonimo, 401, "visitante sem login no site NÃO recebe passe");

    const ana = abaDoSite(site.base);
    const uAna = await ana.entrarNoChat("ana");
    P.ok(!!uAna?.id, "Ana entrou no chat sem digitar senha nenhuma");
    P.eq(uAna.nome, "Ana", "o nome veio do cadastro do SITE");
    P.eq(uAna.cargo, "Gerente de Operações", "o cargo também");

    const passe1 = await ana.vai("/chat/passe");
    P.eq(passe1.status, 200, "o passe é emitido pelo conector");
    P.ok(String(passe1.cabecalhos["cache-control"]).includes("no-store"),
      "e NUNCA é cacheado (senão viraria passe reutilizável)");

    const bruno = abaDoSite(site.base);
    const uBruno = await bruno.entrarNoChat("bruno");
    P.ok(uBruno.id !== uAna.id, "Bruno é outra pessoa");

    /* ==================================================================== */
    P.secao("o repasse das rotas");

    const eu = await ana.vai("/chat/eu");
    P.eq(eu.status, 200, "/chat/eu funciona ATRAVÉS do site");
    P.eq(eu.dados.usuario.id, uAna.id, "e devolve a pessoa certa");

    const cliente = await pedir(site.base + "/chat/cliente.js");
    P.eq(cliente.status, 200, "o cliente JavaScript é servido pelo repasse");
    P.ok(cliente.texto.includes("customElements.define"), "e é mesmo o componente");
    P.ok(String(cliente.cabecalhos["content-type"]).includes("javascript"),
      "com o tipo certo");

    /* O cookie do chat foi plantado na origem DO SITE — é isso que permite
       `SameSite=Strict`, a proteção mais forte contra CSRF. */
    P.ok(!!ana.potes.get("cid"), "o cookie do chat vive na origem do SITE");

    /* ==================================================================== */
    P.secao("§51 — o fluxo inteiro, sem treinamento");

    const pessoas = await ana.vai("/chat/pessoas");
    P.eq(pessoas.status, 200, "1. ver contatos");
    const alvo = pessoas.dados.pessoas.find((p) => p.id === uBruno.id);
    P.ok(!!alvo, "2. Bruno está na lista");

    const conversa = await ana.vai("/chat/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: uBruno.id },
    });
    P.eq(conversa.status, 200, "3. abrir conversa");
    const cid = conversa.dados.id;

    /* Bruno abre o socket ANTES, como o navegador dele faria. O socket vai
       pelo mesmo endereço do site — quem repassa o Upgrade é o conector. */
    const bilhete = (await bruno.vai("/chat/bilhete", { metodo: "POST" })).dados.bilhete;
    P.ok(!!bilhete, "4. o bilhete do WebSocket é emitido pelo repasse");

    const ws = new WebSocket(`ws://127.0.0.1:${PORTA_SITE}/chat/ws?t=${encodeURIComponent(bilhete)}`, {
      headers: { Origin: site.base, Cookie: `cid=${bruno.potes.get("cid")}` },
    });
    sockets.push(ws);
    const recebidas = [];
    ws.on("message", (d) => { try { recebidas.push(JSON.parse(d.toString())); } catch { } });
    ws.on("error", () => { });

    const abriu = await new Promise((r) => {
      const t = setTimeout(() => r(false), 6000);
      ws.on("open", () => { clearTimeout(t); r(true); });
      ws.on("unexpected-response", (_, res) => { clearTimeout(t); r("status " + res.statusCode); });
    });
    P.eq(abriu, true, "5. o WebSocket ATRAVESSA o conector (repasse de Upgrade)", String(abriu));

    const envio = await ana.vai(`/chat/conversas/${cid}/mensagens`, {
      metodo: "POST", corpo: { texto: "ZZ QA olá, tudo certo?", idCliente: "e2e-1" },
    });
    P.eq(envio.status, 200, "6. enviar mensagem");
    P.eq(envio.dados.mensagem.seq, 1, "7. o servidor confirma com o seq");

    let chegou = null;
    const ate = Date.now() + 5000;
    while (Date.now() < ate && !chegou) {
      chegou = recebidas.find((m) => m.t === "msg");
      if (!chegou) await espera(50);
    }
    P.ok(!!chegou, "8. o outro recebe EM TEMPO REAL, pelo site do cliente");
    P.eq(chegou?.m?.corpo, "ZZ QA olá, tudo certo?", "com o conteúdo certo");

    /* 9. fica lida */
    ws.send(JSON.stringify({ t: "lida", c: cid, seq: 1 }));
    await espera(500);
    const marcas = (await ana.vai(`/chat/conversas/${cid}/mensagens`)).dados.marcas;
    P.eq(marcas.lidaAte, 1, "9. a mensagem fica LIDA para quem enviou (✓✓)");

    const listaAna = await ana.vai("/chat/conversas");
    P.eq(listaAna.dados.conversas[0].naoLidas, 0, "10. e a barra lateral reflete tudo");

    /* ==================================================================== */
    P.secao("montado FORA da raiz — o caso do /restrito");

    /* ====================================================================
       POR QUE ESTA SEÇÃO EXISTE

       Toda a suíte acima roda com o chat em `/chat`, que é o padrão. O
       BemEstarClinic precisou montá-lo em `/restrito/chat` (o cookie da gestão
       tem `Path=/restrito`, e na raiz o chat não recebia autenticação
       nenhuma). Nessa instalação apareceram DOIS defeitos que a suíte inteira
       não via — e, pior, que na tela pareciam "sistema recém-instalado, ainda
       sem ninguém", não "sistema quebrado".

       O `abaDoSite` acima é um navegador ingênuo: guarda cookie sem olhar
       `Path`. É exatamente por isso que ele não pegaria o defeito. Aqui o
       cookie é conferido pelo `Path` que o servidor mandou.
       ==================================================================== */
    const PORTA_SITE_2 = PORTA_SITE + 1;
    const sitePainel = await subirSite(chat, { porta: PORTA_SITE_2, prefixo: "painel/chat" });
    try {
      const clientePainel = await pedir(sitePainel.base + "/painel/chat/cliente.js");
      P.eq(clientePainel.status, 200, "o cliente é servido no prefixo do site");

      /* A regressão do componente: o padrão do passe TEM de sair da base. Com
         `/chat/passe` fixo, ele pedia no lugar errado, tomava 404, e a lista
         de pessoas só dizia "Ninguém por aqui ainda." */
      P.ok(!/passe-url"\)\s*\|\|\s*"\/chat\/passe"/.test(clientePainel.texto),
        "o componente NÃO tem `/chat/passe` fixo como padrão");
      P.ok(/passe-url"\)\s*\|\|\s*this\.base/.test(clientePainel.texto),
        "o padrão do passe acompanha a base");

      const login = await pedir(sitePainel.base + "/entrar?quem=ana");
      const quem = (login.cookies || []).map((c) => c.split(";")[0]).join("; ");
      P.ok(!!quem, "Ana entrou no SITE", `cookies: ${JSON.stringify(login.cookies)}`);

      const passePainel = await pedir(sitePainel.base + "/painel/chat/passe", {
        cabecalhos: { Cookie: quem },
      });
      P.eq(passePainel.status, 200, "o passe é emitido no prefixo do site");

      const entrouPainel = await pedir(sitePainel.base + "/painel/chat/entrar", {
        metodo: "POST", corpo: { passe: passePainel.dados.passe },
        cabecalhos: { Cookie: quem, Origin: sitePainel.base },
      });
      P.eq(entrouPainel.status, 200, "e o chat aceita");

      /* A regressão do conector: o chat responde `Path=/chat` porque é onde ELE
         mora. Sem tradução na volta, o navegador guarda `/chat` e o cookie
         nunca mais chega em `/painel/chat/*`. */
      const potes = new Map();
      for (const linha of entrouPainel.cookies || []) {
        const [par, ...resto] = linha.split(";");
        const i = par.indexOf("=");
        const caminho = (/[Pp]ath=([^;]*)/.exec(resto.join(";")) || [, "/"])[1].trim();
        potes.set(par.slice(0, i).trim(), { valor: par.slice(i + 1).trim(), caminho });
      }
      const sessao = potes.get("cid") || { valor: "", caminho: "(não veio)" };
      P.ok(!!potes.get("cid"), "o chat plantou o cookie de sessão");
      P.eq(sessao.caminho, "/painel/chat",
        "e com o Path DO SITE, não o do chat", `veio Path=${sessao.caminho}`);

      /* Agora o teste de verdade: mandar de volta SÓ o que um navegador
         mandaria para este caminho. */
      const paraOCaminho = (destino) => [...potes]
        .filter(([, c]) => destino === c.caminho || destino.startsWith(c.caminho.replace(/\/$/, "") + "/"))
        .map(([k, c]) => `${k}=${c.valor}`).join("; ");

      const euPainel = await pedir(sitePainel.base + "/painel/chat/eu", {
        cabecalhos: { Cookie: paraOCaminho("/painel/chat/eu") },
      });
      P.eq(euPainel.status, 200, "a sessão SOBREVIVE ao pedido seguinte");
      P.eq(euPainel.dados?.usuario?.nome, "Ana", "e é a Ana, vinda do cadastro do site");

      const pessoasPainel = await pedir(sitePainel.base + "/painel/chat/pessoas", {
        cabecalhos: { Cookie: paraOCaminho("/painel/chat/pessoas") },
      });
      P.eq(pessoasPainel.status, 200, "e a lista de pessoas responde, em vez de 401");
    } finally {
      await sitePainel.derrubar();
    }

    /* ==================================================================== */
    P.secao("o site sobrevive ao chat");

    /* Se o chat cair, o SITE não pode cair junto. É o requisito que faz o
       repasse valer a pena em vez de apontar o navegador direto para o chat. */
    await chat.derrubar();
    await espera(500);

    const siteVivo = await pedir(site.base + "/");
    P.eq(siteVivo.status, 200, "com o chat FORA DO AR, o site continua no ar");

    const chatFora = await ana.vai("/chat/eu");
    P.eq(chatFora.status, 503, "e as rotas do chat respondem 503, com educação");
    P.ok(!/ECONNREFUSED|at Socket|\.js:\d/.test(chatFora.texto),
      "sem vazar detalhe técnico do erro de conexão", chatFora.texto.slice(0, 120));

  } finally {
    for (const s of sockets) { try { s.terminate(); } catch { } }
    await site.derrubar();
    await chat.derrubar();
  }

  return P.fim();
}

if (require.main === module) {
  rodar().then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((e) => { console.error("\n  EXPLODIU:", e.message, "\n", e.stack); process.exitCode = 1; });
}

module.exports = { rodar };
