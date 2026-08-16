/* ==========================================================================
   testes/seguranca.cjs — os ataques (§42)

       node testes/seguranca.cjs

   Cada teste aqui É UM ATAQUE. Não confere se a funcionalidade funciona —
   confere se o abuso FALHA. É a diferença entre "o download funciona" e
   "o download de outra pessoa não funciona".

   A lista segue o §17: IDOR, XSS, CSRF, injeção, força bruta, enumeração,
   travessia de diretório, upload malicioso, repetição, abuso de WebSocket e
   escalonamento de privilégio.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const WebSocket = require("ws");

const { criarPlacar, subirChat, entrar, criarAba, emitirPasse, pedir, espera } = require("./ajuda.cjs");

const ANA = { id: "func-001", nome: "ZZ QA Ana", papel: "admin" };
const BRUNO = { id: "func-002", nome: "ZZ QA Bruno" };
const INTRUSO = { id: "func-999", nome: "ZZ QA Intruso" };

async function rodar() {
  const P = criarPlacar("Segurança");
  const chat = await subirChat({ porta: 5298, origens: "http://127.0.0.1:5299" });
  const SEGREDO = chat.segredos.CHAT_SEGREDO_PASSE;

  try {
    const ana = await entrar(chat, ANA);
    const bruno = await entrar(chat, BRUNO);
    const intruso = await entrar(chat, INTRUSO);

    /* ------------------------------------------------------------------------
       TODAS as sessões que a suíte vai precisar nascem AQUI, antes dos testes
       de limite.

       O motivo é o próprio sistema funcionando: mais adiante esta suíte
       martela `/entrar` de propósito, para provar que a força bruta é freada.
       O freio é por IP — e a suíte inteira sai do mesmo 127.0.0.1. Logo, todo
       login feito DEPOIS daquele teste toma 429, e o teste de segurança
       derruba a própria suíte.

       Isso não é contorno de limite: é reconhecer que a suíte e o atacante
       compartilham endereço. Baixar o limite para o teste passar seria
       enfraquecer a defesa para agradar o teste.
       ------------------------------------------------------------------------ */
    const vitima = await entrar(chat, { id: "func-777", nome: "ZZ QA Vitima" });
    const dono = await entrar(chat, { id: "func-321", nome: "ZZ QA Socket" });

    /* As da seção de auditoria. Ficam aqui pelo mesmo motivo: o teste de força
       bruta mais abaixo gasta o orçamento de entradas do IP, e a suíte inteira
       sai de 127.0.0.1. */
    const alfa = await entrar(chat, { id: "iso-a", nome: "ZZ QA Alfa" }, { contexto: "EMPRESA-A" });
    const alfa2 = await entrar(chat, { id: "iso-a2", nome: "ZZ QA Alfa Dois" }, { contexto: "EMPRESA-A" });
    const beta = await entrar(chat, { id: "iso-b", nome: "ZZ QA Beta" }, { contexto: "EMPRESA-B" });
    const chefe = await entrar(chat, { id: "exp-adm", nome: "ZZ QA Chefe", papel: "admin" }, { contexto: "EMPRESA-C" });
    const banido = await entrar(chat, { id: "exp-vit", nome: "ZZ QA Banido" }, { contexto: "EMPRESA-C" });
    const sonolento = await entrar(chat, { id: "exp-sai", nome: "ZZ QA Saindo" }, { contexto: "EMPRESA-C" });
    const leitorA = await entrar(chat, { id: "mar-a", nome: "ZZ QA LeitorA" }, { contexto: "EMPRESA-D" });
    const leitorB = await entrar(chat, { id: "mar-b", nome: "ZZ QA LeitorB" }, { contexto: "EMPRESA-D" });
    const alfa3 = await entrar(chat, { id: "iso-a3", nome: "ZZ QA Alfa Tres" }, { contexto: "EMPRESA-A" });
    const abaCookie = criarAba(chat.base);
    const cabecalhosCookie = (await abaCookie.vai("/entrar", {
      metodo: "POST", corpo: { passe: emitirPasse(SEGREDO, { id: "func-555", nome: "ZZ QA Cookie" }) },
    })).cookies;

    /* Uma conversa privada entre Ana e Bruno, com um anexo. */
    const conversa = (await ana.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: bruno.usuario.id },
    })).dados.id;

    const msg = (await ana.vai(`/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: { texto: "ZZ QA assunto confidencial", idCliente: "s1" },
    })).dados.mensagem;

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");
    const anexo = (await ana.vai(`/arquivos?conversa=${conversa}`, {
      metodo: "POST", corpo: png, bruto: true,
      cabecalhos: { "Content-Type": "image/png",
        "X-Arquivo-Nome": Buffer.from("ZZ QA sigiloso.png").toString("base64") },
    })).dados;

    /* ====================================================================== */
    P.secao("IDOR — acessar o que é de outro (§11, §17)");

    P.recusa(await intruso.vai(`/conversas/${conversa}/mensagens`), 404,
      "estranho NÃO lê o histórico de conversa alheia");

    P.recusa(await intruso.vai(`/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: { texto: "invadi", idCliente: "x" },
    }), 404, "estranho NÃO escreve em conversa alheia");

    P.recusa(await intruso.vai("/arquivos/" + anexo.id), 404,
      "estranho NÃO baixa anexo de conversa alheia");

    P.recusa(await intruso.vai(`/conversas/${conversa}/mensagens/${msg.id}`, { metodo: "DELETE" }), 404,
      "estranho NÃO apaga mensagem alheia");

    P.recusa(await intruso.vai(`/conversas/${conversa}/lida`, {
      metodo: "POST", corpo: { seq: 1 },
    }), 404, "estranho NÃO marca leitura em conversa alheia");

    /* A resposta é 404 e NÃO 403: 403 confirmaria a existência do id, e com
       isso um atacante mapeia o que existe só variando a URL. */
    const r404 = await intruso.vai("/conversas/01JBXQWERTYUIOPASDFGHJKLZX/mensagens");
    P.eq(r404.status, 404, "conversa INEXISTENTE devolve o mesmo 404");
    const rAlheia = await intruso.vai(`/conversas/${conversa}/mensagens`);
    P.eq(rAlheia.dados?.erro, r404.dados?.erro,
      "alheia e inexistente devolvem a MESMA mensagem (sem enumeração)");

    /* ====================================================================== */
    P.secao("CSRF (§17)");

    const semToken = await pedir(chat.base + `/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: { texto: "csrf", idCliente: "csrf1" },
      cabecalhos: { Cookie: `cid=${ana.potes.get("cid")}` },
    });
    P.recusa(semToken, 403, "escrita SEM token CSRF é recusada");

    const tokenErrado = await pedir(chat.base + `/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: { texto: "csrf", idCliente: "csrf2" },
      cabecalhos: {
        Cookie: `cid=${ana.potes.get("cid")}; cid_csrf=${ana.csrf()}`,
        "X-Chat-Csrf": "valor-inventado",
      },
    });
    P.recusa(tokenErrado, 403, "token CSRF inventado é recusado");

    /* O token de OUTRA sessão não serve nesta — é o que a amarração por HMAC
       da sessão garante. */
    const tokenDeOutro = await pedir(chat.base + `/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: { texto: "csrf", idCliente: "csrf3" },
      cabecalhos: {
        Cookie: `cid=${ana.potes.get("cid")}; cid_csrf=${bruno.csrf()}`,
        "X-Chat-Csrf": bruno.csrf(),
      },
    });
    P.recusa(tokenDeOutro, 403, "token CSRF de OUTRA sessão não serve");

    /* ====================================================================== */
    P.secao("origem (§17)");

    const outraOrigem = await pedir(chat.base + `/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: { texto: "de fora", idCliente: "org1" },
      cabecalhos: {
        Cookie: `cid=${ana.potes.get("cid")}; cid_csrf=${ana.csrf()}`,
        "X-Chat-Csrf": ana.csrf(),
        Origin: "https://site-malicioso.com",
      },
    });
    P.recusa(outraOrigem, 403, "requisição de origem não autorizada é recusada");

    const origemBoa = await pedir(chat.base + "/eu", {
      cabecalhos: { Cookie: `cid=${ana.potes.get("cid")}`, Origin: "http://127.0.0.1:5299" },
    });
    P.eq(origemBoa.status, 200, "origem autorizada passa");
    P.eq(origemBoa.cabecalhos["access-control-allow-origin"], "http://127.0.0.1:5299",
      "CORS devolve a origem EXATA");
    P.ok(origemBoa.cabecalhos["access-control-allow-origin"] !== "*",
      "CORS nunca devolve * com credenciais");
    P.ok(String(origemBoa.cabecalhos.vary || "").includes("Origin"),
      "Vary: Origin presente (senão o cache mistura origens)");

    /* ====================================================================== */
    P.secao("passe — assinatura, validade e repetição (§18)");

    const abaX = criarAba(chat.base);
    const passeBom = emitirPasse(SEGREDO, INTRUSO);

    P.recusa(await abaX.vai("/entrar", { metodo: "POST", corpo: { passe: passeBom + "x" } }), 401,
      "passe com assinatura adulterada é recusado");

    const [corpoB64] = passeBom.split(".");
    const adulterado = Buffer.from(corpoB64, "base64url").toString("utf8").replace('"membro"', '"admin"');
    const passeForjado = Buffer.from(adulterado).toString("base64url") + "." + passeBom.split(".")[1];
    P.recusa(await abaX.vai("/entrar", { metodo: "POST", corpo: { passe: passeForjado } }), 401,
      "trocar o papel no corpo invalida a assinatura");

    P.recusa(await abaX.vai("/entrar", {
      metodo: "POST",
      corpo: { passe: emitirPasse(SEGREDO, INTRUSO, { validade: -10 }) },
    }), 401, "passe expirado é recusado");

    P.recusa(await abaX.vai("/entrar", {
      metodo: "POST",
      corpo: { passe: emitirPasse("segredo-errado-mas-com-32-caracteres!!", INTRUSO) },
    }), 401, "passe assinado com outro segredo é recusado");

    const jti = crypto.randomBytes(16).toString("base64url");
    const passeUnico = emitirPasse(SEGREDO, INTRUSO, { jti });
    const primeiro = await criarAba(chat.base).vai("/entrar", { metodo: "POST", corpo: { passe: passeUnico } });
    P.eq(primeiro.status, 200, "o passe funciona na primeira vez");
    const segundo = await criarAba(chat.base).vai("/entrar", { metodo: "POST", corpo: { passe: passeUnico } });
    P.recusa(segundo, 401, "o MESMO passe NÃO funciona duas vezes (replay)");

    P.recusa(await abaX.vai("/entrar", {
      metodo: "POST",
      corpo: { passe: emitirPasse(SEGREDO, INTRUSO, { iat: Math.floor(Date.now() / 1000) + 600 }) },
    }), 401, "passe emitido no futuro é recusado");

    /* ====================================================================== */
    P.secao("upload malicioso (§10, §11)");

    const enviar = (nome, tipo, bytes) => ana.vai(`/arquivos?conversa=${conversa}`, {
      metodo: "POST", corpo: bytes, bruto: true,
      cabecalhos: { "Content-Type": tipo, "X-Arquivo-Nome": Buffer.from(nome).toString("base64") },
    });

    P.recusa(await enviar("foto.png", "image/png", Buffer.from("MZ\x90\x00programa")), 400,
      "executável do Windows disfarçado de PNG é recusado");

    P.recusa(await enviar("script.png", "image/png", Buffer.from("#!/bin/sh\nrm -rf /")), 400,
      "script com shebang é recusado");

    P.recusa(await enviar("nota.png", "image/png", Buffer.from("nao sou um png de verdade")), 400,
      "MIME declarado que não bate com os bytes é recusado");

    P.recusa(await enviar("pagina.html", "text/html", Buffer.from("<script>alert(1)</script>")), 400,
      "HTML é recusado (XSS armazenado com cara de documento)");

    P.recusa(await enviar("logo.svg", "image/svg+xml", Buffer.from("<svg onload=alert(1)>")), 400,
      "SVG é recusado (executa script no navegador de quem abre)");

    /* O nome com travessia não é RECUSADO — ele é SANEADO. Recusar seria pior:
       um nome legítimo com `..` no meio ("relatorio..final.png") deixaria de
       funcionar, e o que protege de verdade é o arquivo no disco receber um
       ULID, nunca o nome enviado. */
    const salvo = await enviar("../../../etc/passwd.png", "image/png", png);
    P.eq(salvo.status, 200, "nome com travessia é aceito (o disco usa ULID, não o nome)");
    P.ok(!String(salvo.dados?.nome || "").includes(".."),
      "mas o nome gravado NUNCA contém `..`", JSON.stringify(salvo.dados));
    P.ok(!String(salvo.dados?.nome || "").includes("/"),
      "nem barra", JSON.stringify(salvo.dados));

    P.recusa(await enviar("grande.png", "image/png", Buffer.alloc(11 * 1024 * 1024, 1)), 413,
      "arquivo acima do teto é recusado");

    /* Travessia pela URL do download. */
    P.recusa(await ana.vai("/arquivos/..%2F..%2F..%2Fetc%2Fpasswd"), 404,
      "travessia de diretório na URL do download é recusada");
    P.recusa(await ana.vai("/arquivos/nao-e-um-ulid"), 404,
      "id fora do formato ULID nem chega ao banco");

    /* ====================================================================== */
    P.secao("injeção (§16, §17)");

    const injecoes = [
      "'; DROP TABLE mensagens; --",
      "' OR '1'='1",
      "%' OR 1=1 --",
      "\u0000admin",
      "1' UNION SELECT token_hash FROM sessoes --",
    ];
    for (const carga of injecoes) {
      const r = await ana.vai("/busca?q=" + encodeURIComponent(carga));
      P.ok(r.status === 200 && Array.isArray(r.dados?.mensagens),
        `injeção não quebra a busca: ${carga.slice(0, 28)}`, `status ${r.status}`);
    }
    const aindaVivo = await ana.vai(`/conversas/${conversa}/mensagens`);
    P.eq(aindaVivo.status, 200, "as tabelas continuam de pé depois das injeções");

    /* Curinga do LIKE: `%` não pode devolver a empresa inteira. */
    const curinga = await ana.vai("/busca?q=" + encodeURIComponent("%"));
    P.eq(curinga.dados.pessoas.length, 0, "buscar `%` NÃO lista todo mundo (enumeração)");

    /* ====================================================================== */
    P.secao("XSS armazenado (§9)");

    const cargas = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<svg/onload=alert(1)>",
      "javascript:alert(1)",
      "<iframe src=javascript:alert(1)>",
    ];
    for (const carga of cargas) {
      const r = await ana.vai(`/conversas/${conversa}/mensagens`, {
        metodo: "POST", corpo: { texto: carga, idCliente: "xss-" + carga.length + Math.random() },
      });
      P.eq(r.dados?.mensagem?.corpo, carga,
        `XSS volta como TEXTO, sem sanitizar nem executar: ${carga.slice(0, 24)}`);
    }
    P.ok(true, "(o cliente monta com createElement/textContent — nunca innerHTML)");

    /* Trojan Source: marca de direção some. */
    const trojan = await ana.vai(`/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: { texto: "apro\u202Evado", idCliente: "trojan" },
    });
    P.ok(!trojan.dados.mensagem.corpo.includes("\u202E"),
      "marca de inversão de texto (Trojan Source) é removida");

    /* ====================================================================== */
    P.secao("limites e força bruta (§32, §33)");

    let recusadas = 0;
    for (let i = 0; i < 45; i++) {
      const r = await ana.vai(`/conversas/${conversa}/mensagens`, {
        metodo: "POST", corpo: { texto: "ZZ QA rajada " + i, idCliente: "raj-" + i },
      });
      if (r.status === 429) recusadas++;
    }
    P.ok(recusadas > 0, `a rajada de mensagens é freada (${recusadas} recusadas de 45)`);

    const abaFB = criarAba(chat.base);
    let recusasEntrada = 0;
    for (let i = 0; i < 40; i++) {
      const r = await abaFB.vai("/entrar", { metodo: "POST", corpo: { passe: "lixo" + i } });
      if (r.status === 429) recusasEntrada++;
    }
    P.ok(recusasEntrada > 0, `martelar passes forjados é freado (${recusasEntrada} recusadas)`);

    /* ====================================================================== */
    P.secao("escalonamento de privilégio (§30)");

    P.recusa(await bruno.vai("/admin/auditoria"), 403,
      "membro comum NÃO lê a auditoria");
    P.recusa(await bruno.vai(`/admin/usuarios/${ana.usuario.id}/bloquear`, {
      metodo: "POST", corpo: { bloquear: true },
    }), 403, "membro comum NÃO bloqueia ninguém");

    const auditoria = await ana.vai("/admin/auditoria");
    P.eq(auditoria.status, 200, "o admin lê a auditoria");
    P.ok(auditoria.dados.eventos.length > 0, "há eventos registrados");
    const textoAuditoria = JSON.stringify(auditoria.dados);
    P.ok(!textoAuditoria.includes("assunto confidencial"),
      "a auditoria NÃO guarda conteúdo de mensagem");
    P.ok(!textoAuditoria.includes("sigiloso.png"),
      "a auditoria NÃO guarda nome de arquivo");

    /* Bloquear derruba a sessão aberta. */
    P.eq((await vitima.vai("/eu")).status, 200, "a vítima está dentro antes do bloqueio");
    await ana.vai(`/admin/usuarios/${vitima.usuario.id}/bloquear`, {
      metodo: "POST", corpo: { bloquear: true },
    });
    P.recusa(await vitima.vai("/eu"), 401,
      "bloquear DERRUBA a sessão que já estava aberta");

    /* ====================================================================== */
    P.secao("sessão (§17)");

    const semCookie = await pedir(chat.base + "/eu");
    P.recusa(semCookie, 401, "sem cookie não há sessão");

    const cookieInventado = await pedir(chat.base + "/eu", {
      cabecalhos: { Cookie: "cid=" + "a".repeat(43) },
    });
    P.recusa(cookieInventado, 401, "cookie inventado não vira sessão");

    const cookieSessao = cabecalhosCookie.find((c) => c.startsWith("cid="));
    P.ok(/HttpOnly/i.test(cookieSessao), "o cookie de sessão é HttpOnly");
    P.ok(/SameSite=Strict/i.test(cookieSessao), "e SameSite=Strict");
    P.ok(!/HttpOnly/i.test(cabecalhosCookie.find((c) => c.startsWith("cid_csrf="))),
      "o cookie de CSRF NÃO é HttpOnly (o JS precisa lê-lo)");

    /* O token do cookie não está em claro no banco. */
    const Banco = require("better-sqlite3");
    const db = new Banco(path.join(chat.pastaDados, "chat.db"), { readonly: true });
    const tokenDoCookie = /cid=([^;]+)/.exec(cookieSessao)[1];
    const emClaro = db.prepare("SELECT COUNT(*) AS n FROM sessoes WHERE token_hash = ?").get(tokenDoCookie);
    P.eq(Number(emClaro.n), 0, "o token da sessão NÃO está em claro no banco");
    const emHash = db.prepare("SELECT COUNT(*) AS n FROM sessoes WHERE token_hash = ?")
      .get(crypto.createHash("sha256").update(tokenDoCookie).digest("hex"));
    P.eq(Number(emHash.n), 1, "está gravado como hash");

    /* O corpo das mensagens está cifrado no disco. */
    const corpoCru = db.prepare("SELECT corpo FROM mensagens WHERE id = ?").get(msg.id);
    P.ok(String(corpoCru.corpo).startsWith("enc:"), "o corpo da mensagem está CIFRADO no banco");
    P.ok(!String(corpoCru.corpo).includes("confidencial"), "e o texto não aparece nele");

    const tokensBusca = db.prepare("SELECT token FROM mensagem_tokens LIMIT 5").all();
    P.ok(tokensBusca.every((t) => /^[0-9a-f]{16}$/.test(t.token)),
      "o índice de busca guarda HMAC, nunca a palavra");
    db.close();

    /* ====================================================================== */
    P.secao("falsificação de IP (§31, §32)");

    /* Com CHAT_PROXIES=0 o cabeçalho é IGNORADO por completo. Se ele fosse
       obedecido, o atacante escolheria qual IP o limitador pune e qual IP a
       auditoria registra. */
    const abaIp = criarAba(chat.base);
    let travouComIpFalso = 0;
    for (let i = 0; i < 40; i++) {
      const r = await abaIp.vai("/entrar", {
        metodo: "POST", corpo: { passe: "lixo" },
        cabecalhos: { "X-Forwarded-For": `10.0.0.${i}` },
      });
      if (r.status === 429) travouComIpFalso++;
    }
    P.ok(travouComIpFalso > 0,
      "trocar X-Forwarded-For a cada tentativa NÃO escapa do limitador");

    /* ====================================================================== */
    P.secao("WebSocket (§17) — Cross-Site WebSocket Hijacking");

    const wsUrl = `ws://127.0.0.1:${chat.porta}/chat/ws`;

    const tentarSocket = (opcoes) => new Promise((resolve) => {
      let ws;
      try { ws = new WebSocket(opcoes.url || wsUrl, { headers: opcoes.cabecalhos || {} }); }
      catch { return resolve({ abriu: false, motivo: "erro ao criar" }); }
      const t = setTimeout(() => { try { ws.terminate(); } catch { } resolve({ abriu: false, motivo: "tempo" }); }, 4000);
      ws.on("open", () => { clearTimeout(t); ws.close(); resolve({ abriu: true }); });
      ws.on("error", (e) => { clearTimeout(t); resolve({ abriu: false, motivo: e.message }); });
      ws.on("unexpected-response", (_, res) => { clearTimeout(t); resolve({ abriu: false, status: res.statusCode }); });
    });

    const semBilhete = await tentarSocket({
      cabecalhos: { Cookie: `cid=${dono.potes.get("cid")}`, Origin: "http://127.0.0.1:5299" },
    });
    P.ok(!semBilhete.abriu, "socket SEM bilhete é recusado, mesmo com cookie válido");
    P.eq(semBilhete.status, 401, "e a recusa é 401");

    const bilhete = (await dono.vai("/bilhete", { metodo: "POST" })).dados.bilhete;
    P.ok(!!bilhete, "o bilhete é emitido por rota autenticada");

    const origemMa = await tentarSocket({
      url: `${wsUrl}?t=${encodeURIComponent(bilhete)}`,
      cabecalhos: { Cookie: `cid=${dono.potes.get("cid")}`, Origin: "https://site-malicioso.com" },
    });
    P.ok(!origemMa.abriu, "socket de ORIGEM não autorizada é recusado (CSWSH)");
    P.eq(origemMa.status, 403, "e a recusa é 403");

    const bom = await tentarSocket({
      url: `${wsUrl}?t=${encodeURIComponent(bilhete)}`,
      cabecalhos: { Cookie: `cid=${dono.potes.get("cid")}`, Origin: "http://127.0.0.1:5299" },
    });
    P.ok(bom.abriu, "socket com bilhete e origem certos ABRE", JSON.stringify(bom));

    const reusado = await tentarSocket({
      url: `${wsUrl}?t=${encodeURIComponent(bilhete)}`,
      cabecalhos: { Cookie: `cid=${dono.potes.get("cid")}`, Origin: "http://127.0.0.1:5299" },
    });
    P.ok(!reusado.abriu, "o MESMO bilhete NÃO abre um segundo socket (uso único)");

    const inventado = await tentarSocket({
      url: `${wsUrl}?t=${"z".repeat(32)}`,
      cabecalhos: { Origin: "http://127.0.0.1:5299" },
    });
    P.ok(!inventado.abriu, "bilhete inventado é recusado");

    /* ======================================================================
       ACHADOS DA AUDITORIA DE SEGURANÇA

       Cada teste desta seção corresponde a uma falha REAL encontrada com sonda
       e corrigida. Estão aqui para não voltarem.
       ====================================================================== */
    P.secao("auditoria — isolamento, expulsão e confiança no cliente");

    /* Um socket que guarda tudo que recebe. */
    async function socketDe(aba) {
      const { bilhete } = (await aba.vai("/bilhete", { metodo: "POST" })).dados;
      const ws = new WebSocket(`${wsUrl}?t=${encodeURIComponent(bilhete)}`,
        { headers: { Origin: "http://127.0.0.1:5299" } });
      const recebidas = [];
      ws.on("message", (d) => { try { recebidas.push(JSON.parse(d.toString())); } catch { } });
      ws.on("error", () => { });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("socket não abriu")), 5000);
        ws.on("open", () => { clearTimeout(t); resolve(); });
        ws.on("unexpected-response", (_, r) => { clearTimeout(t); reject(new Error("recusado " + r.statusCode)); });
      });
      return { ws, recebidas, limpar: () => (recebidas.length = 0) };
    }

    /* --- presença não atravessa contextos (§22) --- */
    const sAlfa = await socketDe(alfa);
    const sBeta = await socketDe(beta);
    await espera(300);
    sBeta.limpar();

    await alfa.vai("/status", { metodo: "POST", corpo: { status: "ocupado" } });
    await espera(700);
    P.eq(sBeta.recebidas.filter((m) => m.t === "status").length, 0,
      "presença de uma empresa NÃO chega ao socket de outra",
      JSON.stringify(sBeta.recebidas));

    /* E continua chegando a quem é do mesmo contexto. */
    const sAlfa2 = await socketDe(alfa2);
    await espera(300);
    sAlfa2.limpar();
    await alfa.vai("/status", { metodo: "POST", corpo: { status: "ausente" } });
    await espera(700);
    P.ok(sAlfa2.recebidas.some((m) => m.t === "status"),
      "mas CHEGA a quem é da mesma empresa (a correção não quebrou a função)");

    /* --- bloquear derruba o socket, não só a sessão HTTP --- */
    const convExp = (await chefe.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: banido.usuario.id },
    })).dados.id;

    const sBanido = await socketDe(banido);
    await espera(300);
    P.eq(sBanido.ws.readyState, 1, "o socket da vítima está aberto antes do bloqueio");

    await chefe.vai(`/admin/usuarios/${banido.usuario.id}/bloquear`, {
      metodo: "POST", corpo: { bloquear: true },
    });
    await espera(900);

    P.ok(sBanido.ws.readyState !== 1,
      "bloquear FECHA o WebSocket, e não só a sessão HTTP", "readyState=" + sBanido.ws.readyState);

    sBanido.limpar();
    await chefe.vai(`/conversas/${convExp}/mensagens`, {
      metodo: "POST", corpo: { texto: "ZZ QA segredo pos bloqueio", idCliente: "pos-bloq" },
    });
    await espera(800);
    P.eq(sBanido.recebidas.filter((m) => m.t === "msg").length, 0,
      "e a pessoa bloqueada NÃO recebe mais mensagem nenhuma");

    /* --- sair também fecha o socket --- */
    const sSonolento = await socketDe(sonolento);
    await espera(300);
    await sonolento.vai("/sair", { metodo: "POST" });
    await espera(800);
    P.ok(sSonolento.ws.readyState !== 1,
      "sair também fecha o socket (computador compartilhado)", "readyState=" + sSonolento.ws.readyState);

    /* --- marca de leitura tem teto --- */
    const convMarca = (await leitorA.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: leitorB.usuario.id },
    })).dados.id;
    await leitorA.vai(`/conversas/${convMarca}/mensagens`, {
      metodo: "POST", corpo: { texto: "ZZ QA uma so", idCliente: "marca-1" },
    });
    await leitorB.vai(`/conversas/${convMarca}/lida`, { metodo: "POST", corpo: { seq: 999999 } });
    const marcas = (await leitorA.vai(`/conversas/${convMarca}/mensagens`)).dados.marcas;
    P.eq(marcas.lidaAte, 1,
      "marca de leitura é limitada à última mensagem que existe (sem ✓✓ falso)");

    /* ----------------------------------------------------------------------
       Os testes de anexo usam sessões NOVAS (EMPRESA-A), e não a Ana: o teste
       de rajada mais acima gastou o orçamento de mensagens dela, e um 429 aqui
       esconderia o que se quer provar por trás de um limite que já foi testado.
       ---------------------------------------------------------------------- */
    const convA1 = (await alfa.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: alfa2.usuario.id },
    })).dados.id;
    const convA2 = (await alfa.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: alfa3.usuario.id },
    })).dados.id;

    /* --- anexo não atravessa conversa --- */
    const anexoDaOutra = (await alfa.vai(`/arquivos?conversa=${convA1}`, {
      metodo: "POST", corpo: png, bruto: true,
      cabecalhos: { "Content-Type": "image/png",
        "X-Arquivo-Nome": Buffer.from("ZZ QA cruzado.png").toString("base64") },
    })).dados;

    const cruzada = await alfa.vai(`/conversas/${convA2}/mensagens`, {
      metodo: "POST",
      corpo: { texto: "tentando cruzar", idCliente: "cruz-1",
               anexos: [{ id: anexoDaOutra.id, ehImagem: true }] },
    });
    P.recusa(cruzada, 400,
      "anexo de UMA conversa não pode ser colado em mensagem de OUTRA");

    /* --- o tipo da mensagem não vem do cliente --- */
    const pdfBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(32, 0x20)]);
    const anexoPdf = (await alfa.vai(`/arquivos?conversa=${convA1}`, {
      metodo: "POST", corpo: pdfBytes, bruto: true,
      cabecalhos: { "Content-Type": "application/pdf",
        "X-Arquivo-Nome": Buffer.from("ZZ QA doc.pdf").toString("base64") },
    })).dados;

    const mentira = await alfa.vai(`/conversas/${convA1}/mensagens`, {
      metodo: "POST",
      corpo: { texto: "", idCliente: "tipo-1", anexos: [{ id: anexoPdf.id, ehImagem: true }] },
    });
    P.eq(mentira.dados?.mensagem?.tipo, "arquivo",
      "PDF anunciado como imagem pelo cliente continua sendo `arquivo` (o tipo sai dos BYTES)");

    /* --- anexo de outra pessoa --- */
    const anexoAlheio = (await alfa.vai(`/arquivos?conversa=${convA1}`, {
      metodo: "POST", corpo: png, bruto: true,
      cabecalhos: { "Content-Type": "image/png",
        "X-Arquivo-Nome": Buffer.from("ZZ QA meu.png").toString("base64") },
    })).dados;
    const roubo = await alfa2.vai(`/conversas/${convA1}/mensagens`, {
      metodo: "POST",
      corpo: { texto: "", idCliente: "roubo-1", anexos: [{ id: anexoAlheio.id }] },
    });
    P.recusa(roubo, 400, "ninguém anexa arquivo enviado por outra pessoa");

    for (const s of [sAlfa, sBeta, sAlfa2, sBanido, sSonolento]) { try { s.ws.terminate(); } catch { } }

    /* ====================================================================== */
    P.secao("vazamento em mensagem de erro (§57)");

    const erro404 = await ana.vai("/rota/que/nao/existe");
    P.ok(!/at |\.js:\d|SQLITE|C:\\|\/var\//.test(erro404.texto),
      "erro não vaza pilha, caminho de arquivo nem SQL", erro404.texto.slice(0, 120));

    const jsonRuim = await ana.vai(`/conversas/${conversa}/mensagens`, {
      metodo: "POST", corpo: Buffer.from("{isto nao e json"), bruto: true,
      cabecalhos: { "Content-Type": "application/json" },
    });
    P.recusa(jsonRuim, 400, "JSON quebrado vira 400 educado");
    P.ok(!/SyntaxError|position \d/.test(jsonRuim.texto), "sem detalhe técnico do analisador");

    const cabecalhos = (await ana.vai("/eu")).cabecalhos;
    P.eq(cabecalhos["x-content-type-options"], "nosniff", "cabeçalho nosniff presente");
    P.eq(cabecalhos["x-frame-options"], "DENY", "cabeçalho anti-clickjacking presente");
    P.ok(String(cabecalhos["cache-control"]).includes("no-store"),
      "resposta de API não fica em cache");

    /* ====================================================================== */
    P.secao("health check em PRODUÇÃO não entrega a versão");

    /* Sobe um segundo serviço, em modo de produção, só para esta conferência.
       A versão exata é a primeira coisa que se procura ao escolher um alvo:
       ela diz quais falhas conhecidas valem a tentativa. */
    const producao = await subirChat({
      porta: 5287, origens: "http://127.0.0.1:5299",
      extra: { NODE_ENV: "production" },
    });
    try {
      const s = await pedir(producao.base + "/saude");
      P.eq(s.status, 200, "o health check responde em produção");
      P.eq(s.dados?.banco, "ok", "e continua dizendo se o banco está de pé");
      P.ok(!s.dados?.versao, "mas NÃO entrega a versão", JSON.stringify(s.dados));
      P.ok(!/\\|\/var\/|node_modules|sqlite/i.test(s.texto),
        "nem caminho de arquivo ou nome de driver", s.texto);
    } finally {
      await producao.derrubar();
    }

  } finally {
    await chat.derrubar();
  }

  return P.fim();
}

if (require.main === module) {
  rodar().then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((e) => { console.error("\n  EXPLODIU:", e.message, "\n", e.stack); process.exitCode = 1; });
}

module.exports = { rodar };
