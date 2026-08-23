/* ==========================================================================
   testes/ajuda.cjs — o mínimo para as suítes, em Node puro

   Sem framework, como o resto do parque. Contadores na mão, HTTP de verdade,
   cookie de verdade — é o que faz o teste provar o SISTEMA e não a fachada.

   ---------------------------------------------------------------------------
   AS REGRAS QUE VÊM DE INCIDENTE, e que não se negociam

   1. DADOS DE TESTE LEVAM O PREFIXO `ZZ QA` E SÃO APAGADOS POR ID.
      Nunca por `LIKE`, nunca por nome. Um `DELETE ... LIKE '%'` já apagou uma
      tabela inteira num projeto deste parque. Aqui a suíte sobe contra um
      BANCO PRÓPRIO, descartável, então nem isso é preciso — mas o prefixo
      fica, porque o dia em que alguém apontar a suíte para outro banco por
      engano, os restos serão reconhecíveis.

   2. A RESPOSTA DENUNCIA A SI MESMA.
      Esta suíte já teria morrido do jeito clássico: uma rota devolve erro, o
      teste lê `r.dados.conversas.length` e o que aparece é
      `Cannot read properties of undefined`, apontando para uma linha sem
      defeito nenhum. Por isso `pedir()` guarda status e corpo, e `ok()` mostra
      os dois quando falha.

   3. O SERVIDOR SOBE NUMA PORTA PRÓPRIA, COM BANCO PRÓPRIO.
      Testar contra o banco de desenvolvimento faria a suíte apagar conversas
      de quem estava usando o chat para conferir alguma coisa.
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const RAIZ = path.join(__dirname, "..");

/* ==========================================================================
   CONTADORES
   ========================================================================== */
