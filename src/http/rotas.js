/* ==========================================================================
   http/rotas.js — o roteamento

   Node puro, como todo o parque: um `switch` sobre método e caminho, sem
   framework. O roteamento é de propósito BURRO — uma tabela que casa padrões
   simples. Roteador esperto (com middlewares encadeados, wildcards e ordem de
   precedência) é onde nascem os furos de autorização, porque fica difícil
   responder "esta rota exige sessão?" só olhando.

   Aqui a resposta é visível: existe UMA lista de rotas públicas. Tudo que não
   está nela exige sessão, e a conferência acontece antes do despacho.
   ========================================================================== */
"use strict";

const { responder, responderErro, lerCorpo, lerJson } = require("./responder.js");
const { erros } = require("../dominio/erros.js");
const { ehUlid } = require("../dominio/ids.js");

/* ==========================================================================
   AS ÚNICAS ROTAS SEM SESSÃO.

   Lista curta e explícita. Uma rota nova nasce protegida por padrão — que é o
   contrário do modelo em que se lembra de acrescentar a proteção.
   ========================================================================== */
const PUBLICAS = new Set([
  "POST /entrar",
  "GET /saude",
  "GET /cliente.js",
  /* `POST /elenco` não tem SESSÃO, mas não é aberta: ela exige um passe
     assinado com o segredo compartilhado, exatamente como `/entrar`. Quem a
     chama é o SERVIDOR do hospedeiro, não um navegador — e por isso não há
     cookie nem CSRF a conferir. Ver o tratamento logo abaixo. */
  "POST /elenco",
]);

