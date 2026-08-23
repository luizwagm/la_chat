/* ==========================================================================
   testes/unidade.cjs — as regras puras, sem banco e sem servidor

       node testes/unidade.cjs

   Roda em menos de um segundo porque não sobe nada. É a suíte que se roda a
   cada gravação de arquivo; as outras são para antes de subir.

   Só entra aqui o que NÃO depende de infraestrutura. Se um teste precisar de
   banco, ele pertence à suíte de integração — misturar os dois faz a suíte
   rápida deixar de ser rápida, e aí ninguém a roda.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");
const { criarPlacar } = require("./ajuda.cjs");

const texto = require("../src/dominio/texto.js");
const arquivos = require("../src/dominio/arquivos.js");
const { ulid, ehUlid, tempoDoUlid } = require("../src/dominio/ids.js");
const { criarIndice, normalizar } = require("../src/infra/seguranca/indice-cego.js");
const { criarLimites } = require("../src/infra/seguranca/limites.js");
const { criarPorteiro, normalizar: normOrigem } = require("../src/infra/seguranca/origem.js");
const { criarPasses } = require("../src/infra/seguranca/passe.js");
const { ipDe, valido } = require("../src/infra/seguranca/ip.js");
const { paraPostgres } = require("../src/infra/dados/banco.js");
const cripto = require("../src/infra/seguranca/cripto.js");

/* `async` porque a suíte passou a conferir coisas que só se sabem lendo o
   disco — o anexo cifrado, por exemplo. Ela continua não subindo servidor
   nenhum: assíncrono aqui é I/O local, não rede. */
