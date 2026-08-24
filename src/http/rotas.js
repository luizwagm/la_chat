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
const fs = require("node:fs");
const path = require("node:path");

/* ==========================================================================
   A PÁGINA DO CONVIDADO

   O ÚNICO HTML que este serviço entrega. Ela é servida SEM NADA INTERPOLADO:
   o código da sala não entra no HTML, a página o lê do próprio endereço.
   Isso não é economia de esforço — é o que torna XSS impossível aqui por
   construção, em vez de por escapamento correto. Um dia alguém acrescenta um
   campo "titulo" na interpolação e esquece o escape; sem interpolação
   nenhuma, esse dia não chega.

   O cabeçalho `Content-Security-Policy` é mais apertado que o do resto do
   serviço porque esta página é a superfície aberta: sem `unsafe-inline`, sem
   origem externa, e `connect-src` limitado a si mesma. O WebRTC precisa de
   `webrtc-src`? Não — mídia peer-to-peer não passa por CSP de conexão; o que
   passa é o STUN/TURN, e esse é o navegador quem faz, fora do documento.
   ========================================================================== */
const CSP_DA_SALA = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",   /* o componente usa <style> no shadow */
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

let htmlDaSala = null;

function paginaDaSala(res, codigo, conf) {
  /* Código fora de forma não chega a ler arquivo nenhum. */
  if (typeof codigo !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{11}$/.test(codigo))
    return responder(res, 404, { erro: "Link inválido ou expirado." });

  if (!conf.video?.ativo)
    return responder(res, 404, { erro: "Não encontrado." });

  try {
    if (!htmlDaSala || process.env.NODE_ENV !== "production")
      htmlDaSala = fs.readFileSync(path.join(conf.caminhos.publico, "sala.html"));
  } catch {
    return responder(res, 500, { erro: "Página indisponível." });
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": htmlDaSala.length,
    "Content-Security-Policy": CSP_DA_SALA,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    /* `noindex` importa: um link de reunião no índice de busca é um link de
       reunião entregue a quem nunca o recebeu. */
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  return res.end(htmlDaSala);
}

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

/* ==========================================================================
   O PORTÃO DO CONVIDADO — lista branca, e o padrão é RECUSAR

   O convidado tem uma sessão própria (`seguranca/convidado.js`), e as rotas do
   chat não a consultam. Mas o roteador consulta as duas — e sem esta função a
   pergunta voltaria a ser "há sessão?", que é exatamente o erro que a sessão
   separada existe para evitar.

   Aqui a pergunta é "quem é, e para onde essa identidade vale?". Uma rota nova
   nasce PROIBIDA para convidado; liberá-la é um ato deliberado, nesta lista,
   revisável de uma olhada.

   O que ele pode, e nada além:
     · entrar, sair, mudo/câmera e credenciais de UMA chamada;
     · pedir o bilhete do WebSocket (o transporte confere o resto);
     · sair da sala.

   O que ele NÃO pode, e é o ponto: conversas, mensagens, busca, pessoas,
   perfil, anexos, elenco, administração e criação de salas.
   ========================================================================== */
function convidadoPode(metodo, p) {
  /* /chamadas/:id/<acao> — o `:id` é conferido adiante; aqui só a AÇÃO. */
  if (p[0] === "chamadas" && p.length === 3)
    return ["entrar", "sair", "dispositivos", "credenciais"].includes(p[2]);

  /* O bilhete do socket. O transporte confere origem, unicidade e teto; e o
     que o convidado consegue fazer pelo socket é limitado pelas mesmas regras
     de chamada (ele só sinaliza para quem está DENTRO da chamada dele). */
  if (metodo === "POST" && p[0] === "bilhete" && p.length === 1) return true;

  /* As rotas da própria sala. `/call/:codigo` e `/call/:codigo/entrar` são
     públicas de qualquer forma — não exigem sessão nenhuma. */
  if (p[0] === "call") return true;

  return false;
}


function criarRotas({ servico, chamadas, salas, sessoes, convidados, conf, porteiro, saude }) {
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
       A SALA POR LINK — as ÚNICAS rotas do sistema que respondem sem credencial

       `/call/:codigo` e `/call/:codigo/entrar` são alcançáveis por qualquer um
       que tenha o link. É a superfície mais exposta que este projeto tem, e por
       isso ela é curta, com freio próprio por IP (em aplicacao/salas.js) e com
       respostas deliberadamente vagas: inexistente, revogada e expirada
       devolvem a MESMA frase, para tentativa e erro não virar mapa.
       ========================================================================== */
    if (p[0] === "call" && p.length >= 2) {
      const codigo = p[1];

      /* A página do convidado. Sem sessão, sem cookie, sem nada.

         `responder` direto, e não o atalho `ok`: este bloco roda ANTES da
         conferência de sessão, e o atalho só existe depois dela. Usá-lo aqui
         estouraria em ReferenceError na única rota que qualquer estranho
         alcança — que é o pior lugar possível para um 500. */
      /* A PÁGINA e a API não dividem endereço.

         `/call/<codigo>` é o que a pessoa cola no navegador: devolve HTML.
         `/call/<codigo>/info` é o que a página consulta: devolve JSON.

         A alternativa — o mesmo endereço servindo os dois conforme o
         cabeçalho `Accept` — parece elegante e é frágil: um proxy que
         normaliza `Accept`, um cache que ignora `Vary`, ou um leitor de
         link de mensageiro faz a página virar JSON na cara do convidado. */
      if (metodo === "GET" && p.length === 2) {
        /* A BARRA NO FIM MUDA O SIGNIFICADO DE `../`.

           `/chat/call/abc` e `/chat/call/abc/` casam o mesmo padrão aqui —
           `filter(Boolean)` come o pedaço vazio — mas o navegador resolve os
           `<script src="../…">` da página de forma DIFERENTE nos dois: no
           segundo, `../cliente.js` vira `/chat/call/cliente.js` e a página
           carrega sem componente nenhum. Tela em branco, sem erro visível.

           Um endereço canônico, então, e um redirecionamento para ele. */
        if (caminho.endsWith("/")) {
          res.writeHead(301, {
            Location: conf.prefixo + "/call/" + encodeURIComponent(codigo),
            "Cache-Control": "no-store",
          });
          return res.end();
        }
        return paginaDaSala(res, codigo, conf);
      }

      if (metodo === "GET" && p[2] === "info" && p.length === 3)
        return responder(res, 200, await salas.info(codigo, { ip: req.ipReal }), cors);

      /* RETOMAR. Lê o cookie do convidado e devolve a identidade que já
         existe — é o que faz recarregar a página no celular não virar uma
         pessoa nova, com nome pedido de novo e mais uma vaga gasta. */
      if (metodo === "GET" && p[2] === "eu" && p.length === 3) {
        const cvd = convidados.de(req);
        if (!cvd) return responder(res, 401, { erro: "Sem sessão." }, cors);
        return responder(res, 200, await salas.retomar(cvd, codigo), cors);
      }

      if (metodo === "POST" && p[2] === "entrar" && p.length === 3) {
        const c = await lerJson(req, 4 * 1024);
        const r = await salas.entrar({
          codigo,
          nome: c.nome,
          ip: req.ipReal,
          agente: req.headers["user-agent"] || "",
        });
        /* O cookie do convidado sai AQUI, e só aqui. */
        return responder(res, 200, {
          eu: r.eu, sala: r.sala, chamada: r.chamada,
        }, { ...cors, "Set-Cookie": r.cookies });
      }

      if (metodo === "POST" && p[2] === "sair" && p.length === 3) {
        const cookies = convidados.encerrar(req);
        return responder(res, 200, { ok: true }, { ...cors, "Set-Cookie": cookies });
      }
    }

    /* ==========================================================================
       DAQUI PARA BAIXO, TUDO EXIGE SESSÃO
       ========================================================================== */
    const publica = PUBLICAS.has(chave) || (metodo === "GET" && p[0] === "cliente.js")
      || p[0] === "call";

    /* ==========================================================================
       QUEM É — e não apenas "há sessão?"

       A sessão de funcionário é tentada primeiro. Se não houver, tenta-se a de
       CONVIDADO, que é outra coisa: vale para uma sala e nada mais.

       O portão logo abaixo é o que impede a segunda de virar a primeira. Sem
       ele, bastaria existir uma sessão para qualquer rota do chat responder — e
       um convidado leria a lista de pessoas da empresa.
       ========================================================================== */
    /* ==================================================================
       COM QUAL IDENTIDADE ESTE PEDIDO ESTÁ FALANDO?

       Os dois cookies convivem no mesmo navegador, e é o caso NORMAL: um
       funcionário logado no sistema recebe um link de reunião e o abre ali
       mesmo. A partir daí ele tem `cid` (funcionário) e `cvd` (convidado)
       na mesma origem.

       A regra anterior — funcionário primeiro, convidado depois — escolhia a
       identidade errada para a página do convidado. O pedido levava o token
       CSRF do CONVIDADO e era conferido contra a sessão do FUNCIONÁRIO:
       403, sempre. O convidado nunca tirava bilhete, nunca abria o socket, e
       a reunião ficava eternamente em "conectando…".

       Agora quem sabe responde: a página do convidado diz, em cada pedido,
       que fala como convidado. Não é escalada de privilégio — é o
       contrário, um REBAIXAMENTO deliberado, e continua exigindo o cookie
       `cvd` e o CSRF que combina com ele. Quem mandar esse cabeçalho sem ter
       sessão de convidado não ganha nada: fica sem sessão nenhuma.
       ================================================================== */
    const comoConvidado = String(req.headers["x-chat-como"] || "") === "convidado";
    const sessao = comoConvidado
      ? convidados.de(req)
      : ((await sessoes.de(req)) || convidados.de(req));
    if (!publica && !sessao) throw erros.naoAutenticado();

    if (sessao?.ehConvidado && !convidadoPode(metodo, p))
      throw erros.semPermissao("Esta ação não está disponível para convidados.");

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
      /* Cada tipo de sessão confere o PRÓPRIO token: os cookies são
         diferentes, e cruzar os dois faria o token de um valer no outro. */
      const c = sessao.ehConvidado
        ? convidados.conferirCsrf(req)
        : sessoes.conferirCsrf(req, sessao.sessaoId);
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

    /* ==========================================================================
       REUNIÃO

       Tudo que MUDA o estado da chamada passa por HTTP, e não pelo socket:
       aqui já existem sessão, CSRF, limitador e tratamento de erro. Pelo
       socket vai só o `sinal`, que é o único de alta frequência.

       `:id` é sempre conferido como ULID antes de chegar ao banco, e a
       autorização de cada uma delas é a MESMA da conversa — ver
       aplicacao/chamadas.js.
       ========================================================================== */

    /* /conversas/:id/chamada — tem reunião rolando aqui? */
    if (metodo === "GET" && p[0] === "conversas" && p[2] === "chamada" && p.length === 3)
      return ok(await chamadas.daConversa(sessao, p[1]));

    /* Iniciar. Se já houver uma, o serviço ENTRA nela em vez de abrir outra —
       é o desfecho certo para dois cliques simultâneos. */
    if (metodo === "POST" && p[0] === "conversas" && p[2] === "chamada" && p.length === 3)
      return ok(await chamadas.iniciar(sessao, p[1]));

    if (p[0] === "chamadas" && p.length >= 2) {
      const chamadaId = p[1];
      if (!ehUlid(chamadaId)) throw erros.naoEncontrado();

      if (metodo === "POST" && p[2] === "entrar" && p.length === 3)
        return ok(await chamadas.entrar(sessao, chamadaId));

      if (metodo === "POST" && p[2] === "sair" && p.length === 3)
        return ok(await chamadas.sair(sessao, chamadaId));

      if (metodo === "POST" && p[2] === "recusar" && p.length === 3)
        return ok(await chamadas.recusar(sessao, chamadaId));

      if (metodo === "PATCH" && p[2] === "dispositivos" && p.length === 3) {
        const c = await lerJson(req, 4 * 1024);
        return ok(await chamadas.dispositivos(sessao, chamadaId, {
          microfone: c.microfone, camera: c.camera, tela: c.tela,
        }));
      }

      /* Renovar as credenciais do TURN no meio de uma reunião longa. Elas
         valem duas horas; uma reunião que passe disso precisa de novas, ou a
         reconexão de ICE falha justamente quando a rede está ruim. */
      if (metodo === "GET" && p[2] === "credenciais" && p.length === 3)
        return ok(await chamadas.credenciais(sessao, chamadaId));
    }

    /* ==========================================================================
       SALAS — do lado de quem cria. Convidado nunca chega aqui (ver o portão).
       ========================================================================== */
    if (metodo === "POST" && p[0] === "salas" && p.length === 1) {
      const c = await lerJson(req, 4 * 1024);
      return ok(await salas.criar(sessao, {
        titulo: c.titulo,
        duracaoMin: c.duracaoMin,
        validadeH: c.validadeH,
        exigeAnfitriao: c.exigeAnfitriao,
        maxConvidados: c.maxConvidados,
      }));
    }

    if (metodo === "GET" && p[0] === "salas" && p.length === 1)
      return ok({ salas: await salas.minhas(sessao) });

    if (p[0] === "salas" && p.length >= 2) {
      const salaId = p[1];
      if (!ehUlid(salaId)) throw erros.naoEncontrado();

      if (metodo === "DELETE" && p.length === 2)
        return ok(await salas.revogar(sessao, salaId));

      if (metodo === "POST" && p[2] === "abrir" && p.length === 3)
        return ok(await salas.abrir(sessao, salaId));

      if (metodo === "GET" && p[2] === "participantes" && p.length === 3)
        return ok(await salas.participantes(sessao, salaId));

      if (metodo === "POST" && p[2] === "remover" && p.length === 4)
        return ok(await salas.expulsar(sessao, salaId, p[3]));
    }

    /* /pessoas/:id */
    if (metodo === "GET" && p[0] === "pessoas" && p.length === 2)
      return ok(await servico.perfilDe(sessao, p[1]));

    /* /arquivos/:id  — o download */
    if (metodo === "GET" && p[0] === "arquivos" && p.length === 2)
      return enviarArquivo(req, res, sessao, p[1], cors, false);

    /* /arquivos/:id/previa — a imagem, para a bolha mostrar em vez de um link */
    if (metodo === "GET" && p[0] === "arquivos" && p[2] === "previa" && p.length === 3)
      return enviarArquivo(req, res, sessao, p[1], cors, true);

    /* ======================================================================
       ARQUIVAR e REMOVER — o menu de três pontinhos da conversa

       Duas ações que parecem a mesma e não são:

         ARQUIVAR  some da lista de QUEM ARQUIVOU. Qualquer membro pode, e os
                   colegas não são afetados. A mensagem seguinte a traz de
                   volta — arquivar é "não quero ver agora", não "não quero
                   mais falar".

         REMOVER   some para TODO MUNDO, e só o administrador pode. É a única
                   operação do chat que age sobre o histórico dos outros.
       ====================================================================== */
    if (metodo === "POST" && p[0] === "conversas" && p[2] === "arquivar" && p.length === 3) {
      if (!ehUlid(p[1])) throw erros.naoEncontrado();
      const c = await lerJson(req, 1024);
      return ok(await servico.arquivarConversa(sessao, p[1], c.arquivar !== false));
    }

    if (metodo === "DELETE" && p[0] === "conversas" && p.length === 2) {
      if (!ehUlid(p[1])) throw erros.naoEncontrado();
      return ok(await servico.removerConversa(sessao, p[1]));
    }

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