function criarPlacar(titulo) {
  let passou = 0, falhou = 0;
  const falhas = [];

  const placar = {
    ok(condicao, nome, detalhe) {
      if (condicao) { passou++; console.log("  ✓", nome); return true; }
      falhou++;
      const linha = nome + (detalhe ? "\n      → " + detalhe : "");
      falhas.push(linha);
      console.log("  ✗", nome, detalhe ? "\n      → " + detalhe : "");
      return false;
    },
    eq(a, b, nome) {
      return placar.ok(a === b, nome, `esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
    },
    /* Espera que algo FALHE com certo status. É o formato da maioria dos
       testes de segurança: "isto tem de ser recusado". */
    recusa(resposta, statusEsperado, nome) {
      return placar.ok(resposta.status === statusEsperado, nome,
        `esperava ${statusEsperado}, veio ${resposta.status} ${JSON.stringify(resposta.dados)?.slice(0, 160)}`);
    },
    secao(nome) { console.log(`\n  ── ${nome} ${"─".repeat(Math.max(0, 54 - nome.length))}`); },
    fim() {
      console.log(`\n  ${titulo}: ${passou} passaram, ${falhou} falharam`);
      if (falhas.length) {
        console.log("\n  FALHAS:");
        for (const f of falhas) console.log("   ·", f);
      }
      return falhou === 0;
    },
    get total() { return passou + falhou; },
    get falhou() { return falhou; },
  };
  return placar;
}

/* ==========================================================================
   SUBIR O SERVIDOR
   ========================================================================== */
async function subirChat({ porta = 5297, origens = "http://127.0.0.1:5299", extra = {} } = {}) {
  const marca = crypto.randomBytes(4).toString("hex");
  const pastaDados = path.join(__dirname, "saida", `chat-${marca}`);
  fs.mkdirSync(pastaDados, { recursive: true });

  const segredos = {
    CHAT_SEGREDO_PASSE: crypto.randomBytes(32).toString("base64"),
    CHAT_SEGREDO_BUSCA: crypto.randomBytes(32).toString("base64"),
    CHAT_DADOS_CHAVE: crypto.randomBytes(32).toString("base64"),
  };

  const ambiente = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(porta),
    HOST: "127.0.0.1",
    CHAT_BASE: `http://127.0.0.1:${porta}`,
    CHAT_ORIGENS: origens,
    CHAT_BANCO: "sqlite",
    CHAT_SQLITE: path.join(pastaDados, "chat.db"),
    CHAT_ARQUIVOS: path.join(pastaDados, "arquivos"),
    /* Sem proxy na frente durante o teste: o IP vem do socket, e nenhum
       X-Forwarded-For é obedecido. É o que permite testar a defesa de
       falsificação de IP. */
    CHAT_PROXIES: "0",
    /* ====================================================================
       O QUE A SUÍTE NÃO PODE HERDAR DA MÁQUINA

       O servidor de teste lê o `.env` do projeto como qualquer outro — e o
       `.env` de quem desenvolve tem o que aquela pessoa estava experimentando.
       Uma suíte que passa ou falha conforme o `.env` da máquina não é uma
       suíte: ela mede o ambiente, não o código.

       Aconteceu com `CHAT_VIDEO`: ligado no `.env` para testar reunião no
       navegador, ele fazia o teste "com o vídeo DESLIGADO" subir um servidor
       com vídeo LIGADO — e o teste falhava dizendo que o código estava errado.

       Tudo que a suíte precisa controlar entra AQUI, explicitamente. `extra`
       vem depois e vence, que é como cada suíte liga o que quer testar.
       ==================================================================== */
    CHAT_VIDEO: "0",
    ...segredos,
    ...extra,
  };

  const processo = spawn(process.execPath, [path.join(RAIZ, "server.js")], {
    env: ambiente, cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  processo.stdout.on("data", (d) => { log += d; });
  processo.stderr.on("data", (d) => { log += d; });

  /* Espera a porta responder, em vez de dormir um tempo fixo. Sleep fixo é
     como se ganha um teste que passa na máquina rápida e falha na CI. */
  const ate = Date.now() + 20_000;
  for (;;) {
    if (processo.exitCode !== null)
      throw new Error(`o servidor morreu na partida (código ${processo.exitCode}):\n${log}`);
    try {
      const r = await pedir(`http://127.0.0.1:${porta}/chat/saude`);
      if (r.status === 200) break;
    } catch { }
    if (Date.now() > ate) throw new Error(`o servidor não respondeu em 20s:\n${log}`);
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    porta,
    base: `http://127.0.0.1:${porta}/chat`,
    segredos,
    pastaDados,
    log: () => log,
    async derrubar() {
      /* Mata pelo PID deste processo — nunca por nome. `pkill node` já
         derrubou o site de um cliente neste parque. */
      try { processo.kill("SIGTERM"); } catch { }
      await new Promise((r) => setTimeout(r, 400));
      try { processo.kill("SIGKILL"); } catch { }
      try { fs.rmSync(pastaDados, { recursive: true, force: true }); } catch { }
    },
  };
}

/* ==========================================================================
   CLIENTE HTTP COM COOKIE

   O cookie é o que prova que a sessão funciona. Um cliente que não guarda
   cookie testaria só a primeira requisição de cada fluxo.
   ========================================================================== */
function pedir(url, opcoes = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const corpo = opcoes.corpo !== undefined
      ? (Buffer.isBuffer(opcoes.corpo) ? opcoes.corpo : Buffer.from(JSON.stringify(opcoes.corpo)))
      : null;

    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opcoes.metodo || "GET",
      headers: {
        ...(corpo && !opcoes.bruto ? { "Content-Type": "application/json" } : {}),
        ...(corpo ? { "Content-Length": corpo.length } : {}),
        ...(opcoes.cabecalhos || {}),
      },
      timeout: 15_000,
    }, (res) => {
      const pedacos = [];
      res.on("data", (p) => pedacos.push(p));
      res.on("end", () => {
        const bruto = Buffer.concat(pedacos);
        let dados = null;
        try { dados = JSON.parse(bruto.toString("utf8")); } catch { }
        resolve({
          status: res.statusCode,
          cabecalhos: res.headers,
          cookies: res.headers["set-cookie"] || [],
          dados,
          bruto,
          texto: bruto.toString("utf8"),
        });
      });
    });

    req.on("timeout", () => { req.destroy(new Error("tempo esgotado")); });
    req.on("error", reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

/* Uma "aba de navegador": guarda cookies e devolve o CSRF automaticamente. */
function criarAba(base) {
  const potes = new Map();

  function cabecalhoDeCookie() {
    return [...potes.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  function guardar(cookies) {
    for (const c of cookies) {
      const [par] = c.split(";");
      const i = par.indexOf("=");
      const nome = par.slice(0, i).trim();
      const valor = par.slice(i + 1).trim();
      if (valor === "") potes.delete(nome); else potes.set(nome, valor);
    }
  }

  const aba = {
    potes,
    csrf: () => potes.get("cid_csrf") || "",

    async vai(caminho, opcoes = {}) {
      const metodo = opcoes.metodo || "GET";
      const r = await pedir(base + caminho, {
        ...opcoes,
        cabecalhos: {
          Cookie: cabecalhoDeCookie(),
          ...(["GET", "HEAD"].includes(metodo) ? {} : { "X-Chat-Csrf": aba.csrf() }),
          ...(opcoes.cabecalhos || {}),
        },
      });
      guardar(r.cookies);
      return r;
    },
  };
  return aba;
}

/* ==========================================================================
   O PASSE — assinado do lado do teste, como o conector faria
   ========================================================================== */
function emitirPasse(segredo, usuario, { contexto = "empresa-teste", validade = 60, jti = null, iat = null } = {}) {
  const agora = iat ?? Math.floor(Date.now() / 1000);
  const corpo = {
    sub: String(usuario.id), ident: usuario.identidade || "",
    nome: usuario.nome, sobrenome: usuario.sobrenome || "",
    email: usuario.email || "", avatar: usuario.avatar || "", cargo: usuario.cargo || "",
    departamento: usuario.departamento || "", papel: usuario.papel === "admin" ? "admin" : "membro",
    ctx: contexto, iat: agora, exp: agora + validade,
    jti: jti || crypto.randomBytes(16).toString("base64url"),
  };
  const b64 = Buffer.from(JSON.stringify(corpo)).toString("base64url");
  const assinatura = crypto.createHmac("sha256", segredo).update(b64).digest("base64url");
  return `${b64}.${assinatura}`;
}

/* Entra e devolve a aba já autenticada. */
async function entrar(chat, usuario, opcoes = {}) {
  const aba = criarAba(chat.base);
  const passe = emitirPasse(chat.segredos.CHAT_SEGREDO_PASSE, usuario, opcoes);
  const r = await aba.vai("/entrar", { metodo: "POST", corpo: { passe } });
  if (r.status !== 200) throw new Error(`não entrou: ${r.status} ${JSON.stringify(r.dados)}`);
  aba.usuario = r.dados.usuario;
  return aba;
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { criarPlacar, subirChat, pedir, criarAba, emitirPasse, entrar, espera, RAIZ };
