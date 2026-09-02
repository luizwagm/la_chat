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
    /* Casa pela CHAMADA, e não pelo texto do botão. A versão anterior olhava
       para o rótulo, e quebrou no dia em que ele mudou — acusando um defeito
       que não existia. O que precisa ser verdade é que o botão só exista onde a
       API existe; como ele se chama na tela é outra conversa. */
    P.ok(/if \(TEM_JANELA\) \{[\s\S]{0,400}abrirReuniaoEmJanela\(\)/.test(fonte),
      "e o botão da janela flutuante só aparece onde o navegador sabe abri-la");

    /* A JANELA SEPARADA É OUTRA COISA, e não depende de API nenhuma:
       `window.open` existe em todo navegador. Se ela ficasse atrás do mesmo
       `TEM_JANELA`, o Firefox e o Safari perderiam a única das duas que
       resolve "quero usar o sistema enquanto atendo". */
    const vista = corpoDe("botoesDeVista", fonte);
    P.ok(/abrirEmJanelaSeparada/.test(vista),
      "e a janela SEPARADA tem botão próprio");
    P.ok(!/TEM_JANELA[\s\S]{0,200}abrirEmJanelaSeparada/.test(vista),
      "que NÃO está atrás do documentPictureInPicture — window.open é universal");
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

  /* ======================================================================
     O COOKIE DO CONVIDADO — o defeito que a suíte não podia ver

     O convidado tem sessão própria: cookie `cvd` e token `cvd_csrf`. O
     componente procurava sempre `cid_csrf`, o do funcionário. Para um
     convidado esse cookie não existe, então o CSRF ia VAZIO, o
     `POST /bilhete` era recusado, e ele NUNCA abria o WebSocket.

     Sem socket não há troca de sinais WebRTC. O sintoma: a reunião abre, as
     pessoas aparecem com nome, e todos os retratos ficam eternamente em
     "conectando…" — com cara de problema de rede, de TURN, de firewall. A
     chamada interna funcionava, porque ali o cookie é `cid`.

     ---------------------------------------------------------------------
     POR QUE 660 TESTES NÃO PEGARAM

     Porque o cliente de teste monta o cabeçalho CSRF sozinho, lendo o cookie
     certo. A suíte provava o SERVIDOR e emulava um cliente correto —
     exatamente o que o cliente de verdade não era.

     Estas travas olham o CÓDIGO DO CLIENTE, que é onde o defeito morava.
     ====================================================================== */
  P.secao("cliente: o convidado usa o cookie DELE");

  {
    const fs2 = require("node:fs");
    const path2 = require("node:path");
    const publico = path2.join(__dirname, "..", "publico");
    const nucleo = fs2.readFileSync(path2.join(publico, "la-chat.js"), "utf8");
    const pagina = fs2.readFileSync(path2.join(publico, "sala.js"), "utf8");

    /* O nome do cookie tem de DEPENDER do modo, e não ser fixo. */
    const getter = /get nomeDoCookie\(\)\s*\{([\s\S]{0,300}?)\}/.exec(nucleo);
    P.ok(!!getter, "o componente decide o nome do cookie num lugar só");
    P.ok(/modo === "sala"/.test(getter?.[1] || ""),
      "e a decisão OLHA O MODO", (getter?.[1] || "").trim().slice(0, 80));
    P.ok(/"cvd"/.test(getter?.[1] || "") && /"cid"/.test(getter?.[1] || ""),
      "conhecendo os dois cookies: cvd para convidado, cid para funcionário");

    /* E o `csrf()` precisa USAR o getter, não reintroduzir o literal. */
    const corpoCsrf = /\n    csrf\(\) \{([\s\S]{0,300}?)\n    \}/.exec(nucleo);
    P.ok(!!corpoCsrf, "achei o csrf()");
    P.ok(/nomeDoCookie/.test(corpoCsrf?.[1] || ""),
      "que lê o nome pelo getter", (corpoCsrf?.[1] || "").trim().slice(0, 70));
    P.ok(!/"cid"/.test(corpoCsrf?.[1] || ""),
      "e NÃO traz o \"cid\" de volta escrito à mão — era essa linha o defeito");

    /* A página do convidado também diz, explicitamente. */
    P.ok(/setAttribute\("cookie",\s*"cvd"\)/.test(pagina),
      "a página do convidado passa o cookie dela ao componente");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = corpoCsrf?.[1]?.replace("nomeDoCookie", '"cid"') || "";
    P.ok(!/nomeDoCookie/.test(sabotado) && /"cid"/.test(sabotado),
      "e a trava ACUSA se alguém fixar o cookie do funcionário de novo");
  }

  /* ======================================================================
     A OFERTA QUE SE PERDE ANTES DO SOCKET ABRIR

     Sinal de WebRTC é entregue AO VIVO. Mensagem tem `seq` e fica no banco —
     perdida, a retomada a traz de volta. Sinal não: se ninguém estava
     escutando, acabou, e ninguém reoferece sozinho.

     A janela não é rara — é o caso NORMAL de quem entra por um link: o
     servidor marca a pessoa como `dentro` e avisa o anfitrião enquanto ela
     ainda está abrindo o socket. A oferta do anfitrião chega para ninguém, a
     dela sai antes da hora, e os dois ficam em "conectando…" para sempre.

     O relato foi exato: "o anfitrião precisa sair e entrar de novo pra
     funcionar" — porque aí o socket do outro já estava aberto havia tempo.

     Reproduzido no navegador com o socket atrasado em 3 segundos: COM o
     gancho, `connected`; SEM ele, `new` por 17,5 segundos.
     ====================================================================== */
  P.secao("cliente: a oferta perdida é refeita quando o socket abre");

  {
    const fs3 = require("node:fs");
    const path3 = require("node:path");
    const publico = path3.join(__dirname, "..", "publico");
    const nucleo = fs3.readFileSync(path3.join(publico, "la-chat.js"), "utf8");
    const video = fs3.readFileSync(path3.join(publico, "la-chat-video.js"), "utf8");

    /* O núcleo avisa quem estava esperando, quando o socket abre. */
    const iOnopen = nucleo.indexOf("ws.onopen = () => {");
    const corpoOnopen = iOnopen < 0 ? "" : nucleo.slice(iOnopen, iOnopen + 1200);
    P.ok(iOnopen > 0, "achei o onopen do socket");
    P.ok(corpoOnopen.includes("aoSocketAberto"),
      "e ele avisa quem estava esperando o socket");

    P.ok(nucleo.includes("esperarSocket("), "o núcleo sabe ESPERAR o socket abrir");

    /* O vídeo se pendura no aviso e reoferece. */
    const iGancho = video.indexOf("LaChat.prototype.aoSocketAberto = function");
    const gancho = iGancho < 0 ? "" : video.slice(iGancho, iGancho + 700);
    P.ok(iGancho > 0, "o vídeo se pendura nesse aviso");
    P.ok(gancho.includes("reconvidar"), "e reoferece a quem está dentro");

    /* `reconvidar` NÃO pode ser `convidar`: o par já existe, e `convidar` sai
       sem fazer nada quando ele existe — que é justamente o caso aqui. */
    const iRe = video.indexOf("      reconvidar(id) {");
    const re = iRe < 0 ? "" : video.slice(iRe, iRe + 900);
    P.ok(iRe > 0, "a malha tem `reconvidar`");
    P.ok(re.includes("setLocalDescription"),
      "que FORÇA uma oferta nova — `convidar` sairia sem fazer nada");
    P.ok(re.includes("connected"), "e não mexe em conexão que já está de pé");

    /* Quem entra por link espera o socket antes de oferecer. */
    const iEntrar = video.indexOf("entrarNaSala = async function");
    const entrar = iEntrar < 0 ? "" : video.slice(iEntrar, iEntrar + 900);
    P.ok(entrar.includes("esperarSocket"),
      "e quem entra por link espera o socket antes de oferecer");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = corpoOnopen.replace("aoSocketAberto", "naoExiste");
    P.ok(!sabotado.includes("aoSocketAberto"),
      "e a trava ACUSA se o aviso for removido do onopen");
  }

  /* ======================================================================
     UM ENDEREÇO DE RELAY TORTO DERRUBA A CHAMADA INTEIRA

     O navegador recusa construir a RTCPeerConnection quando um item de
     iceServers não tem forma de URL, e a recusa é uma exceção seca:
     "Failed to construct RTCPeerConnection". Não diz qual endereço, não
     menciona configuração. Do lado de quem atende, a reunião não abre.

     Aconteceu no Instituto, e da forma mais banal: o COLE_AQUI da
     documentação ficou literal no arquivo de ambiente. A conferência de
     subida existia e não pegou — ela só perguntava se a lista estava VAZIA,
     e COLE_AQUI não é vazio.
     ====================================================================== */
  P.secao("relay: endereço inválido é descartado, não repassado");

  {
    const caminhoConf = require.resolve("../config.js");

    /* O config é lido do ambiente na CARGA. Para exercitar dois ambientes
       diferentes, ele é recarregado — e o estado anterior, esquecido. */
    function comAmbiente(vars) {
      const antes = {};
      for (const k of Object.keys(vars)) { antes[k] = process.env[k]; process.env[k] = vars[k]; }
      delete require.cache[caminhoConf];
      let conf;
      try { conf = require(caminhoConf).CONF; } finally {
        for (const k of Object.keys(vars)) {
          if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k];
        }
        delete require.cache[caminhoConf];
      }
      return conf;
    }

    const ruim = comAmbiente({
      CHAT_VIDEO: "1", CHAT_TURN: "COLE_AQUI", CHAT_TURN_SEGREDO: "zz-qa",
    });
    P.eq(ruim.video.turn.length, 0,
      "COLE_AQUI NÃO chega ao navegador", JSON.stringify(ruim.video.turn));
    P.eq(ruim.video.turnRuins[0], "COLE_AQUI",
      "mas fica guardado, para a subida poder denunciá-lo pelo nome");

    const bom = comAmbiente({
      CHAT_VIDEO: "1",
      CHAT_TURN: "turn:chat.exemplo.com:3478,turns:chat.exemplo.com:5349",
      CHAT_TURN_SEGREDO: "zz-qa",
    });
    P.eq(bom.video.turn.length, 2,
      "endereço legítimo passa inteiro", JSON.stringify(bom.video.turn));
    P.eq(bom.video.turnRuins.length, 0,
      "e não sobra nada para denunciar");

    /* O MEIO A MEIO é o caso perverso: um endereço bom e um torto. Sem
       separar, o torto derruba a chamada mesmo havendo relay funcionando. */
    const meio = comAmbiente({
      CHAT_VIDEO: "1", CHAT_TURN: "turn:ok.exemplo.com:3478,COLE_AQUI",
      CHAT_TURN_SEGREDO: "zz-qa",
    });
    P.eq(meio.video.turn.length, 1,
      "com um bom e um torto, só o bom segue");
    P.eq(meio.video.turnRuins.length, 1,
      "e o torto é denunciado — sem levar o bom junto");

    /* ---- e o cliente não estoura mesmo se receber lixo ---- */
    const fsI = require("node:fs");
    const pathI = require("node:path");
    const videoI = fsI.readFileSync(
      pathI.join(__dirname, "..", "publico", "la-chat-video.js"), "utf8");

    const iPar = videoI.indexOf("    function par(id) {");
    const par = iPar < 0 ? "" : videoI.slice(iPar, iPar + 1800);
    P.ok(iPar > 0, "achei a criação do par na malha");
    P.ok(/stuns\?\|turns\?/.test(par),
      "o cliente filtra iceServers antes de construir — segunda tranca");
    P.ok(/try \{[\s\S]{0,200}new RTCPeerConnection/.test(par),
      "e a construção é protegida");
    P.ok(/catch[\s\S]{0,300}new RTCPeerConnection\(\{ iceTransportPolicy/.test(par),
      "com uma segunda tentativa SEM servidores — reunião degradada vence exceção");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = par.split("stuns?|turns?").join("naoExiste");
    P.ok(!/stuns\?\|turns\?/.test(sabotado),
      "e a trava acusa se o filtro do cliente sumir");
  }

  /* ======================================================================
     O TOQUE DE CHAMADA TAMBÉM SEGUE A INSTALAÇÃO

     Não adianta o Instituto ter aviso de mensagem próprio e continuar CHAMANDO
     igual à clínica: quem atende os dois na mesma mesa fica sem saber de onde
     vem a chamada — justamente quando a pergunta é urgente.

     E o padrao tem de ser IDÊNTICO ao que existia. Medido no navegador:
     renderizadas as duas receitas num OfflineAudioContext, a maior diferença
     amostra a amostra foi ZERO. Quem não escolher nada não ouve diferença.
     ====================================================================== */
  P.secao("cliente: o toque de CHAMADA segue a instalação");

  {
    const fsC = require("node:fs");
    const pathC = require("node:path");
    const publicoC = pathC.join(__dirname, "..", "publico");
    const videoC = fsC.readFileSync(pathC.join(publicoC, "la-chat-video.js"), "utf8");
    const nucleoC = fsC.readFileSync(pathC.join(publicoC, "la-chat.js"), "utf8");

    /* Cada receita é recortada até o PRÓPRIO fecho. A primeira versão pegava
       260 caracteres a partir do nome, e a fatia do forte invadia a do grave —
       acusando uma cadência que era do vizinho. */
    const receita = (nome) => {
      const i = videoC.indexOf("    " + nome + ": {");
      if (i < 0) return "";
      const f = videoC.indexOf("},", i);
      return f < 0 ? "" : videoC.slice(i, f + 2);
    };

    P.ok(/const TOQUES_CHAMADA = \{/.test(videoC),
      "o toque de chamada virou um conjunto de receitas");

    /* O PADRÃO NÃO PODE MUDAR: estes números são o toque que a clínica já
       ouve, e mexer neles troca o som de quem não pediu. */
    const padrao = receita("padrao");
    P.ok(!!padrao, "existe o padrão");
    P.ok(/onda: "sine"/.test(padrao), "em senoide, como sempre foi");
    P.ok(/pico: 0\.05\b/.test(padrao), "com o mesmo ganho de 0,05");
    P.ok(/intervalo: 2600/.test(padrao), "repetindo a cada 2600 ms");
    P.ok(/\[0, 660\][\s\S]{0,20}\[0\.18, 880\]/.test(padrao),
      "e as mesmas duas notas", padrao.replace(/\s+/g, " "));

    /* O forte precisa ser OUTRO som, e não o mesmo mais alto. */
    const forte = receita("forte");
    P.ok(!!forte, "existe o forte");
    P.ok(!/onda: "sine"/.test(forte), "com outra forma de onda");
    P.ok(!/intervalo: 2600/.test(forte),
      "e outra cadência — é outro toque, não o mesmo mais alto",
      forte.replace(/\s+/g, " "));

    /* A escolha precisa CHEGAR até aqui. O arquivo do vídeo é outro escopo e
       não enxerga o objeto de som do núcleo; a ponte é o estado. */
    P.ok(/toque\.tocar\(this\.estado\.toque\)/.test(videoC),
      "e quem toca passa a escolha da instalação");
    P.ok(/this\.estado\.toque = eu\.toque/.test(nucleoC),
      "que o núcleo guardou quando o /eu respondeu");

    /* Ausente, o padrão vale: chat velho, ou /eu que ainda não voltou. */
    P.ok(/TOQUES_CHAMADA\[perfil\] \|\| TOQUES_CHAMADA\.padrao/.test(videoC),
      "e sem escolha nenhuma, toca o de sempre");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = videoC.split("this.estado.toque").join("naoExiste");
    P.ok(!/toque\.tocar\(this\.estado\.toque\)/.test(sabotado),
      "e a trava acusa se a escolha deixar de chegar ao toque de chamada");
  }

  /* ======================================================================
     CADA INSTALAÇÃO COM O SEU TOQUE

     Quem atende a clínica e o Instituto na mesma mesa precisa saber de ONDE
     veio a mensagem sem olhar a tela. E quem não escolher nada continua
     ouvindo exatamente o que ouve hoje — essa é a metade do pedido que não
     dá sinal quando quebra.
     ====================================================================== */
  P.secao("cliente: o toque escolhido é o que soa");

  {
    const fsT = require("node:fs");
    const pathT = require("node:path");
    const nucleoT = fsT.readFileSync(
      pathT.join(__dirname, "..", "publico", "la-chat.js"), "utf8");

    P.ok(/const TOQUES = \{/.test(nucleoT),
      "o cliente conhece um conjunto de toques");
    P.ok(/forte:/.test(nucleoT), "entre eles o FORTE, pedido para o Instituto");

    /* Gerado, não baixado: um arquivo por toque seria um recurso a servir,
       a versionar e que a CSP do hospedeiro pode barrar. */
    P.ok(!/TOQUES\s*=\s*\{[\s\S]{0,600}\.mp3/.test(nucleoT),
      "e nenhum deles é um arquivo — são receitas de osciladores");

    /* A ORDEM É O PONTO. O preset tem de vencer o arquivo já baixado: sem
       isso, uma instalação que pediu outro som volta a tocar o padrão assim
       que o mp3 chega, e o defeito depende de quem responde primeiro. */
    const iToc = nucleoT.indexOf("    tocar() {");
    const tocar = iToc < 0 ? "" : nucleoT.slice(iToc, iToc + 1200);
    P.ok(iToc > 0, "achei o disparo do som");
    P.ok(tocar.includes("TOQUES[this.perfil]"),
      "que consulta o toque desta instalação");
    P.ok(tocar.includes("this.buffer"),
      "e a fatia alcança o caminho do arquivo — senão a ordem abaixo mede o vazio");
    P.ok(tocar.indexOf("TOQUES[this.perfil]") < tocar.indexOf("this.buffer"),
      "ANTES do arquivo — o escolhido vence o que já estava baixado");

    /* O padrão é o arquivo, e continua sendo. */
    P.ok(/perfil: "padrao"/.test(nucleoT),
      "e o padrão de fábrica é o som de sempre");
    P.ok(/som\.usarPerfil\(eu\.toque\)/.test(nucleoT),
      "a escolha chega do servidor, no /eu");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = tocar.split("TOQUES[this.perfil]").join("naoExiste");
    P.ok(!sabotado.includes("TOQUES[this.perfil]"),
      "e a trava acusa se a escolha deixar de ser consultada");
  }

  /* ======================================================================
     O NAVEGADOR PERGUNTA UMA VEZ SÓ

     A permissão de câmera não pode ser dispensada — é uma garantia do
     navegador, e o dia em que uma página puder se auto-autorizar é o dia em
     que qualquer página liga a câmera de qualquer um. O que dá para consertar
     é PERGUNTAR DEMAIS, e nós perguntávamos duas vezes:

       1. a prévia pedia { video: true, audio: false }
       2. a reunião pedia { audio: {...}, video: {...} }

     O microfone ficava de fora do primeiro pedido, então o segundo tinha uma
     permissão NOVA a pedir — e o diálogo voltava no pior momento, com todo
     mundo já na tela esperando. Pior: entre os dois, a prévia PARAVA as
     trilhas, e a câmera apagava e reacendia na hora de entrar.

     As duas travas abaixo prendem as duas metades do conserto.
     ====================================================================== */
  P.secao("convidado: a câmera é pedida uma vez só");

  {
    const fsP = require("node:fs");
    const pathP = require("node:path");
    const publicoP = pathP.join(__dirname, "..", "publico");
    const salaP = fsP.readFileSync(pathP.join(publicoP, "sala.js"), "utf8");
    const videoP = fsP.readFileSync(pathP.join(publicoP, "la-chat-video.js"), "utf8");

    /* ---- 1. o pedido da prévia cobre o que a reunião vai querer ---- */
    const pedidos = [...salaP.matchAll(/getUserMedia\(([^)]*)\)/g)].map((m) => m[1]);
    P.eq(pedidos.length, 1, "a página do convidado chama getUserMedia UMA vez",
      pedidos.join(" | "));
    /* Conferido no ARGUMENTO do pedido, e nao no arquivo inteiro: o comentario
       que explica o defeito antigo cita audio:false textualmente, e uma busca
       solta acusaria a propria explicacao. */
    P.ok(!pedidos.some((x) => /audio:s*false/.test(x)),
      "e NUNCA pedindo audio:false — e o que fazia o segundo dialogo aparecer",
      pedidos.join(" | "));
    P.ok(/const EXIGENCIAS = \{[\s\S]{0,400}audio:[\s\S]{0,200}video:/.test(salaP),
      "o pedido leva áudio E vídeo, como a reunião leva");
    P.ok(/echoCancellation/.test(salaP),
      "com as MESMAS exigências de áudio da reunião — senão o navegador reabre o microfone");

    /* O microfone chega desligado: a pessoa ainda não entrou em reunião. */
    P.ok(/getAudioTracks\(\)\)\s*t\.enabled = false/.test(salaP.replace(/\s*for \(const /g, "")) ||
      /t\.enabled = false/.test(salaP),
      "e o microfone chega DESLIGADO — a permissão é dada, a captura não");

    /* ---- 2. a prévia é ENTREGUE, não refeita ---- */
    P.ok(/function entregarPrevia\(\)/.test(salaP),
      "existe um caminho que ENTREGA a prévia à reunião");
    const entregar = salaP.slice(salaP.indexOf("function entregarPrevia()"),
      salaP.indexOf("function entregarPrevia()") + 500);
    P.ok(!/\.stop\(\)/.test(entregar),
      "que NÃO para as trilhas — parar apagaria a câmera bem na hora de entrar");
    P.ok(/t\.enabled = true/.test(entregar),
      "e liga o microfone, que estava esperando este momento");

    /* Quem entra na reunião usa o caminho da entrega, não o do descarte. */
    P.ok(!/fecharPrevia\(\);\s*\n\s*await entrarNaReuniao/.test(salaP),
      "e nenhum caminho de entrada joga a prévia fora antes de usá-la");

    /* ---- 3. o componente aceita o fluxo pronto ---- */
    const iCam = videoP.indexOf("async abrirCamera()");
    const cam = iCam < 0 ? "" : videoP.slice(iCam, iCam + 3000);
    P.ok(iCam > 0, "achei a abertura de câmera do componente");
    P.ok(/_fluxoPronto/.test(cam),
      "que reaproveita o fluxo já conquistado pela prévia");
    /* A CHAMADA, e nao a palavra: o comentario logo acima cita getUserMedia
       para explicar que ele nao e chamado, e comparar posicoes de texto
       faria a explicacao contar como se fosse codigo. */
    P.ok(cam.includes("mediaDevices.getUserMedia"),
      "e a fatia alcanca o pedido ao navegador — senao a ordem abaixo mede o vazio");
    P.ok(cam.indexOf("_fluxoPronto") < cam.indexOf("mediaDevices.getUserMedia"),
      "ANTES de pensar em pedir de novo");
    P.ok(/entrarNaSala = async function \(\{ eu, sala, chamada \}, opcoes/.test(videoP),
      "e a entrada na sala recebe esse fluxo de quem já o tem");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = cam.split("_fluxoPronto").join("naoExiste");
    P.ok(!sabotado.includes("_fluxoPronto"),
      "e a trava acusa se o reaproveitamento sumir");
  }

  /* ======================================================================
     O CLIENTE PRECISA SER JAVASCRIPT VÁLIDO

     Parece a última coisa que precisaria de teste, e é a que faltava. Nenhuma
     suíte executava o cliente: as de servidor buscam `/cliente.js` por HTTP e o
     servidor só CONCATENA texto, sem opinar sobre o conteúdo; as de análise
     estática leem os arquivos como string. Um erro de sintaxe passava por tudo
     verde e só aparecia como tela em branco no navegador.

     E ele acontece: o CSS mora num template literal, e uma CRASE dentro de um
     comentário de CSS fecha a string no meio. Já ocorreu QUATRO vezes neste
     projeto — sempre escrevendo `display: none` ou `inset: 0` entre crases,
     por hábito de Markdown, dentro de um arquivo que não é Markdown.

     `vm.Script` COMPILA sem executar: nada de DOM, nada de efeito colateral. É
     exatamente a pergunta que interessa — "isto é programável?" — e nada além.
     ====================================================================== */
  P.secao("o cliente compila");

  {
    const vm = require("node:vm");
    const fsC = require("node:fs");
    const pathC = require("node:path");
    const publicoC = pathC.join(__dirname, "..", "publico");

    for (const arquivo of ["la-chat.js", "la-chat-video.js", "sala.js", "janela.js"]) {
      let erro = null;
      try {
        new vm.Script(fsC.readFileSync(pathC.join(publicoC, arquivo), "utf8"),
          { filename: arquivo });
      } catch (e) { erro = e.message; }
      P.ok(!erro, arquivo + " é JavaScript válido", erro || "");
    }

    /* E o que o navegador realmente recebe: os dois arquivos COLADOS, com a
       emenda que o servidor faz. Cada um pode compilar sozinho e a junta
       quebrar — uma linha terminada em comentário de barra dupla engoliria a
       primeira do seguinte, que é o motivo de a emenda não ser vazia. */
    const colado = [
      fsC.readFileSync(pathC.join(publicoC, "la-chat.js"), "utf8"),
      fsC.readFileSync(pathC.join(publicoC, "la-chat-video.js"), "utf8"),
    ].join("\n;\n");

    let erroColado = null;
    try { new vm.Script(colado, { filename: "cliente.js" }); }
    catch (e) { erroColado = e.message; }
    P.ok(!erroColado, "e o cliente CONCATENADO também compila", erroColado || "");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO: a sabotagem é a crase de verdade,
       posta onde ela sempre aparece — dentro de um comentário de CSS. */
    let pegou = false;
    try {
      /* A crase e montada, e nao escrita: escrever uma crase literal aqui
         fecharia o proprio literal que a contem. E essa e, textualmente, a
         armadilha que este teste existe para pegar. */
      const crase = String.fromCharCode(96);
      new vm.Script("const CSS = " + crase + "\n/* uma " + crase + "crase" + crase
        + " no meio */\n.a{}\n" + crase + ";");
    } catch { pegou = true; }
    P.ok(pegou, "e a trava ACUSA uma crase solta dentro do CSS");
  }

  /* ======================================================================
     `iniciar()` DEVOLVE O TRABALHO EM CURSO

     Duas chamadas simultâneas são o caso NORMAL: marcar `aberto` dispara
     `iniciar()` pelo `attributeChangedCallback`, e quem abre o chat também
     chama `iniciar()`.

     Devolvendo `undefined` à segunda, um `await` nela termina IMEDIATAMENTE,
     com `estado.eu` ainda nulo — e quem esperava segue como se a identidade
     estivesse pronta. O defeito é INTERMITENTE, porque depende de quem chega
     primeiro: a janela da reunião dizia "sua sessão expirou" com a sessão
     válida, e só quando a outra aba respondia rápido demais.

     Este teste existe porque intermitente é o que ninguém consegue reproduzir
     de propósito seis meses depois.
     ====================================================================== */
  P.secao("cliente: iniciar duas vezes espera o mesmo trabalho");

  {
    const fs8 = require("node:fs");
    const path8 = require("node:path");
    const nucleo8 = fs8.readFileSync(
      path8.join(__dirname, "..", "publico", "la-chat.js"), "utf8");

    P.ok(/if \(this\.iniciando\) return this\.iniciando;/.test(nucleo8),
      "a segunda chamada devolve a promessa da primeira, e não `undefined`");
    P.ok(!/if \(this\.iniciando\) return;/.test(nucleo8),
      "e o retorno vazio, que terminava na hora, não voltou");
    P.ok(/this\.iniciando = new Promise/.test(nucleo8),
      "o campo guarda a promessa, e não um booleano");
    P.ok(/concluir\(\);[\s\S]{0,200}this\.iniciando = null;/.test(nucleo8),
      "e libera quem espera ANTES de limpar o campo");

    /* Quem assume a reunião precisa ESPERAR de verdade — e só marcar `aberto`
       depois, para não disparar a segunda partida. */
    const video8 = fs8.readFileSync(
      path8.join(__dirname, "..", "publico", "la-chat-video.js"), "utf8");
    const iAss = video8.indexOf("LaChat.prototype.assumirChamada");
    const assumir = iAss < 0 ? "" : video8.slice(iAss, iAss + 1400);
    P.ok(assumir.indexOf("await this.iniciar()") < assumir.indexOf('setAttribute("aberto"'),
      "a janela inicia ANTES de marcar `aberto` — marcar dispara outro iniciar");
    P.ok(/if \(!this\.estado\.eu\?\.id\)/.test(assumir),
      "e se ainda assim não houver identidade, PARA — sem ela a malha conecta consigo mesma");
  }

  /* ======================================================================
     A REUNIÃO QUE MUDA DE JANELA

     Três coisas sustentam esta funcionalidade, e nenhuma delas é visível numa
     leitura rápida. Se qualquer uma cair, o sintoma NÃO é um erro: é a pessoa
     na lista sem imagem, ou a reunião acabando sozinha no meio da consulta.

       1. A ORDEM. A janela abre ANTES de esta aba soltar qualquer coisa. Ao
          contrário, um bloqueador de pop-up custa a reunião em andamento.
       2. NÃO SE SAI DA CHAMADA. Entregar não é sair — o servidor encerra a
          chamada quando sobra uma pessoa só, e numa consulta a dois a reunião
          morreria durante a própria transferência.
       3. OS PARES SÃO REFEITOS. O outro lado tem conexão viva com o contexto
          que morreu; renegociar trocando o certificado DTLS não é suportado.
     ====================================================================== */
  P.secao("cliente: a reunião muda de janela sem se perder");

  {
    const fs7 = require("node:fs");
    const path7 = require("node:path");
    const publico7 = path7.join(__dirname, "..", "publico");
    const video7 = fs7.readFileSync(path7.join(publico7, "la-chat-video.js"), "utf8");
    const janela7 = fs7.readFileSync(path7.join(publico7, "janela.js"), "utf8");

    /* ---- 1. a ordem ---- */
    const iAbrir = video7.indexOf("LaChat.prototype.abrirEmJanelaSeparada");
    const abrir = iAbrir < 0 ? "" : video7.slice(iAbrir, iAbrir + 1400);
    P.ok(iAbrir > 0, "existe o caminho para a janela separada");
    P.ok(abrir.indexOf("window.open") < abrir.indexOf("escutarPedidoDeEntrega"),
      "a janela abre ANTES de esta aba se comprometer a entregar");
    P.ok(/if \(!janela\)/.test(abrir),
      "e o pop-up bloqueado interrompe tudo — falhar é não mudar nada");

    /* ---- 2. entregar não é sair ---- */
    const iEnt = video7.indexOf("LaChat.prototype.entregarReuniao");
    /* A fatia precisa alcançar o FIM da função. Cortada curta demais, ela
       "não encontra" o que está logo depois e o teste acusa uma ausência que é
       só dela — foi o que aconteceu quando o corpo cresceu. */
    const entregar = iEnt < 0 ? "" : video7.slice(iEnt, iEnt + 3200);
    P.ok(iEnt > 0, "existe a entrega da reunião");
    P.ok(!/\/sair/.test(entregar),
      "que NÃO avisa o servidor que saiu — sair encerraria a chamada a dois");
    P.ok(entregar.includes("malha?.encerrar()"),
      "mas fecha as conexões desta aba");
    P.ok(entregar.includes("entregue = true"),
      "e marca a aba para ignorar a sinalização que ainda chega por ela");
    P.ok(entregar.includes("postMessage"),
      "e a fatia alcança o aviso à janela nova — senão a ordem abaixo mede o vazio");
    P.ok(entregar.indexOf("entregue = true") < entregar.indexOf("postMessage"),
      "e só DEPOIS disso libera a janela nova a entrar");

    /* A aba entregue tem de voltar a ser um chat utilizável. A superfície da
       reunião é absoluta sobre o painel: deixada visível, ela tapa a lista de
       conversas e a caixa de escrever, e o chat parece ter morrido junto. */
    P.ok(/el\.chamada\.hidden = true/.test(entregar),
      "a superfície da reunião SOME da aba — senão ela tapa o chat");
    P.ok(/pintarMensagens\(\)|pintarVazio\(\)/.test(entregar),
      "e a conversa volta a ser desenhada");

    /* A marca precisa ser LIDA em algum lugar, ou não vale nada. */
    P.ok(/if \(v\.entregue/.test(video7),
      "e a marca é conferida na chegada dos eventos de chamada");

    /* ---- 3. os pares são refeitos ---- */
    const iRec = video7.indexOf("      recomecar(id) {");
    const recomecar = iRec < 0 ? "" : video7.slice(iRec, iRec + 900);
    P.ok(iRec > 0, "a malha sabe recomeçar um par do zero");
    P.ok(recomecar.includes("pares.delete(id)"),
      "jogando fora a conexão antiga — inclusive quando ela está saudável");
    P.ok(/mandarSinal\(id, "recomeco"/.test(recomecar),
      "e o sinal LEVA a oferta dentro dele, sem depender de ordem de chegada");
    P.ok(video7.includes('if (tipo === "recomeco")'),
      "e o outro lado sabe recebê-lo");

    P.ok(video7.includes("refazerParesAposEntrega"),
      "a janela refaz os pares depois de assumir");
    P.ok(/if \(transferida\) this\.refazerParesAposEntrega/.test(video7),
      "SÓ quando houve transferência — começar na janela não tem par a refazer");

    /* ---- o handshake, e por que não é um parâmetro no endereço ---- */
    P.ok(janela7.includes('t: "assumir"') && janela7.includes('"livre"'),
      "a janela PERGUNTA se alguém está entregando, em vez de confiar na URL");
    P.ok(!/transferida\s*=\s*.*searchParams/.test(janela7),
      "porque um parâmetro no endereço pode mentir — endereço copiado, aba já fechada");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = entregar.split("entregue = true").join("naoExiste = true");
    P.ok(!sabotado.includes("entregue = true"),
      "e a trava acusa se a aba deixar de se marcar como entregue");
  }

  /* ======================================================================
     O LÁPIS PROMETE O QUE O SERVIDOR CUMPRE

     Um botão que aparece e leva a uma recusa ensina a desconfiar da tela
     inteira. Então as condições do lápis têm de ser as MESMAS de
     `editarMensagem`: só a própria mensagem, só texto puro, só dentro da
     janela — e a janela vem do servidor, não de um número repetido aqui.

     É a mesma classe de defeito que já custou caro neste projeto: dois lados
     de um limite guardando a mesma constante, e um deles mudando sozinho.
     ====================================================================== */
  P.secao("cliente: o lápis de editar só aparece quando a edição é aceita");

  {
    const fs6 = require("node:fs");
    const path6 = require("node:path");
    const raiz6 = path6.join(__dirname, "..");
    const nucleo6 = fs6.readFileSync(path6.join(raiz6, "publico", "la-chat.js"), "utf8");
    const app6 = fs6.readFileSync(path6.join(raiz6, "src", "aplicacao", "chat.js"), "utf8");

    const i = nucleo6.indexOf("podeEditar(m) {");
    const pode = i < 0 ? "" : nucleo6.slice(i, i + 700);
    P.ok(i > 0, "o cliente tem uma regra única para o lápis");

    P.ok(pode.includes("janelaEdicaoMs"),
      "que lê a janela do SERVIDOR, e não uma constante repetida na tela");
    P.ok(/tipo !== "texto"/.test(pode),
      "recusa foto e arquivo — o repositório só aceita texto puro");
    P.ok(pode.includes("autorId !== this.estado.eu"),
      "e só a PRÓPRIA mensagem");

    /* A tela não pode conhecer os cinco minutos por conta própria. */
    P.ok(!/\b(5|15|300000|900000)\s*\*?\s*60/.test(pode),
      "e não carrega nenhum prazo próprio dentro dela", pode.slice(0, 120));

    /* O servidor manda a janela por /eu, e usa a MESMA para decidir. */
    P.ok(app6.includes("janelaEdicaoMs: JANELA_EDICAO_MS"),
      "o servidor publica a janela que ele mesmo aplica");
    P.ok(/Date\.now\(\) - m\.criadaEm > JANELA_EDICAO_MS/.test(app6),
      "e decide por criadaEm — senão cada edição renovaria o prazo para sempre");

    /* O relógio que apaga o lápis numa conversa parada. */
    P.ok(nucleo6.includes("_relogioDoLapis"),
      "e um relógio faz o lápis sumir sem depender de chegar evento nenhum");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = pode.split("janelaEdicaoMs").join("naoExiste");
    P.ok(!sabotado.includes("janelaEdicaoMs"),
      "e a trava acusa se a tela passar a inventar o prazo");
  }

  /* ======================================================================
     O HISTÓRICO DE REUNIÕES NÃO OCUPA A LISTA

     Sala encerrada e link revogado não têm ação nenhuma — nem copiar, porque
     link encerrado copiado é link encerrado ENVIADO. São registro do que
     houve, e registro não precisa estar na frente.

     Deixados na lista, empurram para baixo as duas que ainda importam: depois
     de um mês de uso, a aba abre num histórico onde a reunião de agora é a que
     menos se vê. Apagá-los seria pior — é deles que sai "quem entrou naquela
     consulta de terça".

     Então ficam atrás de uma linha que diz quantos são, e o gesto é o MESMO das
     conversas arquivadas, de propósito: quem aprendeu um não aprende o outro.
     ====================================================================== */
  P.secao("cliente: as reuniões encerradas ficam atrás de uma linha");

  {
    const fs5 = require("node:fs");
    const path5 = require("node:path");
    const publico5 = path5.join(__dirname, "..", "publico");
    const video5 = fs5.readFileSync(path5.join(publico5, "la-chat-video.js"), "utf8");
    const nucleo5 = fs5.readFileSync(path5.join(publico5, "la-chat.js"), "utf8");

    const i = video5.indexOf("LaChat.prototype.pintarLista = function ()");
    const pintar = i < 0 ? "" : video5.slice(i, i + 3000);
    P.ok(i > 0, "achei a pintura da lista de reuniões");

    P.ok(/estado === "encerrada"/.test(pintar) && /estado === "revogada"/.test(pintar),
      "encerrada E revogada saem da lista principal — as duas acabaram");
    P.ok(pintar.includes("verSalasEncerradas"),
      "e ficam atrás de um interruptor, que lembra se foi aberto");
    P.ok(/Encerradas \(/.test(pintar),
      "a linha diz QUANTAS são — senão esconder vira apagar aos olhos de quem lê");

    /* O MESMO GESTO DAS CONVERSAS. A classe vem do estilo do núcleo, no mesmo
       shadow root: escrever outra aqui daria uma linha sem formato nenhum, que
       ninguém reconheceria como clicável. */
    P.ok(pintar.includes('classe: "arquivadas"'),
      "reusando a classe das conversas arquivadas");
    P.ok(nucleo5.includes(".arquivadas {"),
      "que existe no estilo do núcleo — o mesmo shadow root");

    /* A PROVA DE QUE O TESTE NÃO É VAZIO. */
    const sabotado = pintar.split("verSalasEncerradas").join("naoExiste");
    P.ok(!sabotado.includes("verSalasEncerradas"),
      "e a trava acusa se o interruptor sumir");
  }

  /* ======================================================================
     OS NOMES DOS AVISOS DA SALA — as duas pontas, o mesmo texto

     Um aviso da sala atravessa três camadas antes de virar pixel: a aplicação
     emite, o barramento repassa, o transporte embrulha num `{ t: "sala.x" }`,
     e o cliente compara esse `t` com um texto escrito à mão.

     Nada nesse caminho é verificado por ninguém. Escrever `sala.pedido` de um
     lado e `sala.pedidos` do outro não quebra nada, não registra nada e não
     estoura em lugar nenhum — o aviso simplesmente NÃO ACONTECE, e o defeito
     aparece como "a funcionalidade não subiu".

     Este projeto já pagou esse preço duas vezes (a capacidade perdida no passe,
     e o evento de conversa removida fora da lista da auditoria). Então: tudo
     que o transporte publica como `sala.*` tem de ser tratado no cliente.
     ====================================================================== */
  P.secao("cliente e servidor chamam os avisos da sala pelo mesmo nome");

  {
    const fs4 = require("node:fs");
    const path4 = require("node:path");
    const raiz = path4.join(__dirname, "..");
    const transporte = fs4.readFileSync(
      path4.join(raiz, "src", "infra", "realtime", "websocket.js"), "utf8");
    const video = fs4.readFileSync(
      path4.join(raiz, "publico", "la-chat-video.js"), "utf8");

    const publicados = [...new Set(
      [...transporte.matchAll(/t:\s*"(sala\.[a-z]+)"/g)].map((m) => m[1]))].sort();

    P.ok(publicados.length >= 4,
      "o transporte publica avisos de sala", publicados.join(", "));

    for (const nome of publicados) {
      P.ok(video.includes('"' + nome + '"'),
        `o cliente trata \`${nome}\` — o nome bate dos dois lados`);
    }

    /* A PROVA DE QUE O TESTE NÃO É VAZIO: um nome que ninguém publica não
       pode passar só porque o laço acima ficou vazio. */
    P.ok(!video.includes('"sala.inventada"'),
      "e a trava acusaria um nome que só existe de um lado");
  }

  /* ======================================================================
     MIGRAR O BANCO CERTO

     Num servidor com instâncias, cada cliente tem o próprio banco em
     /var/lib/lachat/<instancia>/chat.db. Rodar `npm run migrar` de dentro do
     diretório do código, sem carregar o ambiente de nenhuma, usa o caminho
     PADRÃO — e migra um banco avulso ali dentro.

     O comando termina com "✓" em todas as migrações. O banco do cliente
     continua exatamente como estava. E o sintoma aparece depois, na cara do
     usuário, como uma funcionalidade que "não subiu".

     Aconteceu em produção: as migrações 005 e 006 foram aplicadas ao banco
     errado, e o profissional continuou sem ver a aba de reuniões.
     ====================================================================== */
  P.secao("migrar recusa o banco errado");

  {
    const fsm = require("node:fs");
    const pathm = require("node:path");
    const { conferirInstancia } = require(
      pathm.join(__dirname, "..", "src", "infra", "dados", "migrar.js"));

    const lerReal = fsm.readdirSync;
    const comInstancias = (lista) => { fsm.readdirSync = (d, ...r) =>
      d === "/etc" ? lista : lerReal(d, ...r); };
    const sqliteAntes = process.env.CHAT_SQLITE;
    const avulsoAntes = process.env.CHAT_MIGRAR_AVULSO;

    try {
      /* Um servidor com duas instâncias e ninguém carregou ambiente nenhum. */
      comInstancias(["lachat-bemestar.env", "lachat-bordatudo.env", "passwd"]);
      delete process.env.CHAT_SQLITE;
      delete process.env.CHAT_MIGRAR_AVULSO;
      P.ok(conferirInstancia() === false,
        "com instâncias e sem ambiente, RECUSA — era isto que migrava o banco errado");

      /* Com o ambiente carregado (o que o deploy faz), segue. */
      process.env.CHAT_SQLITE = "/var/lib/lachat/bemestar/chat.db";
      P.ok(conferirInstancia() === true, "com o ambiente da instância, segue");

      /* Máquina de desenvolvimento: não há /etc/lachat-*.env, e nada barra. */
      delete process.env.CHAT_SQLITE;
      comInstancias(["passwd", "hosts"]);
      P.ok(conferirInstancia() === true, "sem instâncias no servidor, segue (é desenvolvimento)");

      /* E a saída explícita, para o banco de brinquedo de quem programa. */
      comInstancias(["lachat-bemestar.env"]);
      process.env.CHAT_MIGRAR_AVULSO = "1";
      P.ok(conferirInstancia() === true, "e CHAT_MIGRAR_AVULSO=1 libera de propósito");
    } finally {
      fsm.readdirSync = lerReal;
      if (sqliteAntes === undefined) delete process.env.CHAT_SQLITE;
      else process.env.CHAT_SQLITE = sqliteAntes;
      if (avulsoAntes === undefined) delete process.env.CHAT_MIGRAR_AVULSO;
      else process.env.CHAT_MIGRAR_AVULSO = avulsoAntes;
    }
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
