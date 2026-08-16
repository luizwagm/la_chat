/* ==========================================================================
   exemplo/server.js — um HOSPEDEIRO de mentira, para provar a integração

       node exemplo/server.js          (porta 5199)

   Este arquivo NÃO faz parte do módulo. Ele existe por dois motivos:

   1. PROVAR A INSTALAÇÃO. Ele usa o conector exatamente como o BemEstarClinic
      ou a Borda Tudo usariam — as mesmas duas linhas do INSTALAR.md. Se a
      integração quebrar, quebra aqui primeiro, e não no site de um cliente.

   2. SER A DOCUMENTAÇÃO QUE NÃO ENVELHECE. Um exemplo em README apodrece
      calado. Este roda, e a suíte E2E o usa — então ele para de funcionar
      junto com o teste, e não seis meses depois.

   O "login" aqui é uma caixinha que escolhe quem você é. É de mentira DE
   PROPÓSITO: o chat não deve ter opinião sobre como o hospedeiro autentica —
   é justamente esse o ponto do contrato do §39.
   ========================================================================== */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

/* Lê o mesmo `.env` do chat: o SEGREDO DO PASSE é o mesmo dos dois lados. É
   ele que faz o chat aceitar "este é o João" sem pedir senha. */
require("../config.js");

const conectorChat = require("../conector/lachat.js");

const PORTA = Number(process.env.PORTA_EXEMPLO) || 5199;
const URL_CHAT = process.env.CHAT_URL || `http://127.0.0.1:${process.env.PORT || 5197}`;

/* ==========================================================================
   O "CADASTRO" DO HOSPEDEIRO

   No site de verdade isto é a tabela `usuarios` do /restrito, ou o cadastro
   que o cliente já tem. O chat nunca vê esta estrutura — ele só recebe o que
   a função `usuario` devolve.
   ========================================================================== */
const PESSOAS = {
  ana: { id: "func-001", nome: "Ana", sobrenome: "Ribeiro", email: "ana@empresa.com",
         cargo: "Gerente de Operações", departamento: "Operações", papel: "admin" },
  bruno: { id: "func-002", nome: "Bruno", sobrenome: "Tavares", email: "bruno@empresa.com",
           cargo: "Analista", departamento: "Financeiro", papel: "membro" },
  carla: { id: "func-003", nome: "Carla", sobrenome: "Menezes", email: "carla@empresa.com",
           cargo: "Designer", departamento: "Marketing", papel: "membro" },
};

const apelidoDe = (req) =>
  (/(?:^|;\s*)quem=([a-z]+)/.exec(req.headers.cookie || "") || [])[1] || "";

/* ==========================================================================
   AS DUAS LINHAS DA INSTALAÇÃO — é isto que o site do cliente acrescenta
   ========================================================================== */
/* Onde o chat mora NESTE site. O padrão é `/chat`; o BemEstarClinic precisou
   de `/restrito/chat`, e é isso que a variável permite exercitar — montar fora
   da raiz é a instalação que quebrou duas vezes em silêncio. */
const PREFIXO = String(process.env.CHAT_PREFIXO_LOCAL || "chat").replace(/^\/+|\/+$/g, "");

const chat = conectorChat({
  url: URL_CHAT,
  segredo: process.env.CHAT_SEGREDO_PASSE,
  contexto: "empresa-demo",
  prefixo: PREFIXO,

  /* O CONTRATO (§39). O hospedeiro responde "quem é este visitante?" usando a
     PRÓPRIA sessão. Aqui é um cookie de brincadeira; no BemEstarClinic seria
     `sessaoDe(req)` do /restrito. */
  usuario(req) {
    const p = PESSOAS[apelidoDe(req)];
    return p || null;
  },
});