async function rodar() {
  const P = criarPlacar("Unidade");

  /* ====================================================================== */
  P.secao("texto: limpeza e validação (§9)");

  P.ok(!texto.validarMensagem("").ok, "mensagem vazia é recusada");
  P.ok(!texto.validarMensagem("   \n\n ").ok, "só espaço é recusado");
  P.ok(!texto.validarMensagem("x".repeat(5000), { tamanhoMaximo: 4000 }).ok, "acima do teto é recusada");
  P.ok(texto.validarMensagem("oi").ok, "mensagem normal passa");

  const sujo = texto.limpar("apro\u202Evado\u200B\u0007ok");
  P.ok(!/[\u202E\u200B\u0007]/.test(sujo), "some inversão de texto, invisível e controle", JSON.stringify(sujo));
  P.eq(texto.limpar("a\r\nb"), "a\nb", "quebra de linha do Windows é normalizada");

  const muitas = texto.validarMensagem("a" + "\n".repeat(30) + "b");
  P.ok(!muitas.texto.includes("\n\n\n"), "rajada de quebras é colapsada");

  /* ====================================================================== */
  P.secao("texto: marcação");

  const arv = texto.analisar("<img src=x onerror=alert(1)>");
  P.eq(arv[0].partes[0].valor, "<img src=x onerror=alert(1)>", "HTML fica como TEXTO");

  const p = texto.analisarLinha("veja **isto** e `cod` e *ita* e ~~ris~~ e _sub_");
  for (const [tipo, valor] of [["negrito", "isto"], ["codigo", "cod"], ["italico", "ita"],
                                ["riscado", "ris"], ["sublinhado", "sub"]])
    P.ok(p.some((x) => x.tipo === tipo && x.valor === valor), `marcação: ${tipo}`);

  const c = texto.analisarLinha("`**nao vira negrito**`");
  P.ok(c.length === 1 && c[0].tipo === "codigo", "dentro de código nada é interpretado");

  const lista = texto.analisar("- um\n- dois\n- tres");
  P.ok(lista[0].tipo === "lista" && lista[0].itens.length === 3, "lista com 3 itens");
  const ord = texto.analisar("1. um\n2. dois");
  P.ok(ord[0].ordenada === true, "lista numerada é reconhecida");

  const bloco = texto.analisar("```\nlinha1\nlinha2\n```");
  P.ok(bloco[0].tipo === "codigo" && bloco[0].valor === "linha1\nlinha2", "bloco de código");

  const cit = texto.analisar("> citado");
  P.eq(cit[0].tipo, "citacao", "citação");

  const link = texto.analisarLinha("olha https://x.com/a aqui");
  P.ok(link.some((x) => x.tipo === "link" && x.href === "https://x.com/a"), "link automático");

  P.eq(texto.paraTextoPuro("**oi** `x`\n- a\n- b"), "oi x a b", "texto puro para notificação");

  /* ====================================================================== */
  P.secao("texto: URL segura");

  for (const ruim of ["javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>",
                       "vbscript:msgbox", "file:///etc/passwd", "//evil.com"])
    P.eq(texto.urlSegura(ruim), "", `URL recusada: ${ruim.slice(0, 24)}`);

  P.eq(texto.urlSegura("https://a.com/x?y=1"), "https://a.com/x?y=1", "https é aceito");
  P.eq(texto.urlSegura("http://a.com"), "http://a.com", "http é aceito");
  P.eq(texto.urlSegura("https://a.com/" + "x".repeat(3000)), "", "URL absurdamente longa é recusada");

  /* ====================================================================== */
  P.secao("arquivos: conferência de conteúdo (§10)");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const permitidos = ["image/png", "image/jpeg", "application/pdf", "text/plain"];
  const base = { tiposPermitidos: permitidos, tamanhoMaximo: 10 * 1024 * 1024 };

  P.ok(arquivos.conferir({ nome: "a.png", tipoDeclarado: "image/png", buffer: png, tamanho: png.length, ...base }).ok,
    "PNG legítimo passa");

  P.ok(!arquivos.conferir({ nome: "a.png", tipoDeclarado: "image/png",
    buffer: Buffer.from("MZ\x90\x00"), tamanho: 4, ...base }).ok, "executável MZ disfarçado é recusado");

  P.ok(!arquivos.conferir({ nome: "a.png", tipoDeclarado: "image/png",
    buffer: Buffer.from("\x7FELF"), tamanho: 4, ...base }).ok, "binário ELF é recusado");

  P.ok(!arquivos.conferir({ nome: "a.png", tipoDeclarado: "image/png",
    buffer: Buffer.from("#!/bin/sh"), tamanho: 9, ...base }).ok, "script com shebang é recusado");

  P.ok(!arquivos.conferir({ nome: "a.php", tipoDeclarado: "text/plain",
    buffer: Buffer.from("texto"), tamanho: 5, ...base }).ok, "extensão .php é recusada");

  P.ok(!arquivos.conferir({ nome: "foto.php.jpg", tipoDeclarado: "image/jpeg",
    buffer: png, tamanho: png.length, ...base }).ok, "extensão perigosa NO MEIO é recusada");

  P.ok(!arquivos.conferir({ nome: "a.png", tipoDeclarado: "image/png",
    buffer: Buffer.from("%PDF-1.4"), tamanho: 8, ...base }).ok, "PDF declarado como PNG é recusado");

  P.ok(!arquivos.conferir({ nome: "a.exe", tipoDeclarado: "application/x-msdownload",
    buffer: png, tamanho: png.length, ...base }).ok, "tipo fora da lista branca é recusado");

  P.ok(!arquivos.conferir({ nome: "a.png", tipoDeclarado: "image/png",
    buffer: png, tamanho: 20 * 1024 * 1024, ...base }).ok, "acima do teto é recusado");

  P.eq(arquivos.nomeSeguro("../../../etc/passwd"), "passwd", "travessia some do nome");
  P.eq(arquivos.nomeSeguro("C:\\Windows\\system32\\a.txt"), "a.txt", "caminho do Windows some");
  /* A quebra de linha some, e o `:` vira `_` de quebra (ele é inválido em nome
     de arquivo no Windows). Os dois juntos fecham a injeção de cabeçalho no
     `Content-Disposition` do download. */
  const semQuebra = arquivos.nomeSeguro("nota\r\nX-Injetado: 1.txt");
  P.ok(!/[\r\n:]/.test(semQuebra), "quebra de linha e `:` somem (injeção de cabeçalho)", semQuebra);
  P.eq(arquivos.nomeSeguro(".oculto"), "oculto", "ponto inicial some");
  P.ok(arquivos.nomeSeguro("x".repeat(300) + ".pdf").endsWith(".pdf"),
    "nome longo é cortado preservando a extensão");

  /* ====================================================================== */
  P.secao("ULID (§21)");

  const ids = Array.from({ length: 500 }, () => ulid());
  P.eq(new Set(ids).size, 500, "500 ids seguidos são todos diferentes");
  P.ok(ids.every(ehUlid), "todos têm o formato de ULID");

  const ordenados = [...ids].sort();
  P.ok(ids.every((v, i) => v === ordenados[i]),
    "ids gerados em sequência JÁ saem em ordem crescente (monotônicos)");

  P.ok(!ehUlid("nao-e-ulid"), "texto qualquer não passa por ULID");
  P.ok(!ehUlid("01JBXQWERTYUIOPASDFGHJKLZ"), "25 caracteres não passa");
  P.ok(!ehUlid("01JBXQWERTYUIOPASDFGHJKLZXI"), "letra fora do alfabeto (I) não passa");
  P.ok(Math.abs(tempoDoUlid(ulid()) - Date.now()) < 2000, "o tempo dentro do id confere");

  /* ====================================================================== */
  P.secao("índice cego (§16, §20)");

  P.eq(normalizar("Orçamento AÇÃO!"), "orcamento acao", "acento e pontuação normalizados");

  const ix = criarIndice("x".repeat(32));
  const grava = ix.tokensDe("Orçamento aprovado");
  const busca = ix.tokensDaBusca("orcamento");
  P.ok(grava.includes(busca[0]), "gravar e buscar geram o MESMO token");
  P.ok(grava.every((t) => /^[0-9a-f]{16}$/.test(t)), "os tokens são HMAC de 8 bytes");
  P.ok(!grava.some((t) => t.includes("orcamento")), "a palavra NÃO aparece no token");

  const outro = criarIndice("y".repeat(32));
  P.ok(outro.tokensDe("Orçamento")[0] !== grava[0],
    "outra chave gera outro token (tabela pré-calculada não serve)");

  P.ok(ix.confirmar("Orçamento aprovado hoje", "orcamento aprovado"), "confirmação: as duas palavras");
  P.ok(!ix.confirmar("Orçamento aprovado", "orcamento negado"), "confirmação: palavra ausente reprova");
  P.eq(ix.tokensDe("de o a que com").length, 0, "palavras vazias não geram token");
  P.ok(ix.tokensDe(Array.from({ length: 400 }, (_, i) => "palavra" + i).join(" ")).length <= 120,
    "o teto de tokens por mensagem é respeitado");

  /* ====================================================================== */
  P.secao("cifragem (§19, §20)");

  process.env.CHAT_DADOS_CHAVE = crypto.randomBytes(32).toString("base64");
  const claro = "assunto confidencial da empresa";
  const c1 = cripto.cifrar(claro);
  const c2 = cripto.cifrar(claro);
  P.ok(c1.startsWith("enc:1:"), "o formato tem prefixo e versão de chave");
  P.ok(c1 !== c2, "o MESMO texto gera cifrados diferentes (IV aleatório)");
  P.eq(cripto.decifrar(c1), claro, "decifra de volta");
  P.eq(cripto.decifrar(cripto.cifrar(c1)), claro, "cifrar duas vezes é idempotente");
  P.eq(cripto.cifrar(""), "", "vazio continua vazio");
  P.eq(cripto.decifrar("texto em claro antigo"), "texto em claro antigo",
    "valor não cifrado passa (compatível com migração)");

  const adulterado = c1.slice(0, -6) + "AAAAAA";
  P.eq(cripto.decifrar(adulterado), "[protegido]",
    "adulterar o cifrado é DETECTADO (GCM autentica), não devolve lixo");

  /* ====================================================================== */
  P.secao("limites (§32)");

  const lim = criarLimites();
  let passou = 0;
  for (let i = 0; i < 10; i++) if (lim.conferir("a", { maximo: 5, janelaMs: 60e3 }).ok) passou++;
  P.eq(passou, 5, "o balde solta exatamente 5 de 10");
  const bloqueado = lim.conferir("a", { maximo: 5, janelaMs: 60e3 });
  P.ok(bloqueado.esperar > 0, "e diz quantos segundos faltam");
  P.ok(lim.conferir("b", { maximo: 5, janelaMs: 60e3 }).ok, "outra chave tem balde próprio");
  P.ok(lim.espiar("a", { maximo: 5, janelaMs: 60e3 }).usado === 5, "espiar não consome vaga");
  lim.encerrar();

  /* ====================================================================== */
  P.secao("origem (§17)");

  P.eq(normOrigem("https://X.com/"), "https://x.com", "origem é normalizada");
  P.eq(normOrigem("https://x.com:443"), "https://x.com", "porta padrão é removida");
  P.eq(normOrigem("http://x.com:8080"), "http://x.com:8080", "porta não padrão é mantida");

  const porteiro = criarPorteiro(["https://cliente.com"]);
  P.ok(porteiro.aceitaWebSocket({ headers: { origin: "https://cliente.com" } }).ok, "origem da lista passa");
  P.ok(!porteiro.aceitaWebSocket({ headers: { origin: "https://malicioso.com" } }).ok, "outra origem é recusada");
  P.ok(!porteiro.aceitaWebSocket({ headers: {} }).ok, "WebSocket SEM Origin é recusado");
  P.ok(!porteiro.aceitaWebSocket({ headers: { origin: "https://cliente.com.malicioso.com" } }).ok,
    "domínio que só COMEÇA igual é recusado");

  const cors = porteiro.cabecalhosCors({ headers: { origin: "https://cliente.com" } });
  P.eq(cors["Access-Control-Allow-Origin"], "https://cliente.com", "CORS devolve a origem exata");
  P.eq(cors.Vary, "Origin", "com Vary: Origin");
  P.eq(Object.keys(porteiro.cabecalhosCors({ headers: { origin: "https://outro.com" } })).length, 0,
    "origem não autorizada não recebe cabeçalho de CORS");

  /* ====================================================================== */
  P.secao("passe (§18)");

  const segredo = crypto.randomBytes(32).toString("base64");
  const passes = criarPasses({ segredo, validadeSegundos: 60 });
  const emitido = passes.emitir({ id: "u1", nome: "Ana", papel: "admin" }, { contexto: "empresa" });
  const conf = passes.conferir(emitido);
  P.ok(conf.ok, "passe legítimo é aceito");
  P.eq(conf.usuario.id, "u1", "traz o id");
  P.eq(conf.usuario.papel, "admin", "traz o papel");
  P.eq(conf.contexto, "empresa", "traz o contexto");

  P.ok(!passes.conferir(emitido + "x").ok, "assinatura adulterada é recusada");
  P.ok(!passes.conferir("").ok, "passe vazio é recusado");
  P.ok(!passes.conferir("sem-ponto").ok, "passe malformado é recusado");
  P.ok(!passes.conferir("x".repeat(5000)).ok, "passe gigante é recusado antes de qualquer trabalho");

  const outroSegredo = criarPasses({ segredo: crypto.randomBytes(32).toString("base64") });
  P.ok(!passes.conferir(outroSegredo.emitir({ id: "u1", nome: "Ana" })).ok,
    "passe de outro segredo é recusado");

  const vencido = criarPasses({ segredo, validadeSegundos: -10 });
  P.ok(!passes.conferir(vencido.emitir({ id: "u1", nome: "Ana" })).ok, "passe expirado é recusado");

  const semPapel = passes.conferir(passes.emitir({ id: "u2", nome: "B", papel: "superadmin" }));
  P.eq(semPapel.usuario.papel, "membro", "papel inventado vira `membro` (sem escalonamento)");

  /* ====================================================================== */
  P.secao("IP atrás de proxy (§31)");

  const req = (xff, socket = "10.0.0.9") => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: socket } });

  P.eq(ipDe(req("1.2.3.4"), 0), "10.0.0.9", "sem proxy declarado, o cabeçalho é IGNORADO");
  P.eq(ipDe(req("1.2.3.4, 200.1.1.1"), 1), "200.1.1.1", "com 1 proxy, pega o ÚLTIMO (o que o nginx escreveu)");
  P.eq(ipDe(req("1.2.3.4, 200.1.1.1, 172.16.0.1"), 2), "200.1.1.1", "com 2 proxies, descarta 2 do fim");
  P.eq(ipDe(req("1.2.3.4"), 2), "10.0.0.9", "lista mais curta que o esperado cai no socket");
  P.eq(ipDe(req("lixo-invalido"), 1), "10.0.0.9", "valor que não é IP cai no socket");
  P.eq(ipDe(req(null, "::ffff:192.168.0.7"), 0), "192.168.0.7", "IPv4 mapeado em IPv6 é normalizado");
  P.ok(!valido("a".repeat(200)), "texto gigante não passa por IP");

  /* ======================================================================
     O CLIENTE CHAMA SÓ O QUE EXISTE

     Este bloco nasceu de um defeito real: `acrescentarMensagem` era chamado em
     dois lugares e NUNCA foi definido. O resultado era `TypeError` dentro do
     `onmessage` do WebSocket — engolido, sem erro na tela. O sintoma era "a
     mensagem só aparece quando eu fecho e abro a conversa", porque aí ela vinha
     pelo histórico, que funcionava.

     Não há como testar a tela sem navegador, mas dá para testar ISTO: varrer o
     arquivo do cliente e conferir que todo `this.metodo(` chamado corresponde a
     um método declarado. É barato, roda em milissegundos, e pega a classe
     inteira de erro — que é a mais cara justamente por ser silenciosa.
     ====================================================================== */
  P.secao("cliente: método chamado tem de existir");

  {
    const fs = require("node:fs");
    const path = require("node:path");
    const fonte = fs.readFileSync(path.join(__dirname, "..", "publico", "la-chat.js"), "utf8");

    /* Os métodos declarados na classe: `nome(` ou `async nome(` com a
       indentação de membro de classe. */
    const declarados = new Set();
    for (const m of fonte.matchAll(/^\s{4}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/gm))
      declarados.add(m[1]);

    /* Propriedades de instância que também são chamadas como função. */
    for (const m of fonte.matchAll(/this\.([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g))
      declarados.add(m[1]);

    const chamados = new Set();
    for (const m of fonte.matchAll(/this\.([a-zA-Z_$][\w$]*)\s*\(/g)) chamados.add(m[1]);

    /* O que vem do HTMLElement e do DOM — herdado, não declarado aqui. */
    const HERDADOS = new Set([
      "attachShadow", "setAttribute", "getAttribute", "removeAttribute", "hasAttribute",
      "addEventListener", "removeEventListener", "dispatchEvent", "append", "appendChild",
      "querySelector", "querySelectorAll", "focus", "blur", "remove", "closest", "contains",
      "getBoundingClientRect", "replaceWith", "insertBefore", "cloneNode",
    ]);

    const faltando = [...chamados].filter((n) => !declarados.has(n) && !HERDADOS.has(n));

    P.ok(faltando.length === 0,
      "todo `this.metodo()` do cliente está declarado",
      faltando.length ? "NÃO EXISTEM: " + faltando.join(", ") : "");

    /* O mesmo para os elementos guardados em `this.el` — um `this.el.corpo`
       que nunca foi preenchido dá `Cannot read properties of undefined`. */
    const elDefinidos = new Set();
    const bloco = /this\.el\s*=\s*\{([\s\S]*?)\};/.exec(fonte);
    if (bloco) {
      for (const m of bloco[1].matchAll(/([a-zA-Z_$][\w$]*)\s*[,:}]/g)) elDefinidos.add(m[1]);
    }
    for (const m of fonte.matchAll(/this\.el\.([a-zA-Z_$][\w$]*)\s*=/g)) elDefinidos.add(m[1]);

    const elUsados = new Set();
    for (const m of fonte.matchAll(/this\.el\.([a-zA-Z_$][\w$]*)/g)) elUsados.add(m[1]);

    const elFaltando = [...elUsados].filter((n) => !elDefinidos.has(n));
    P.ok(elFaltando.length === 0,
      "todo `this.el.x` usado foi preenchido",
      elFaltando.length ? "NÃO EXISTEM: " + elFaltando.join(", ") : "");
  }

  /* ======================================================================
     `hidden` CONTRA `display` — a trava para a tela preta não voltar

     O navegador aplica a regra `[hidden] { display: none }` na folha de estilo
     DELE, que tem a MENOR prioridade de todas. Qualquer regra nossa que declare
     `display` para o mesmo elemento passa por cima, e o que deveria estar
     escondido aparece.

     Aconteceu: abrir o chat mostrava uma TELA PRETA — era o painel da reunião,
     escondido pelo atributo e visível pelo CSS, cobrindo tudo. Nada quebrava,
     nada aparecia no console; só a tela preta.

     ---------------------------------------------------------------------
     A PRIMEIRA VERSÃO DESTE TESTE ERA VAZIA

     Ela procurava a regra de correção no arquivo INTEIRO — e o comentário que
     explica a correção também contém o texto dela. Removendo a regra de
     verdade, o teste continuava passando por causa do próprio comentário.

     Por isso agora ele olha SÓ o conteúdo dos blocos de CSS, com os comentários
     removidos, e exige algo com forma de seletor. Um teste que não falha
     quando o defeito volta é pior que teste nenhum.
     ====================================================================== */
  P.secao("cliente: `hidden` precisa vencer o `display`");

  {
    const fs = require("node:fs");
    const path = require("node:path");
    const publico = path.join(__dirname, "..", "publico");

    const arquivos = ["la-chat.js", "la-chat-video.js"]
      .map((f) => { try { return fs.readFileSync(path.join(publico, f), "utf8"); } catch { return ""; } });
    const fonte = arquivos.join("\n");

    /* Só o CSS: o conteúdo dos templates `const CSS… = ` … ` `, sem comentários. */
    const css = [...fonte.matchAll(/const\s+CSS\w*\s*=\s*`([\s\S]*?)`;/g)]
      .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, ""))
      .join("\n");

    P.ok(css.length > 1000, "achei o CSS do cliente", `${css.length} caracteres`);

    /* Classes que nascem escondidas, e as que são escondidas depois. */
    const comHidden = new Set();
    for (const m of fonte.matchAll(/classe:\s*"([\w-]+)"[^}]{0,220}?hidden:/g)) comHidden.add(m[1]);
    for (const m of fonte.matchAll(/querySelector\("\.([\w-]+)"\)[^;\n]{0,60}\.hidden\s*=/g))
      comHidden.add(m[1]);

    P.ok(comHidden.size > 0, "achei classes que usam o atributo `hidden`",
      [...comHidden].join(", "));

    const conferir = (textoCss) => {
      const faltando = [];
      for (const classe of comHidden) {
        const regra = new RegExp("\\." + classe + "\\s*\\{([^}]*)\\}").exec(textoCss);
        if (!regra) continue;
        /* Só importa quando a própria regra declara `display` — aí ela vence o
           `[hidden]` do navegador. Sem `display`, o atributo funciona sozinho. */
        if (!/(^|;)\s*display\s*:/.test(regra[1])) continue;
        /* E o remendo precisa ter FORMA DE SELETOR: `.classe[hidden]` seguido,
           talvez depois de outros seletores, de uma chave. */
        const remendo = new RegExp("\\." + classe + "\\[hidden\\][^{}]*\\{");
        if (!remendo.test(textoCss)) faltando.push(classe);
      }
      return faltando;
    };

    P.ok(conferir(css).length === 0,
      "toda classe com `display` que usa `hidden` tem a regra `[hidden]`",
      conferir(css).join(", "));

    /* A PROVA DE QUE O TESTE NÃO É VAZIO: tirando a regra, ele tem de acusar.
       Sem isto, a versão anterior passou meses parecendo proteger algo. */
    const sabotado = css.replace(/\.chamada\[hidden\][^{}]*\{[^}]*\}/, "");
    P.ok(conferir(sabotado).includes("chamada"),
      "e a trava ACUSA quando a regra é removida (o teste não é vazio)",
      "removi a regra e o teste continuou passando");
  }

  /* ======================================================================
     A REUNIÃO EM JANELA PRÓPRIA — a trava é sobre a ORDEM

     Mudar a reunião de janela é seguro por um motivo só: nada é desfeito
     antes de a janela existir. Se `requestWindow` for recusada — bloqueador,
     política do sistema, falta de gesto do usuário — a reunião tem de
     continuar inteira onde estava.

     Inverter essa ordem seria fácil e o defeito seria raro e caríssimo: o
     anfitrião perderia, no meio de uma reunião com gente dentro, a reunião
     que ele estava conduzindo. Este teste existe para essa inversão não
     passar despercebida numa revisão.
     ====================================================================== */
  P.secao("cliente: a janela da reunião não pode desmontar antes da hora");

  {
    const fs = require("node:fs");
    const path = require("node:path");
    const fonte = fs.readFileSync(
      path.join(__dirname, "..", "publico", "la-chat-video.js"), "utf8");

    /* O corpo da função que abre a janela, sem comentários — comentário que
       cita `desmontarChamada` não pode reprovar nem aprovar nada. */
    const corpoDe = (nome, texto) => {
      const i = texto.indexOf("LaChat.prototype." + nome + " = ");
      if (i < 0) return "";
      const fim = texto.indexOf("\n  };", i);
      return texto.slice(i, fim < 0 ? texto.length : fim)
        .replace(/\/\*[\s\S]*?\*\//g, "");
    };

    const abrir = corpoDe("abrirReuniaoEmJanela", fonte);
    P.ok(abrir.length > 200, "achei a função que abre a janela", abrir.length + " caracteres");

    /* A recusa acontece no `catch` do `await requestWindow`. Dali até o fim
       do bloco não pode haver desmontagem. */
    const conferirOrdem = (texto) => {
      const iPede = texto.indexOf("requestWindow");
      const iMove = texto.indexOf("raiz.appendChild(this.el.chamada)");
      const desmonta = /desmontarChamada|sairDaChamada|malha\s*\.\s*encerrar/.test(texto);
      return {
        pedeAntesDeMover: iPede >= 0 && iMove > iPede,
        naoDesmonta: !desmonta,
      };
    };

    const r = conferirOrdem(abrir);
    P.ok(r.pedeAntesDeMover,
      "a janela é PEDIDA antes de o painel ser movido");
    P.ok(r.naoDesmonta,
      "e abrir a janela nunca desmonta a chamada — recusa deixa tudo no lugar");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = abrir.replace("v.janela = janela;", "this.desmontarChamada();");
    P.ok(!conferirOrdem(sabotado).naoDesmonta,
      "e a trava ACUSA quando alguém põe uma desmontagem aí dentro",
      "sabotei a função e o teste continuou passando");

    /* O caminho de volta é UM só: fechar pelo X da janela e fechar pelo botão
       têm de terminar no mesmo lugar, ou os dois divergem com o tempo. */
    P.ok(/pagehide[\s\S]{0,120}recolherReuniao/.test(fonte),
      "fechar a janela devolve a reunião para a aba (pagehide → recolher)");
    P.ok(/fecharJanelaDaReuniao = function[\s\S]{0,300}j\.close\(\)/.test(fonte),
      "e o botão de voltar passa pelo MESMO caminho, fechando a janela");

    /* Acabar a reunião não pode deixar uma janela flutuante órfã. */
    const desmontar = corpoDe("desmontarChamada", fonte);
    P.ok(/j\.close\(\)/.test(desmontar),
      "o fim da reunião fecha a janela — não sobra janela com reunião morta");

    /* O botão só existe onde a API existe. Um botão que aparece e não funciona
       é pior que botão nenhum. */
    P.ok(/const TEM_JANELA = [\s\S]{0,120}documentPictureInPicture/.test(fonte),
      "a existência do recurso é medida, não suposta");
    P.ok(/if \(TEM_JANELA\) \{[\s\S]{0,400}Abrir em outra janela/.test(fonte),
      "e o botão de nova janela só aparece onde o navegador sabe abri-la");
  }

  /* ======================================================================
     O ANEXO É CIFRADO EM DISCO

     Até a 0.11.0 o banco era cifrado e o arquivo não. A assimetria era pior
     que a falta: quem levasse um backup lia os anexos — o exame, o contrato,
     a foto — e não lia as conversas. Ninguém espera essa ordem.

     Quatro coisas precisam ser verdade ao mesmo tempo, e é fácil conseguir
     três: cifrar, ler de volta idêntico, NÃO quebrar o que já está no disco
     em claro, e RECUSAR arquivo adulterado.
     ====================================================================== */
  P.secao("anexo cifrado em disco");

  {
    const fsn = require("node:fs");
    const os = require("node:os");
    const pathn = require("node:path");
    const cryptn = require("node:crypto");
    const arm = require(pathn.join(__dirname, "..", "src", "infra", "storage", "armazenamento.js"));

    const pasta = fsn.mkdtempSync(pathn.join(os.tmpdir(), "zzqa-anexo-"));
    const disco = arm.criar({ driver: "local", pasta });

    const marcaSecreta = "ZZ QA conteudo sigiloso do exame";
    const original = Buffer.concat([
      Buffer.from("%PDF-1.7 " + marcaSecreta + " "),
      cryptn.randomBytes(64 * 1024),
    ]);

    const lerTudo = (fluxo) => new Promise((ok, err) => {
      const pedacos = [];
      fluxo.on("data", (d) => pedacos.push(d))
           .on("end", () => ok(Buffer.concat(pedacos)))
           .on("error", err);
    });

    const g = await disco.gravar(original, { sufixo: "bin" });
    const noDisco = fsn.readFileSync(pathn.join(pasta, g.caminho));

    P.eq(noDisco.subarray(0, 4).toString("ascii"), "LAC1",
      "o arquivo em disco leva o selo do formato cifrado");
    P.ok(!noDisco.includes(Buffer.from(marcaSecreta)),
      "e o conteúdo NÃO aparece em claro no disco");
    P.eq(noDisco.length - g.tamanho, 33,
      "a sobrecarga é de 33 bytes (selo, versão, IV e tag)");

    /* O tamanho e o hash devolvidos são os do CONTEÚDO, não os do arquivo.
       Trocá-los faria o Content-Length do download mentir e a conferência de
       integridade acusar corrupção em todo anexo. */
    P.eq(g.tamanho, original.length, "o tamanho declarado é o do conteúdo em claro");
    P.eq(g.hash, cryptn.createHash("sha256").update(original).digest("hex"),
      "e o hash também — é o que o download confere");
    P.eq(await disco.tamanho(g.caminho), original.length,
      "tamanho() desconta a sobrecarga da cifra");

    P.ok((await disco.ler(g.caminho)).equals(original), "ler() devolve o original");
    P.ok((await lerTudo(disco.fluxo(g.caminho))).equals(original),
      "fluxo() devolve o original — a tag mora no fim e é buscada antes");

    /* ------------------------------------------------------------------
       O QUE JÁ ESTÁ NO DISCO. Sem esta compatibilidade, ligar a cifra
       tornaria ilegível todo anexo já enviado — e o backup não ajudaria,
       porque o backup também está em claro.
       ------------------------------------------------------------------ */
    const antigo = pathn.posix.join("2024", "01", "legado.bin");
    fsn.mkdirSync(pathn.join(pasta, "2024", "01"), { recursive: true });
    fsn.writeFileSync(pathn.join(pasta, antigo), original);

    P.ok((await disco.ler(antigo)).equals(original),
      "anexo ANTERIOR à cifra continua legível por ler()");
    P.ok((await lerTudo(disco.fluxo(antigo))).equals(original),
      "e por fluxo() também");

    /* ------------------------------------------------------------------
       ADULTERAÇÃO. É o que o GCM oferece além da confidencialidade, e é o
       motivo de a tag ser buscada ANTES de o download começar: entregar
       bytes não autenticados seria abrir mão justamente disso.
       ------------------------------------------------------------------ */
    const alvo = pathn.join(pasta, g.caminho);
    const mexido = fsn.readFileSync(alvo);
    mexido[100] ^= 0xFF;
    fsn.writeFileSync(alvo, mexido);

    let recusouLer = false;
    try { await disco.ler(g.caminho); } catch { recusouLer = true; }
    P.ok(recusouLer, "arquivo ADULTERADO no disco é recusado por ler()");

    let recusouFluxo = false;
    await new Promise((ok) => disco.fluxo(g.caminho)
      .on("data", () => { })
      .on("end", ok)
      .on("error", () => { recusouFluxo = true; ok(); }));
    P.ok(recusouFluxo, "e o download é interrompido em vez de entregar bytes alterados");

    fsn.rmSync(pasta, { recursive: true, force: true });
  }

  /* ======================================================================
     A POLÍTICA DE TRANSPORTE DA MÍDIA

     Numa reunião por link, o IP é a única coisa que um estranho leva embora
     sem pedir. `relay` fecha isso — e só funciona se houver relay para onde
     mandar, o que faz do `temTurn` parte da regra, e não um detalhe.
     ====================================================================== */
  P.secao("relay: quem vê o IP de quem");

  {
    const path2 = require("node:path");
    const { criarTurn } = require(path2.join(__dirname, "..", "src", "infra", "seguranca", "turn.js"));

    const comTurn = criarTurn({
      urls: ["turn:relay.exemplo:3478"], segredo: "zz-qa-segredo",
      stun: ["stun:stun.exemplo:3478"],
    });

    P.eq(comTurn.credenciais("u1").iceTransportPolicy, "all",
      "chamada comum entre colegas vai direto — relay ali só gastaria banda");
    P.eq(comTurn.credenciais("u1", { aberta: true }).iceTransportPolicy, "relay",
      "reunião por LINK vai pelo relay — ninguém vê o IP de ninguém");

    const global = criarTurn({
      urls: ["turn:relay.exemplo:3478"], segredo: "zz-qa-segredo", soRelay: true,
    });
    P.eq(global.credenciais("u1").iceTransportPolicy, "relay",
      "e a chave de instalação continua valendo para tudo");

    /* ==================================================================
       SEM SERVIDOR DE RELAY, PEDIR relay NÃO É MAIS SEGURO: é impossível.
       O navegador descarta todo candidato que não seja de relay e não sobra
       nenhum — a chamada falha em silêncio, com cara de problema de rede.
       ================================================================== */
    const semTurn = criarTurn({ urls: [], segredo: "", stun: ["stun:stun.exemplo:3478"] });
    P.eq(semTurn.credenciais("u1", { aberta: true }).iceTransportPolicy, "all",
      "sem TURN configurado, NÃO se pede relay — seria chamada impossível");

    /* A credencial é derivada por HMAC e expira sozinha: vazou, morre. */
    const c = comTurn.credenciais("u1", { aberta: true });
    const alvo = c.iceServers.find((s) => String(s.urls).startsWith("turn:"));
    P.ok(comTurn.conferir(alvo.username, alvo.credential),
      "a credencial de relay confere com a conta que o coturn faz");
    P.ok(Number(String(alvo.username).split(":")[0]) * 1000 > Date.now(),
      "e traz a validade embutida no próprio nome de usuário");
  }

  /* ====================================================================== */
  P.secao("tradução de SQL");

  P.eq(paraPostgres("SELECT * FROM m WHERE a=? AND b=?"), "SELECT * FROM m WHERE a=$1 AND b=$2",
    "os `?` viram `$n` em ordem");
  P.eq(paraPostgres("SELECT * FROM m WHERE nome LIKE ?"), "SELECT * FROM m WHERE nome ILIKE $1",
    "LIKE vira ILIKE (senão a busca para de achar maiúsculas)");
  P.eq(paraPostgres("SELECT like_count FROM m WHERE x=?"), "SELECT like_count FROM m WHERE x=$1",
    "coluna chamada like_count não é tocada");
  P.eq(paraPostgres("SELECT * FROM m WHERE t='a?b' AND x=?"), "SELECT * FROM m WHERE t='a?b' AND x=$1",
    "`?` dentro de string não vira parâmetro");
  P.eq(paraPostgres("SELECT * /* d'agua ? */ FROM m WHERE x=?"), "SELECT * /* d'agua ? */ FROM m WHERE x=$1",
    "apóstrofo em comentário não abre string falsa");
  P.eq(paraPostgres("SELECT * FROM m WHERE t='it''s' AND a=?"), "SELECT * FROM m WHERE t='it''s' AND a=$1",
    "aspa escapada dentro de string é respeitada");

  return P.fim();
}

if (require.main === module) {
  rodar().then((ok) => { process.exitCode = ok ? 0 : 1; });
}

module.exports = { rodar };