function criarRotas({ servico, sessoes, conf, porteiro, saude }) {
  /* Casa `/conversas/:id/mensagens` sem regex por rota. Devolve os pedaços do
     caminho; quem trata confere o formato de cada id com `ehUlid`. */
  const pedacos = (caminho) => caminho.split("/").filter(Boolean);

  async function tratar(req, res, caminho, url) {
    const metodo = req.method.toUpperCase();
    const p = pedacos(caminho);
    const chave = `${metodo} /${p.join("/")}`;

    /* ------------------------------------------------------------------ CORS
       O `OPTIONS` é respondido antes de qualquer outra coisa: ele é o
       pré-voo do navegador e não deve passar por sessão nem por CSRF. */
    const cors = porteiro.cabecalhosCors(req);
    if (metodo === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }

    if (!porteiro.aceitaHttp(req))
      return responder(res, 403, { erro: "Origem não autorizada.", codigo: "origem" }, cors);

    /* --------------------------------------------------------------- saúde */
    if (chave === "GET /saude") {
      const s = await saude();
      return responder(res, s.ok ? 200 : 503, s, cors);
    }

    /* --------------------------------------------------------------- entrar */
    if (chave === "POST /entrar") {
      const corpo = await lerJson(req, 8 * 1024);
      const r = await servico.entrar({
        passe: corpo.passe,
        ip: req.ipReal,
        agente: req.headers["user-agent"] || "",
      });
      return responder(res, 200, { ok: true, usuario: r.usuario },
        { ...cors, "Set-Cookie": r.cookies });
    }

    /* ==========================================================================
       O ELENCO — quem existe no sistema do hospedeiro

       O PROBLEMA QUE ELA RESOLVE: até aqui, o chat só conhecia quem já tinha
       entrado nele. Numa clínica com oito pessoas, a primeira a abrir o chat
       via "Ninguém por aqui ainda" e não tinha com quem falar — e ninguém
       entra num chat vazio, então ele nunca se povoava. Um problema de partida
       a frio que se resolvia sozinho só depois de todo mundo entrar uma vez,
       o que é a mesma coisa que nunca.

       Quem chama é o SERVIDOR do site (pelo conector), não o navegador. A
       prova de quem está falando é o mesmo passe assinado do `/entrar`: sem o
       segredo compartilhado não se forja um, e com ele já se poderia entrar
       como qualquer pessoa de qualquer jeito. Não há privilégio novo aqui.

       O passe de elenco carrega `elenco: true` e a lista vai no corpo — o
       corpo é conferido DEPOIS da assinatura, como em todo o resto.
       ========================================================================== */
    if (chave === "POST /elenco") {
      const corpo = await lerJson(req, 256 * 1024);
      const r = await servico.sincronizarElenco({
        passe: corpo.passe,
        usuarios: corpo.usuarios,
        ip: req.ipReal,
      });
      return responder(res, 200, r, cors);
    }

    /* ==========================================================================
       DAQUI PARA BAIXO, TUDO EXIGE SESSÃO
       ========================================================================== */
    const publica = PUBLICAS.has(chave) || (metodo === "GET" && p[0] === "cliente.js");
    const sessao = await sessoes.de(req);
    if (!publica && !sessao) throw erros.naoAutenticado();

    /* ==========================================================================
       CSRF EM TODA ESCRITA

       GET e HEAD não passam porque não mudam nada. A conferência vem ANTES do
       despacho — se ficasse dentro de cada rota, bastaria uma rota nova
       esquecer, e rotas novas são justamente as que ninguém revisa duas vezes.
       ========================================================================== */
    /* `sessao &&` não é redundante: acima, uma rota PÚBLICA passa mesmo sem
       sessão. Hoje a única pública que escreve (`POST /entrar`) já retornou
       antes de chegar aqui — mas se alguém acrescentar outra amanhã, sem esta
       guarda o acesso a `sessao.sessaoId` estouraria em 500 numa rota de
       autenticação. Erro 500 em rota pública é indisponibilidade barata de
       provocar. */
    if (sessao && !["GET", "HEAD"].includes(metodo)) {
      const c = sessoes.conferirCsrf(req, sessao.sessaoId);
      if (!c.ok) return responder(res, 403, { erro: "Sessão inválida. Recarregue a página.", codigo: "csrf" }, cors);
    }

    const ok = (corpo, extra = {}) => responder(res, 200, corpo, { ...cors, ...extra });

    switch (chave) {
      /* ---------------------------------------------------------- sessão */
      case "POST /sair": {
        const cookies = await servico.sair(req, sessao);
        return responder(res, 200, { ok: true }, { ...cors, "Set-Cookie": cookies });
      }

      case "GET /eu":
        return ok(await servico.eu(sessao));

      /* O bilhete do WebSocket. Só se chega aqui com cookie + CSRF + Origem
         conferidos — é isso que dá ao bilhete o valor que ele tem. */
      case "POST /bilhete":
        return ok({ bilhete: sessoes.emitirBilhete(sessao), validadeMs: 30_000 });

      /* ------------------------------------------------------- conversas */
      case "GET /conversas":
        return ok({ conversas: await servico.listarConversas(sessao) });

      case "POST /conversas/direta": {
        const c = await lerJson(req);
        return ok(await servico.abrirDireta(sessao, String(c.usuarioId || "")));
      }

      case "POST /conversas/grupo": {
        const c = await lerJson(req);
        return ok(await servico.criarGrupo(sessao, { titulo: c.titulo, membros: c.membros }));
      }

      /* ---------------------------------------------------------- busca */
      case "GET /busca":
        return ok(await servico.buscar(sessao, url.searchParams.get("q"), {
          conversaId: url.searchParams.get("conversa") || null,
        }));

      case "GET /pessoas":
        return ok({ pessoas: await servico.pessoas(sessao, url.searchParams.get("q")) });

      /* -------------------------------------------------------- perfil */
      case "POST /status": {
        const c = await lerJson(req);
        return ok(await servico.definirStatus(sessao, String(c.status || "")));
      }

      case "PATCH /preferencias": {
        const c = await lerJson(req);
        return ok(await servico.atualizarPreferencias(sessao, c));
      }

      /* ------------------------------------------------------ arquivos */
      case "POST /arquivos":
        return ok(await receberArquivo(req, sessao, url));

      /* --------------------------------------------------- administração */
      case "GET /admin/auditoria":
        return ok({ eventos: await servico.auditoria(sessao, {
          evento: url.searchParams.get("evento") || null,
          limite: Number(url.searchParams.get("limite")) || 100,
        }) });

      default:
        break;
    }

    /* ==========================================================================
       ROTAS COM ID NO CAMINHO
       ========================================================================== */

    /* /pessoas/:id */
    if (metodo === "GET" && p[0] === "pessoas" && p.length === 2)
      return ok(await servico.perfilDe(sessao, p[1]));

    /* /arquivos/:id  — o download */
    if (metodo === "GET" && p[0] === "arquivos" && p.length === 2)
      return enviarArquivo(req, res, sessao, p[1], cors, false);

    /* /arquivos/:id/previa — a imagem, para a bolha mostrar em vez de um link */
    if (metodo === "GET" && p[0] === "arquivos" && p[2] === "previa" && p.length === 3)
      return enviarArquivo(req, res, sessao, p[1], cors, true);

    /* /conversas/:id/... */
    if (p[0] === "conversas" && p.length >= 3) {
      const conversaId = p[1];
      if (!ehUlid(conversaId)) throw erros.naoEncontrado();

      if (metodo === "GET" && p[2] === "mensagens" && p.length === 3) {
        return ok(await servico.historico(sessao, conversaId, {
          antesDeSeq: url.searchParams.get("antes"),
          limite: url.searchParams.get("limite"),
        }));
      }

      if (metodo === "POST" && p[2] === "mensagens" && p.length === 3) {
        const c = await lerJson(req);
        const r = await servico.enviarMensagem(sessao, {
          conversaId,
          texto: c.texto,
          idCliente: c.idCliente,
          respondeA: c.respondeA || null,
          anexos: Array.isArray(c.anexos) ? c.anexos : [],
        });
        return ok({ mensagem: r.mensagem, repetida: r.repetida });
      }

      if (metodo === "POST" && p[2] === "lida" && p.length === 3) {
        const c = await lerJson(req);
        return ok(await servico.marcarLida(sessao, conversaId, c.seq));
      }

      if (metodo === "POST" && p[2] === "digitando" && p.length === 3)
        return ok(await servico.digitando(sessao, conversaId));

      if (metodo === "DELETE" && p[2] === "mensagens" && p.length === 4)
        return ok(await servico.apagarMensagem(sessao, conversaId, p[3]));

      if (metodo === "PATCH" && p[2] === "mensagens" && p.length === 4) {
        const c = await lerJson(req);
        return ok(await servico.editarMensagem(sessao, conversaId, p[3], c.texto));
      }
    }

    /* /admin/usuarios/:id/bloquear */
    if (metodo === "POST" && p[0] === "admin" && p[1] === "usuarios" && p[3] === "bloquear") {
      const c = await lerJson(req);
      return ok(await servico.bloquearUsuario(sessao, p[2], c.bloquear !== false));
    }

    throw erros.naoEncontrado();
  }

  /* ==========================================================================
     UPLOAD — corpo binário cru, sem multipart

     DECISÃO DELIBERADA: não há analisador de `multipart/form-data` neste
     projeto.

     Analisar multipart à mão é escrever um parser de protocolo binário
     alimentado pela internet — a mesma categoria de risco que fez o WebSocket
     usar a biblioteca `ws` em vez de código próprio. E as bibliotecas de
     multipart trazem, historicamente, sua própria fila de CVEs (travessia de
     diretório pelo nome do arquivo, exaustão de memória por parte sem fim,
     confusão de fronteira).

     Aqui o navegador manda o ARQUIVO CRU no corpo (`fetch(url, {body: file})`)
     e os metadados vão em cabeçalho e query. Não há fronteira para analisar,
     não há parte sem fim, não há nome de arquivo interpretado como caminho.

     O nome vai em BASE64 num cabeçalho. Cabeçalho HTTP não aceita quebra de
     linha nem caractere fora do ASCII: um nome com acento quebraria, e um nome
     com `\r\n` permitiria injetar cabeçalhos. Base64 elimina os dois.
     ========================================================================== */
  async function receberArquivo(req, sessao, url) {
    const conversaId = url.searchParams.get("conversa") || "";
    if (!ehUlid(conversaId)) throw erros.naoEncontrado();

    let nome = "arquivo";
    const cabecalho = req.headers["x-arquivo-nome"];
    if (cabecalho) {
      try { nome = Buffer.from(String(cabecalho), "base64").toString("utf8").slice(0, 300); }
      catch { throw erros.invalido("Nome de arquivo inválido."); }
    }

    const tipo = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();

    /* O teto de leitura é o do arquivo + uma folga pequena. Sem folga, um
       arquivo exatamente no limite seria recusado pelo leitor com a mensagem
       errada ("conteúdo grande demais" em vez de "arquivo grande demais"). */
    const buffer = await lerCorpo(req, conf.arquivos.tamanhoMaximo + 1024);

    return servico.enviarArquivo(sessao, { conversaId, nome, tipo, buffer });
  }

  /* ==========================================================================
     DOWNLOAD

     Três cabeçalhos que não são detalhe:

     · `attachment`  — o navegador BAIXA em vez de ABRIR. É o que impede um
       arquivo enviado por um colega de executar no domínio do chat.
     · `nosniff`     — impede o navegador de adivinhar o tipo e "melhorar" a
       decisão acima.
     · `filename*`   — a forma RFC 5987, que é a única que aceita acento. O
       `filename=` simples fica junto, com o nome já sem caractere especial,
       para navegador antigo.
     ========================================================================== */
  async function enviarArquivo(req, res, sessao, anexoId, cors, previa = false) {
    const { anexo, fluxo } = await servico.baixarArquivo(sessao, anexoId, { previa });

    const simples = anexo.nome.replace(/[^\w.\- ]/g, "_");

    /* ======================================================================
       DUAS SAÍDAS, DELIBERADAMENTE DIFERENTES.

       DOWNLOAD: `application/octet-stream` + `attachment`. O navegador BAIXA
       em vez de abrir — é o que impede um arquivo enviado por um colega de
       executar no domínio do chat.

       PRÉVIA: o tipo REAL + `inline`, e só para imagem (a camada de aplicação
       já recusou qualquer outra coisa). Sem o tipo real, o `<img>` não
       renderiza: `application/octet-stream` com `nosniff` é justamente o que
       manda o navegador NÃO adivinhar — e ele obedece.

       `nosniff` fica nos dois. Na prévia ele deixa de ser um empecilho e passa
       a ser a garantia: o navegador vai tratar como exatamente o tipo que
       declaramos, que é o tipo que os bytes provaram ser no envio.
       ====================================================================== */
    const cabecalhos = previa
      ? {
          "Content-Type": anexo.tipo,
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(anexo.nome)}`,
          /* Cacheável no navegador, e PRIVADO: a imagem não pode ficar num
             cache compartilhado, onde outra pessoa a alcançaria sem passar
             pela conferência de membro. `immutable` porque o id é um ULID —
             aquele anexo nunca muda de conteúdo. */
          "Cache-Control": "private, max-age=86400, immutable",
        }
      : {
          "Content-Type": "application/octet-stream",
          "Content-Disposition":
            `attachment; filename="${simples}"; filename*=UTF-8''${encodeURIComponent(anexo.nome)}`,
          "Cache-Control": "private, no-store",
        };

    res.writeHead(200, {
      ...cors,
      "Content-Length": anexo.tamanho,
      "X-Content-Type-Options": "nosniff",
      ...cabecalhos,
    });

    /* Erro no meio do fluxo: os cabeçalhos já foram enviados, então não há
       como devolver um JSON de erro. O certo é DERRUBAR a conexão — assim o
       navegador marca o download como incompleto, em vez de salvar um arquivo
       truncado como se estivesse inteiro. */
    fluxo.on("error", (e) => {
      console.error("  ✖ leitura de anexo:", e.message);
      try { res.destroy(); } catch { }
    });
    /* Se quem baixa desiste no meio, o fluxo tem de ser fechado — senão o
       descritor de arquivo fica aberto até o processo morrer. */
    res.on("close", () => { try { fluxo.destroy(); } catch { } });

    fluxo.pipe(res);
  }

  return { tratar, PUBLICAS };
}

module.exports = { criarRotas, PUBLICAS };
