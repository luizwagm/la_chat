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

function rodar() {
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
  const ok = rodar();
  process.exitCode = ok ? 0 : 1;
}

module.exports = { rodar };
