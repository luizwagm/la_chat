/* ==========================================================================
   LA CHAT — servidor

       npm run migrar     cria/atualiza o banco
       npm start          sobe o serviço

   Este arquivo faz UMA coisa: montar as peças e ligá-las. Nenhuma regra de
   negócio mora aqui — se aparecer um `if` sobre mensagem ou conversa neste
   arquivo, ele está no lugar errado.

   A ordem de montagem importa e está comentada onde não é óbvia.
   ========================================================================== */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { CONF, conferir } = require("./config.js");

/* Recusar-se a subir errado, ANTES de abrir banco ou porta. Um serviço que
   sobe sem segredo e sem lista de origens funciona perfeitamente — inclusive
   para o atacante — e é por isso que a conferência é uma parada, não um aviso. */
if (!conferir()) process.exit(1);

const { abrir } = require("./src/infra/dados/banco.js");
const { migrar } = require("./src/infra/dados/migrar.js");
const { montar } = require("./src/infra/dados/repositorios/index.js");
const { criarPasses } = require("./src/infra/seguranca/passe.js");
const { criarSessoes } = require("./src/infra/seguranca/sessao.js");
const { criarLimites } = require("./src/infra/seguranca/limites.js");
const { criarPorteiro } = require("./src/infra/seguranca/origem.js");
const { ipDe, ipEmHash, ehLoopback } = require("./src/infra/seguranca/ip.js");
const armazenamento = require("./src/infra/storage/armazenamento.js");
const barramentoModulo = require("./src/infra/eventos/barramento.js");
const { criarServico } = require("./src/aplicacao/chat.js");
const { criarServicoDeChamadas } = require("./src/aplicacao/chamadas.js");
const { criarTurn } = require("./src/infra/seguranca/turn.js");
const { criarServicoDeSalas } = require("./src/aplicacao/salas.js");
const { criarConvidados } = require("./src/infra/seguranca/convidado.js");
const { criarTransporteWS, ligarAoBarramento } = require("./src/infra/realtime/websocket.js");
const { criarRotas } = require("./src/http/rotas.js");
const { responder, responderErro } = require("./src/http/responder.js");