function tratar(req, res) {
  /* LINHA 1 — no topo do handler, antes de qualquer rota do site. */
  if (chat.rota(req, res)) return;

  const url = new URL(req.url, `http://127.0.0.1:${PORTA}`);

  /* --- o "login" de mentira --- */
  if (url.pathname === "/entrar") {
    const quem = url.searchParams.get("quem");
    if (!PESSOAS[quem]) { res.writeHead(400); return res.end("quem?"); }
    res.writeHead(302, {
      "Set-Cookie": `quem=${quem}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      Location: "/",
    });
    return res.end();
  }

  if (url.pathname === "/sair") {
    res.writeHead(302, { "Set-Cookie": "quem=; Path=/; Max-Age=0", Location: "/" });
    return res.end();
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const quem = apelidoDe(req);
    const pessoa = PESSOAS[quem];

    /* Substituição por marcador, como o `publicar` dos sites do parque faz.
       O nome é escapado porque aqui ele VIRA HTML — é o hospedeiro montando
       a própria página, e a regra de escapar vale para ele também. */
    const esc = (s) => String(s).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const saida = html
      .replace("<!--#QUEM-->", pessoa
        ? `Você é <b>${esc(pessoa.nome + " " + pessoa.sobrenome)}</b> — ${esc(pessoa.cargo)}. <a href="/sair">sair</a>`
        : "Escolha quem você é para entrar:")
      .replace("<!--#CHAT-->", pessoa
        ? `<script src="/${esc(PREFIXO)}/cliente.js" defer data-auto data-modo="drawer" data-base="/${esc(PREFIXO)}"></script>`
        : "");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(saida);
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("não encontrado");
}

/* ==========================================================================
   ESCUTAR NOS DOIS LOOPBACKS — 127.0.0.1 E ::1

   No Windows (e em muitas distribuições), `localhost` resolve para `::1`
   ANTES de `127.0.0.1`. Um servidor que escuta só em IPv4 recebe, de quem
   digitou `http://localhost:5199`, um "não foi possível conectar" — enquanto
   `http://127.0.0.1:5199` funciona perfeitamente.

   O sintoma é péssimo: parece que o servidor não subiu, e o log diz que subiu.
   Aconteceu aqui.

   A saída ÓBVIA seria `listen(PORTA)` sem endereço — mas isso escuta em TODAS
   as interfaces, e um chat de demonstração passaria a ser alcançável por
   qualquer máquina da rede local. São DOIS servidores, cada um preso ao seu
   loopback, compartilhando o mesmo handler: continua inacessível de fora.

   O serviço de VERDADE (server.js) não faz isso — ele escuta só em 127.0.0.1,
   porque em produção quem fala com a internet é o nginx.
   ========================================================================== */
const ENDERECOS = ["127.0.0.1", "::1"];
const servidores = [];

for (const endereco of ENDERECOS) {
  const s = http.createServer(tratar);

  /* LINHA 2 — em CADA servidor. Sem ela o chat carrega, autentica e nunca
     recebe mensagem em tempo real, sem erro nenhum aparecendo. */
  chat.conectarUpgrade(s);

  /* Falhar num dos dois não pode derrubar o outro: há máquinas com IPv6
     desligado, e ali o `::1` simplesmente não existe. */
  s.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`  ✖ a porta ${PORTA} já está em uso (${endereco})`);
      process.exit(1);
    }
    console.warn(`  ⚠ não consegui escutar em ${endereco}: ${e.code} (seguindo sem ele)`);
  });

  s.listen(PORTA, endereco);
  servidores.push(s);
}

/* O aviso sai uma vez só, quando o primeiro conseguir subir. */
servidores[0].once("listening", () => {
  console.log(`
  Hospedeiro de demonstração
  ─────────────────────────────────────────────
  Site        http://127.0.0.1:${PORTA}   (e http://localhost:${PORTA})
  Chat        ${URL_CHAT}  (repassado em /chat)
  Conector    ${chat.ligado ? "ativo" : "INATIVO — falta CHAT_SEGREDO_PASSE"}

  Abra duas janelas anônimas e entre como pessoas diferentes:
      http://127.0.0.1:${PORTA}/entrar?quem=ana
      http://127.0.0.1:${PORTA}/entrar?quem=bruno
`);
});

module.exports = { servidores, servidor: servidores[0], PESSOAS };