async function principal() {
  /* ------------------------------------------------------------------ dados */
  const Q = abrir(CONF.banco);
  await migrar({ Q, silencioso: true });

  const repos = montar(Q, {
    segredoBusca: CONF.segredos.busca,
    registrarIp: CONF.auditoria.registrarIp,
  });

  /* Contadores de presença zerados na partida: as conexões que existiam eram
     de OUTRO processo. O sinal de vida (`expira_em`) continua expirando
     sozinho, então ninguém fica preso em "online". */
  await repos.presenca.zerarContadores().catch(() => { });

  /* -------------------------------------------------------------- segurança */
  const passes = criarPasses({
    segredo: CONF.segredos.passe,
    validadeSegundos: CONF.sessao.passeSegundos,
  });

  const sessoes = criarSessoes({
    repo: repos.sessoes,
    segredo: CONF.segredos.passe,
    cookie: CONF.sessao.cookie,
    duracaoHoras: CONF.sessao.horas,
    seguro: CONF.producao,
    entreSites: CONF.entreSites,
    /* O cookie de sessão fica preso às rotas do chat — ver sessao.js. */
    caminho: CONF.prefixo,
  });

  const limites = criarLimites();
  const porteiro = criarPorteiro(CONF.origensPermitidas, CONF.base);
  const hashDeIp = (ip) => ipEmHash(ip, CONF.segredos.passe);

  /* --------------------------------------------------------------- storage */
  const disco = armazenamento.criar({ driver: "local", pasta: CONF.arquivos.pasta });

  /* -------------------------------------------------------------- aplicação */
  const barramento = barramentoModulo.criar();

  const servico = criarServico({
    repos, conf: CONF, barramento, limites,
    armazenamento: disco, sessoes, passes, ipEmHash: hashDeIp,
  });

  /* ----------------------------------------------------------------- vídeo
     O TURN é montado mesmo com o vídeo desligado: assim `verificar.sh` e a
     suíte conseguem conferir a conta da credencial sem ligar o recurso. */
  const turn = criarTurn({
    urls: CONF.video.turn,
    segredo: CONF.video.turnSegredo,
    stun: CONF.video.stun,
    ttlSegundos: CONF.video.turnTtl,
    soRelay: CONF.video.soRelay,
  });

  const chamadas = criarServicoDeChamadas({
    repos, conf: CONF, barramento, limites, turn,
    /* A autorização da reunião é a MESMA da conversa. Passar a função em vez
       de reimplementar é o que garante que as duas nunca divirjam. */
    exigirMembro: servico.exigirMembro,
  });

  /* ------------------------------------------------------------ sala por link
     A sessão de CONVIDADO é montada em separado da de funcionário — e é essa
     separação que impede quem entra por link de alcançar o chat da empresa.
     Ver seguranca/convidado.js. */
  const convidados = criarConvidados({
    segredo: CONF.segredos.passe,
    seguro: CONF.producao,
    entreSites: CONF.entreSites,
    caminho: CONF.prefixo,
  });

  const salas = criarServicoDeSalas({
    repos, conf: CONF, barramento, limites, convidados,
    chamadas, servicoChat: servico, ipEmHash: hashDeIp,
  });

  /* --------------------------------------------------------------- realtime */
  const transporte = criarTransporteWS({
    conf: CONF, porteiro, sessoes, servico, chamadas, repos, limites,
    ipDe: (req) => ipDe(req, CONF.proxiesConfiaveis),
    ipEmHash: hashDeIp,
  });

  ligarAoBarramento({ barramento, transporte, EVENTOS: barramentoModulo.EVENTOS });

  /* ==========================================================================
     SAÚDE (§44)

     Diz se cada peça responde — e NADA além disso. Sem versão de biblioteca,
     sem caminho de arquivo, sem nome de banco, sem contagem de usuários. Um
     health check detalhado é reconhecimento gratuito para quem procura alvo.
     ========================================================================== */
  async function saude() {
    const partes = { banco: "erro", storage: "erro", realtime: "ok" };
    try { await Q.saude(); partes.banco = "ok"; } catch { }
    try { partes.storage = fs.existsSync(CONF.arquivos.pasta) ? "ok" : "erro"; } catch { }
    const ok = Object.values(partes).every((v) => v === "ok");

    /* A VERSÃO NÃO SAI EM PRODUÇÃO.

       O health check é público — tem de ser, para um monitor externo alcançá-lo
       sem credencial. E versão exata é a primeira coisa que se procura ao
       escolher um alvo: ela diz quais falhas conhecidas podem valer a tentativa.

       Em desenvolvimento ela continua saindo, porque ali serve para conferir
       se o deploy subiu o que se esperava. */
    return CONF.producao ? { ok, ...partes } : { ok, versao: CONF.versao, ...partes };
  }

  /* ==========================================================================
     A TRAVA CONTRA `CHAT_PROXIES` ERRADO

     Um número errado aqui não quebra nada visivelmente — ele só faz o
     limitador e a auditoria pararem de distinguir as pessoas. É o tipo de
     defeito que ninguém descobre até precisar do log.

     Este aviso dispara UMA vez por processo, quando o IP resolvido de um
     VISITANTE é loopback em produção. Não é palpite: um cliente de verdade
     nunca chega de 127.0.0.1 através do nginx.

     ---------------------------------------------------------------------
     E NEM TODA REQUISIÇÃO É DE UM VISITANTE.

     A sincronização de elenco chega do PRÓPRIO SITE, servidor a servidor, em
     127.0.0.1 e sem `X-Forwarded-For` nenhum. Ela é loopback porque É loopback
     — não porque a configuração esteja errada.

     Sem esta distinção, todo servidor bem configurado acusava
     "CHAT_PROXIES parece ERRADO" no primeiro boot do site, e o `verificar.sh`
     repetia o erro para quem fosse conferir a instalação. Um alarme que dispara
     sozinho é um alarme que se aprende a ignorar — e aí o dia em que ele estiver
     certo não vai adiantar.

     A pergunta correta é: veio uma CADEIA de proxies e, mesmo assim, o IP saiu
     loopback? Isso sim é ter pulado saltos demais.
     ========================================================================== */
  let avisouProxies = false;
  function conferirProxies(req) {
    if (avisouProxies || !CONF.producao) return;
    if (!ehLoopback(req.ipReal)) return;
    /* Sem `X-Forwarded-For` não houve proxy: é chamada interna, não visitante. */
    if (!req.headers["x-forwarded-for"]) return;
    avisouProxies = true;
    console.error(`
  ✖ CHAT_PROXIES parece ERRADO (valor atual: ${CONF.proxiesConfiaveis}).

    O IP resolvido de um visitante veio como ${req.ipReal}, que é loopback —
    em produção isso nunca acontece com um cliente de verdade.

    Consequência: o limitador de força bruta conta TODA a empresa como um
    endereço só (uma pessoa errando a senha tranca todo mundo junto), e a
    auditoria grava o mesmo hash para todos.

    Quantos saltos existem na frente deste serviço?
        nginx  ->  chat                      CHAT_PROXIES=1
        nginx  ->  site (conector)  ->  chat  CHAT_PROXIES=2   <- arranjo A
`);
  }

  /* ==========================================================================
     VÍDEO LIGADO E SEM RELAY — o aviso que evita um chamado

     De 15% a 20% das chamadas não fecham direto, e essa fatia NÃO é aleatória:
     concentra-se em rede corporativa, que é o público deste chat. O sintoma é
     "às vezes não conecta" — intermitente, no cliente que mais importa, e quase
     impossível de diagnosticar por telefone.

     E desde a reunião por link há um segundo motivo: sem TURN, a sala não
     consegue forçar o relay, e os participantes passam a ver o IP uns dos
     outros — inclusive o estranho que recebeu o convite.

     O serviço SOBE assim mesmo. Recusar seria pior: uma instalação em rede
     local, para testar, é legítima. Mas ninguém deve descobrir isso pelo
     cliente reclamando.
     ========================================================================== */
  if (CONF.video.ativo && !CONF.video.turn.length) {
    console.warn(`
  ⚠  VÍDEO LIGADO SEM TURN

     De 15% a 20% das chamadas vão falhar, concentradas em rede corporativa.
     E a reunião por link não consegue forçar o relay: os participantes vão
     ver o endereço IP uns dos outros, o convidado de fora inclusive.

     Configure CHAT_TURN e CHAT_TURN_SEGREDO — ver docs/VIDEO.md.
`);
  }

  const rotas = criarRotas({ servico, chamadas, salas, sessoes, convidados,
    conf: CONF, porteiro, saude });

  /* ==========================================================================
     O CLIENTE

     Servido por ESTE serviço, e não copiado para dentro do site do hospedeiro:
     assim uma correção no chat chega a todas as instalações sem ninguém
     recopiar arquivo. É a mesma razão de o conector ser fino.
     ========================================================================== */
  const arquivoCliente = path.join(CONF.caminhos.publico, "la-chat.js");
  const arquivoVideo = path.join(CONF.caminhos.publico, "la-chat-video.js");

  /* ==========================================================================
     SERVIDOR HTTP
     ========================================================================== */
  const servidor = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, CONF.base);
    } catch {
      return responder(res, 400, { erro: "Requisição inválida." });
    }

    /* O IP real, calculado UMA vez e anexado. Sem isso, cada lugar que precisa
       dele repetiria a leitura de X-Forwarded-For — e uma dessas repetições
       acabaria fazendo do jeito errado (ver seguranca/ip.js). */
    req.ipReal = ipDe(req, CONF.proxiesConfiaveis);
    conferirProxies(req);

    const caminho = decodeURIComponent(url.pathname);

    /* ==========================================================================
       O LINK CURTO — `/call/<codigo>`, sem o prefixo

       O convite que uma pessoa recebe é `site.com/call/aBc…`. Curto, sem
       `/chat` no meio, e é o que foi pedido. Mas TODO o resto do chat vive
       sob o prefixo, e a página do convidado precisa falar com essa API:
       servir a página no endereço curto a deixaria procurando `/bilhete` e
       `/chamadas/…` na raiz do site do cliente, onde não há nada.

       Um redirecionamento resolve os dois lados sem conflito: o link curto é
       o que circula, e o navegador termina sob o prefixo, onde a página e a
       API se enxergam. Vale igual para quem chega direto neste serviço e
       para quem chega pelo conector do hospedeiro.
       ========================================================================== */
    if (!caminho.startsWith(CONF.prefixo) && /^\/call\/[^/]+\/?$/.test(caminho)) {
      const codigo = caminho.split("/").filter(Boolean)[1] || "";
      res.writeHead(301, {
        Location: CONF.prefixo + "/call/" + encodeURIComponent(codigo),
        "Cache-Control": "no-store",
      });
      return res.end();
    }

    /* Fora do prefixo: não é conosco. */
    if (!caminho.startsWith(CONF.prefixo))
      return responder(res, 404, { erro: "Não encontrado." });

    const interno = caminho.slice(CONF.prefixo.length) || "/";

    /* ==========================================================================
       O CLIENTE — a única resposta do chat que pode ficar em cache.

       E ele usa `no-cache` + ETag, e NÃO `max-age`. A diferença importa:

       `max-age=300` faz o navegador nem PERGUNTAR por cinco minutos. Numa
       correção urgente do cliente — um defeito de renderização, uma falha de
       reconexão — metade da empresa continuaria com o código velho, e o
       sintoma seria "consertou para uns e não para outros". Foi exatamente o
       que aconteceu ao corrigir a marcação de sublinhado durante a construção
       deste módulo: o navegador serviu o arquivo antigo e o teste "falhou"
       sem que houvesse defeito nenhum.

       `no-cache` NÃO significa "não guarde": significa "guarde, mas
       PERGUNTE antes de usar". Com o ETag, a pergunta custa um 304 vazio —
       alguns bytes — e a correção chega no próximo carregamento de página.
       ========================================================================== */
    if (req.method === "GET" && (interno === "/cliente.js" || interno === "/la-chat.js")) {
      try {
        /* ====================================================================
           CONCATENAÇÃO NA ENTREGA — o "passo de build" que não existe

           O cliente é escrito em arquivos separados e servido como um só. Não
           há bundler, não há etapa de compilação: o servidor lê os arquivos e
           junta, e o ETag cobre todos eles.

           O VÍDEO SÓ ENTRA SE ESTIVER LIGADO. Numa instalação sem reunião,
           `la-chat-video.js` não é lido, não é baixado e não é avaliado — o
           recurso não existe, em vez de existir escondido atrás de um `if` no
           navegador de todo mundo.
           ==================================================================== */
        const partes = [arquivoCliente];
        if (CONF.video.ativo) partes.push(arquivoVideo);

        const infos = await Promise.all(partes.map((f) => fs.promises.stat(f)));

        /* O ETag junta tamanho e data de CADA parte. Com o de um arquivo só,
           mexer no vídeo não invalidaria o cache e a correção não chegaria —
           que é exatamente o defeito que este cabeçalho existe para evitar. */
        const etag = 'W/"' + infos
          .map((i) => i.size.toString(36) + "-" + Math.floor(i.mtimeMs).toString(36))
          .join(".") + '"';

        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
          return res.end();
        }

        const pedacos = await Promise.all(partes.map((f) => fs.promises.readFile(f)));
        /* A quebra de linha entre os arquivos não é enfeite: sem ela, um
           arquivo terminado em comentário de linha (`// …`) engoliria a
           primeira linha do seguinte. */
        const js = Buffer.concat(
          pedacos.flatMap((p, n) => (n ? [Buffer.from("\n;\n"), p] : [p])));

        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Content-Length": js.length,
          "Cache-Control": "no-cache",
          ETag: etag,
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(js);
      } catch {
        return responder(res, 404, { erro: "Cliente não encontrado." });
      }
    }

    /* ==========================================================================
       O SCRIPT DA PÁGINA DO CONVIDADO

       Arquivo à parte, e não script embutido no HTML, porque a CSP daquela
       página não tem `unsafe-inline` para script. Abrir a exceção seria
       afrouxar justamente a única página que qualquer estranho alcança —
       trocar a defesa contra injeção por uma requisição a menos.

       Só existe com o vídeo ligado: sem reunião não há sala, e um arquivo
       servido "por via das dúvidas" é superfície de graça.
       ========================================================================== */
    if (req.method === "GET" && interno === "/sala.js" && CONF.video.ativo) {
      const arquivoSala = path.join(CONF.caminhos.publico, "sala.js");
      try {
        const info = await fs.promises.stat(arquivoSala);
        const etag = 'W/"' + info.size.toString(36) + "-"
          + Math.floor(info.mtimeMs).toString(36) + '"';
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
          return res.end();
        }
        const js = await fs.promises.readFile(arquivoSala);
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Content-Length": js.length,
          "Cache-Control": "no-cache",
          ETag: etag,
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(js);
      } catch {
        return responder(res, 404, { erro: "Não encontrado." });
      }
    }

    /* ==========================================================================
       O AVISO SONORO

       Servido daqui pelo mesmo motivo do cliente: uma troca de som chega a
       todas as instalações sem ninguém recopiar arquivo.

       AQUI O CACHE É LONGO, ao contrário do cliente. O arquivo é imutável na
       prática — trocar o som é trocar o arquivo, e nesse dia o `max-age`
       atrasa a mudança em algumas horas para quem já tinha visitado. É um
       preço barato perto de baixar 73 KB de MP3 a cada carregamento de página
       do sistema, que é o que `no-cache` custaria aqui.
       ========================================================================== */
    if (req.method === "GET" && interno === "/aviso.mp3") {
      const arquivoAviso = path.join(CONF.caminhos.publico, "aviso.mp3");
      try {
        const info = await fs.promises.stat(arquivoAviso);
        const etag = `W/"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { ETag: etag });
          return res.end();
        }
        const mp3 = await fs.promises.readFile(arquivoAviso);
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Content-Length": mp3.length,
          "Cache-Control": "public, max-age=604800",
          ETag: etag,
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(mp3);
      } catch {
        /* Sem o arquivo, o cliente cai no bipe gerado — o aviso não some. */
        return responder(res, 404, { erro: "Aviso sonoro não encontrado." });
      }
    }

    try {
      await rotas.tratar(req, res, interno, url);
    } catch (e) {
      responderErro(res, e, `${req.method} ${caminho}`);
    }
  });

  /* ==========================================================================
     O APERTO DE MÃO DO WEBSOCKET

     `upgrade` é um evento SEPARADO do fluxo normal: ele não passa pelo handler
     acima. Por isso todas as travas do WebSocket vivem no transporte, e não
     nos middlewares de HTTP — quem escrever uma trava nova precisa saber que
     há dois caminhos de entrada neste servidor, não um.
     ========================================================================== */
  servidor.on("upgrade", (req, socket, cabeca) => {
    req.ipReal = ipDe(req, CONF.proxiesConfiaveis);

    let caminho = "";
    try { caminho = new URL(req.url, CONF.base).pathname; } catch { }

    if (caminho !== `${CONF.prefixo}/ws`) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }

    /* Um socket sem ouvinte de 'error' derruba o processo no Node. Aqui ele
       ainda não pertence ao `ws`, então o ouvinte tem de ser nosso. */
    socket.on("error", () => { try { socket.destroy(); } catch { } });

    transporte.aceitar(req, socket, cabeca).catch((e) => {
      console.error("  ✖ aperto de mão do WebSocket:", e.message);
      try { socket.destroy(); } catch { }
    });
  });

  /* Timeouts. O padrão do Node é generoso demais para um serviço exposto:
     conexões meio abertas seguradas por um cliente lento consomem descritores
     até o limite do sistema. `headersTimeout` menor que `requestTimeout` é
     obrigatório — invertido, o Node avisa e ignora. */
  servidor.headersTimeout = 20_000;
  servidor.requestTimeout = 60_000;
  servidor.keepAliveTimeout = 65_000;

  /* ==========================================================================
     FAXINA PERIÓDICA
     ========================================================================== */
  const faxina = setInterval(async () => {
    try {
      await repos.sessoes.faxina();

      /* As chamadas que ninguém encerrou: o toque que ninguém atendeu, a
         reunião que ficou vazia porque o processo reiniciou no meio. Sem esta
         varredura o índice único vira trava permanente e o botão de chamar
         "para de funcionar" naquela conversa, para sempre. */
      if (CONF.video.ativo) await chamadas.faxina();
      if (CONF.auditoria.diasParaGuardar > 0)
        await repos.auditoria.expurgar(CONF.auditoria.diasParaGuardar);

      /* Anexos que ficaram sem mensagem por mais de 6 h: a pessoa enviou o
         arquivo e desistiu de mandar. Sem isto o disco cresce com lixo que
         ninguém vê e que ninguém sabe apagar. */
      for (const orfao of await repos.anexos.orfaos(6 * 3600e3)) {
        await disco.remover(orfao.caminho);
        if (orfao.miniatura) await disco.remover(orfao.miniatura);
        await repos.anexos.remover(orfao.id);
      }
    } catch (e) {
      console.error("  ⚠ faxina:", e.message);
    }
  }, 30 * 60e3);
  faxina.unref();

  /* ==========================================================================
     O RELÓGIO DAS SALAS

     Separado da faxina de meia em meia hora, e de propósito: o aviso dos
     últimos cinco minutos e o encerramento no horário precisam de granularidade
     de SEGUNDOS. Encerrar uma reunião "em algum momento da próxima meia hora"
     não é encerrar no tempo definido.

     Vinte segundos: o aviso sai com no máximo 20s de atraso dentro de uma
     janela de cinco minutos, e a reunião acaba no minuto certo. É consulta
     barata — duas leituras indexadas — e só roda com o vídeo ligado.
     ========================================================================== */
  const relogioDasSalas = CONF.video.ativo ? setInterval(async () => {
    try { await salas.faxina(); }
    catch (e) { console.error("  ⚠ relógio das salas:", e.message); }
  }, 20_000) : null;
  relogioDasSalas?.unref();

  /* ==========================================================================
     SUBIR
     ========================================================================== */
  await new Promise((r) => servidor.listen(CONF.porta, CONF.host, r));

  console.log(`
  LA Chat ${CONF.versao}
  ─────────────────────────────────────────────
  Escutando   http://${CONF.host}:${CONF.porta}${CONF.prefixo}
  WebSocket   ws://${CONF.host}:${CONF.porta}${CONF.prefixo}/ws
  Banco       ${Q.tipo} (${Q.driver})
  Origens     ${porteiro.lista.length ? porteiro.lista.join(", ") : "(nenhuma — só desenvolvimento)"}
  Cookie      SameSite=${CONF.entreSites ? "None; Secure" : "Strict"}
  Ambiente    ${CONF.ambiente}
`);

  /* ==========================================================================
     ENCERRAMENTO ORDENADO

     Sem isto, um deploy derruba o processo no meio de uma gravação e deixa
     conexões WebSocket penduradas do lado do cliente, que só percebem quando o
     batimento falha — dez segundos de "reconectando" a cada publicação.

     A ordem importa: parar de aceitar → derrubar sockets → fechar banco.
     Fechar o banco primeiro faria as requisições em voo estourarem.
     ========================================================================== */
  let encerrando = false;
  async function encerrar(sinal) {
    if (encerrando) return;
    encerrando = true;
    console.log(`\n  ${sinal} — encerrando…`);

    clearInterval(faxina);
    if (relogioDasSalas) clearInterval(relogioDasSalas);
    servidor.close();
    transporte.encerrarTudo();
    limites.encerrar();
    try { await Q.fechar(); } catch { }

    /* Rede de segurança: se algo segurar o processo, sai mesmo assim. Um
       serviço que não morre no `systemctl restart` vira um deploy travado. */
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on("SIGTERM", () => encerrar("SIGTERM"));
  process.on("SIGINT", () => encerrar("SIGINT"));

  /* Uma promessa rejeitada sem tratamento derruba o processo em Node moderno.
     Registrar e seguir é melhor que sair do ar: o chat continua servindo
     todo mundo enquanto o defeito aparece no log para ser corrigido. */
  process.on("unhandledRejection", (e) => {
    console.error("  ✖ promessa rejeitada sem tratamento:", e?.message || e);
  });

  return { servidor, transporte, Q, servico, sessoes, passes, repos, encerrar };
}

if (require.main === module) {
  principal().catch((e) => {
    console.error("\n  ✖ o LA Chat não subiu:", e.message, "\n");
    if (process.env.CHAT_DEBUG) console.error(e);
    process.exit(1);
  });
}

module.exports = { principal };
