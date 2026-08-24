/* ==========================================================================
   testes/salas.cjs — a sala por link, e tudo que um convidado NÃO pode

       node testes/salas.cjs

   Esta suíte existe porque a sala anônima é a única parte do sistema que
   responde a quem não tem credencial nenhuma. Metade dos casos aqui não testa
   funcionalidade: testa que o convidado **bate na parede** em todo lugar que
   não seja a reunião dele.

   Se um dia um teste desta seção passar a falhar, a leitura correta não é
   "ajustar o teste" — é que alguém abriu uma porta.
   ========================================================================== */
"use strict";

const path = require("node:path");
const WebSocket = require("ws");
const { criarPlacar, subirChat, entrar, criarAba, pedir, espera } = require("./ajuda.cjs");

/* O TURN é dublê — não sobe coturn nenhum. O que se prova aqui é o que o
   SERVIDOR manda ao navegador, que é onde a decisão de privacidade acontece. */
const VIDEO = {
  CHAT_VIDEO: "1", CHAT_VIDEO_TETO: "4",
  CHAT_TURN: "turn:relay.zzqa:3478", CHAT_TURN_SEGREDO: "zz-qa-segredo-de-teste",
  /* O teto de entradas por IP sobe SÓ na suíte: todos os casos saem do mesmo
     127.0.0.1, e a partir de certa quantidade eles esbarram num limite que
     existe para barrar varredura de códigos, não teste. O freio de `/info`
     continua no padrão — é ele que o teste de adivinhação exercita. */
  CHAT_SALA_FREIO_ENTRAR: "500",
};

/* Uma "aba de navegador" de convidado: guarda os cookies dele e devolve o
   CSRF próprio. É deliberadamente igual à do funcionário — o teste tem de
   provar que a diferença está no SERVIDOR, não no cliente. */
function abaDeConvidado(base) {
  const potes = new Map();
  const aba = {
    potes,
    csrf: () => potes.get("cvd_csrf") || "",
    async vai(caminho, opcoes = {}) {
      const metodo = opcoes.metodo || "GET";
      const r = await pedir(base + caminho, {
        ...opcoes,
        cabecalhos: {
          Cookie: [...potes].map(([k, v]) => `${k}=${v}`).join("; "),
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
  };
  return aba;
}

async function rodar() {
  const P = criarPlacar("Salas por link");
  const chat = await subirChat({ porta: 5284, origens: "http://127.0.0.1:5299", extra: VIDEO });

  try {
    const ana = await entrar(chat, { id: "s-ana", nome: "ZZ QA Ana", papel: "admin" });
    const bruno = await entrar(chat, { id: "s-bruno", nome: "ZZ QA Bruno" });

    /* ====================================================================== */
    P.secao("criar o link");

    const criada = await ana.vai("/salas", {
      metodo: "POST",
      corpo: { titulo: "ZZ QA Reunião externa", duracaoMin: 30, validadeH: 2, maxConvidados: 2 },
    });
    P.eq(criada.status, 200, "o anfitrião cria a sala");

    /* ==================================================================
       SÓ ADMINISTRADOR CRIA LINK

       Todo funcionário pode LIGAR para um colega — é conversa entre quem já
       está dentro. Criar um link é abrir uma porta que responde a quem não
       tem credencial nenhuma, com a banda e o nome da empresa atrás dela.
       Essa decisão pertence a quem responde pelo sistema.
       ================================================================== */
    /* ==================================================================
       QUEM CRIA REUNIÃO POR LINK

       Criar um link é abrir uma porta que responde a quem não tem credencial
       nenhuma, com a banda e o nome da empresa atrás dela. Não é decisão de
       cada pessoa.

       Mas também não é só do administrador: os clientes têm mais perfis do
       que os dois papéis que o chat conhece. No BemEstar são três, e a
       recepção não deve criar link enquanto o profissional de saúde deve.

       Por isso a permissão tem DUAS portas:

         · `ehAdmin`   — do chat, não depende de o hospedeiro ter mudado;
         · `podeSala`  — a CAPACIDADE que o site declara, para os perfis que
                        só ele conhece.

       O papel continua fechado em membro/admin. Alargá-lo seria dar ao
       hospedeiro o poder de inventar privilégios que o chat não previu; uma
       capacidade nomeada delega exatamente uma decisão.
       ================================================================== */
    P.recusa(await bruno.vai("/salas", {
      metodo: "POST", corpo: { titulo: "ZZ QA Do Bruno", duracaoMin: 30 },
    }), 403, "a RECEPÇÃO (membro sem a capacidade) NÃO cria link");

    {
      /* O profissional: membro comum, com a capacidade declarada pelo site. */
      const profissional = await entrar(chat, {
        id: "s-prof", nome: "ZZ QA Profissional", cargo: "Profissional de saúde",
        papel: "membro", podeSala: true,
      });

      P.eq(profissional.usuario.papel, "membro",
        "o profissional é membro comum — a capacidade não o promove");
      P.eq(profissional.usuario.podeSala, true,
        "mas o /eu diz que ele pode criar reunião (é o que acende a aba)");

      const dele = await profissional.vai("/salas", {
        metodo: "POST", corpo: { titulo: "ZZ QA Do Profissional", duracaoMin: 30 },
      });
      P.eq(dele.status, 200, "e ele CRIA o link");

      /* A capacidade não vaza para mais nada. Ela responde uma pergunta só. */
      P.recusa(await profissional.vai("/admin/auditoria"), 403,
        "e continua sem alcançar a administração — a capacidade é uma só");

      const salaDele = dele.dados;
      P.recusa(await bruno.vai(`/salas/${salaDele.id}`, { metodo: "DELETE" }), 403,
        "e a sala dele não é revogável por outro membro");

      P.eq((await profissional.vai(`/salas/${salaDele.id}`, { metodo: "DELETE" })).status, 200,
        "mas ele mesmo revoga a própria sala");

      /* A recepção continua barrada mesmo mandando a bandeira no corpo — ela
         vem do PASSE ASSINADO, não do pedido. */
      P.recusa(await bruno.vai("/salas", {
        metodo: "POST", corpo: { titulo: "ZZ QA Tentativa", duracaoMin: 30, podeSala: true },
      }), 403, "e pedir a capacidade no corpo do pedido não a concede");
    }

    const sala = criada.dados;
    P.eq(String(sala.codigo || "").length, 11, "o código tem 11 caracteres", sala.codigo);
    P.ok(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{11}$/.test(sala.codigo),
      "no alfabeto sem caracteres confundíveis (0 O I l)", sala.codigo);
    /* ==================================================================
       O LINK É CONFERIDO INTEIRO, e não pelo fim.

       A primeira versão deste teste conferia só o `endsWith("/call/…")` — e
       aprovou verde um link que ignorava o prefixo do chat. Localmente
       parecia certo; em qualquer instalação com o chat sob `/chat` o convite
       apontaria para um endereço que ninguém serve, e o sintoma para o
       convidado seria "página não encontrada" num link recém-criado.

       Agora o teste ABRE o link, que é a única prova que importa.
       ================================================================== */
    P.ok(String(sala.link).endsWith("/call/" + sala.codigo), "o link é /call/<codigo>", sala.link);

    const abrindoOLink = await pedir(sala.link);
    P.ok([200, 301].includes(abrindoOLink.status),
      "e o link, ABERTO como uma pessoa abriria, responde", String(abrindoOLink.status));

    const destino = abrindoOLink.status === 301
      ? await pedir(new URL(abrindoOLink.cabecalhos.location, sala.link).toString())
      : abrindoOLink;
    P.eq(destino.status, 200, "chegando na página do convidado");
    P.ok(/^text\/html/.test(destino.cabecalhos["content-type"] || ""),
      "que é HTML de verdade", destino.cabecalhos["content-type"]);
    P.eq(sala.duracaoMin, 30, "a duração ficou gravada");
    P.eq(sala.estado, "aberta", "a sala nasce aberta e sem chamada");

    /* Dois links seguidos não podem sair parecidos. */
    const outra = await ana.vai("/salas", { metodo: "POST", corpo: { duracaoMin: 30 } });
    P.ok(outra.dados.codigo !== sala.codigo, "dois links são diferentes");

    P.recusa(await ana.vai("/salas", { metodo: "POST", corpo: { duracaoMin: 2 } }), 400,
      "duração abaixo do mínimo é recusada");
    P.recusa(await ana.vai("/salas", { metodo: "POST", corpo: { duracaoMin: 600 } }), 400,
      "duração acima do teto é recusada");

    /* ====================================================================== */
    P.secao("o código NÃO fica em claro no banco");

    const Banco = require("better-sqlite3");
    const db = new Banco(path.join(chat.pastaDados, "chat.db"), { readonly: true });
    const emClaro = db.prepare("SELECT COUNT(*) AS n FROM salas WHERE codigo_hash = ?").get(sala.codigo);
    P.eq(Number(emClaro.n), 0, "o código não está gravado como está no link");

    const crypto = require("node:crypto");
    const hash = crypto.createHash("sha256").update(sala.codigo).digest("hex");
    const porHash = db.prepare("SELECT codigo_cifrado FROM salas WHERE codigo_hash = ?").get(hash);
    P.ok(!!porHash, "mas é achável pelo HASH dele");
    P.ok(String(porHash.codigo_cifrado).startsWith("enc:"),
      "e a cópia que o anfitrião relê está CIFRADA");
    const titulos = db.prepare("SELECT titulo FROM salas WHERE codigo_hash = ?").get(hash);
    P.ok(String(titulos.titulo).startsWith("enc:"), "o título também está cifrado");
    db.close();

    /* ====================================================================== */
    P.secao("a página do link — sem credencial nenhuma");

    const info1 = await pedir(`${chat.base}/call/${sala.codigo}/info`);
    P.eq(info1.status, 200, "qualquer um abre a página do link");
    P.eq(info1.dados.ok, false, "mas ainda não dá para entrar");
    P.eq(info1.dados.motivo, "sem_anfitriao", "porque o anfitrião não abriu a sala");
    P.eq(info1.dados.aguardando, true, "e a tela sabe que vale a pena esperar");

    /* ==================================================================
       A RECUSA NÃO PODE DISTINGUIR OS CASOS.

       Se "não existe" e "foi revogada" tivessem textos diferentes, tentativa
       e erro viraria um mapa de quais códigos já existiram.
       ================================================================== */
    const inexistente = await pedir(`${chat.base}/call/aaaaaaaaaaa/info`);
    P.eq(inexistente.dados.mensagem, "Link inválido ou expirado.",
      "código inexistente devolve uma frase vaga");

    const revogar = await ana.vai(`/salas/${outra.dados.id}`, { metodo: "DELETE" });
    P.eq(revogar.status, 200, "o dono revoga um link");
    const revogada = await pedir(`${chat.base}/call/${outra.dados.codigo}/info`);
    P.eq(revogada.dados.mensagem, inexistente.dados.mensagem,
      "e a sala REVOGADA devolve a MESMA frase da inexistente (sem enumeração)");

    /* Código malformado nem chega ao banco. */
    const feio = await pedir(`${chat.base}/call/${encodeURIComponent("../../etc/passwd")}/info`);
    P.ok([200, 404].includes(feio.status), "código malformado não estoura", String(feio.status));

    /* ====================================================================== */
    P.secao("a PÁGINA em si — o único HTML deste servidor");

    const pagina = await pedir(`${chat.base}/call/${sala.codigo}`);
    P.eq(pagina.status, 200, "o link colado no navegador devolve uma página");
    P.ok(/^text\/html/.test(pagina.cabecalhos["content-type"] || ""),
      "e ela vem como HTML, não como JSON", pagina.cabecalhos["content-type"]);

    /* ==================================================================
       A PROVA DE QUE NADA É INTERPOLADO.

       O código da sala é o único texto de fora que poderia entrar nesta
       página — e ele NÃO entra: o JavaScript o lê do endereço. Enquanto
       esta asserção passar, XSS aqui é impossível por construção, e não
       por escapamento correto.
       ================================================================== */
    P.ok(!pagina.texto.includes(sala.codigo),
      "o código da sala NÃO aparece dentro do HTML (nada é interpolado)");

    /* A diretiva é LIDA, e não procurada por substring. A primeira versão
       deste teste conferia `!csp.includes("unsafe-inline'; script")`, o que
       passa verde com a CSP mais permissiva do mundo — um teste que aprova
       tudo é pior que teste nenhum, porque dá a sensação de cobertura. */
    const csp = pagina.cabecalhos["content-security-policy"] || "";
    const diretivas = new Map(csp.split(";").map((d) => {
      const [nome, ...valores] = d.trim().split(/\s+/);
      return [nome, valores];
    }));
    const scriptSrc = diretivas.get("script-src") || [];
    P.ok(scriptSrc.length > 0, "a página declara script-src", csp.slice(0, 70));
    P.ok(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"),
      "sem unsafe-inline e sem unsafe-eval em script", scriptSrc.join(" "));
    P.ok(scriptSrc.every((v) => v === "'self'"),
      "e nenhuma origem externa pode rodar script aqui", scriptSrc.join(" "));
    P.ok((diretivas.get("object-src") || []).includes("'none'"),
      "nem plugin embutido");
    P.ok(csp.includes("frame-ancestors 'none'"), "nem embutir a sala num iframe");
    P.ok(/noindex/.test(pagina.cabecalhos["x-robots-tag"] || ""),
      "e o link de reunião não vai para índice de busca");
    P.ok(/no-store/.test(pagina.cabecalhos["cache-control"] || ""),
      "a página não fica em cache");

    /* ==================================================================
       A BARRA NO FIM.

       `/call/<codigo>/` casa o mesmo padrão de rota, mas faz o navegador
       resolver os `../` da página para o lugar errado — e o sintoma seria
       uma tela em branco sem erro nenhum. Por isso há um endereço
       canônico, e um 301 para ele.
       ================================================================== */
    const comBarra = await pedir(`${chat.base}/call/${sala.codigo}/`);
    P.eq(comBarra.status, 301, "endereço com barra no fim redireciona");
    P.ok(String(comBarra.cabecalhos.location || "").endsWith("/call/" + sala.codigo),
      "para o endereço canônico, sem a barra", comBarra.cabecalhos.location);

    /* Código fora de forma não chega a ler arquivo nenhum. */
    P.eq((await pedir(`${chat.base}/call/000000000000`)).status, 404,
      "código fora do alfabeto nem abre a página");

    const script = await pedir(`${chat.base}/sala.js`);
    P.eq(script.status, 200, "o script da página é servido à parte");
    P.ok(script.texto.includes("entrarNaSala"),
      "e é ele quem entrega a identidade ao componente");
    P.ok(/nosniff/.test(script.cabecalhos["x-content-type-options"] || ""),
      "servido com nosniff");

    /* ====================================================================== */
    P.secao("o convidado NÃO entra antes do anfitrião");

    const cedo = abaDeConvidado(chat.base);
    P.recusa(await cedo.vai(`/call/${sala.codigo}/entrar`, {
      metodo: "POST", corpo: { nome: "ZZ QA Estranho" },
    }), 400, "entrar sem o anfitrião presente é recusado");

    /* ====================================================================== */
    P.secao("o anfitrião abre, o convidado entra");

    const aberta = await ana.vai(`/salas/${sala.id}/abrir`, { metodo: "POST" });
    P.eq(aberta.status, 200, "o anfitrião abre a sala");
    P.eq(aberta.dados.estado, "ativa", "e ela fica ativa");
    P.ok(!!aberta.dados.encerraEm, "com hora de término gravada");
    const fimEsperado = Date.now() + 30 * 60_000;
    P.ok(Math.abs(aberta.dados.encerraEm - fimEsperado) < 10_000,
      "o término é daqui a 30 minutos", String(aberta.dados.encerraEm - Date.now()));

    const info2 = await pedir(`${chat.base}/call/${sala.codigo}/info`);
    P.eq(info2.dados.ok, true, "agora a página do link libera a entrada");
    P.eq(info2.dados.titulo, "ZZ QA Reunião externa", "e mostra o título que o anfitrião pôs");

    const convidado = abaDeConvidado(chat.base);
    P.recusa(await convidado.vai(`/call/${sala.codigo}/entrar`, {
      metodo: "POST", corpo: { nome: " " },
    }), 400, "entrar sem nome é recusado");

    const entrou = await convidado.vai(`/call/${sala.codigo}/entrar`, {
      metodo: "POST", corpo: { nome: "ZZ QA Visitante" },
    });
    P.eq(entrou.status, 200, "o convidado entra digitando o nome");
    P.eq(entrou.dados.eu.convidado, true, "e é marcado como CONVIDADO");
    P.eq(entrou.dados.eu.nome, "ZZ QA Visitante", "com o nome que digitou");
    P.ok(!!entrou.dados.chamada?.credenciais?.iceServers,
      "recebe credenciais de ICE para a mídia");

    /* ==================================================================
       O IP NÃO ATRAVESSA A PORTA

       Numa malha direta, quem recebe o convite descobre de onde o
       funcionário está falando — e o funcionário, de onde ele está. Ninguém
       pediu isso. Reunião por link vai pelo relay, para os DOIS lados: se só
       um estivesse em `relay`, o outro continuaria anunciando os próprios
       candidatos e o endereço vazaria assim mesmo.
       ================================================================== */
    P.eq(entrou.dados.chamada?.credenciais?.iceTransportPolicy, "relay",
      "e a mídia dele vai pelo RELAY — o convidado não vê o IP de quem está dentro");

    const credRenovada = await convidado.vai(
      `/chamadas/${entrou.dados.chamada.id}/credenciais`);
    P.eq(credRenovada.dados?.iceTransportPolicy, "relay",
      "e a RENOVAÇÃO responde o mesmo — senão a reunião longa vazaria depois");
    P.ok(!!convidado.potes.get("cvd"), "ganha um cookie PRÓPRIO (cvd), não o do chat");
    P.ok(!convidado.potes.get("cid"), "e NÃO ganha o cookie de sessão do chat");

    /* ======================================================================
       O CABEÇALHO Origin — e por que este teste existe

       A suíte inteira passava verde enquanto a página do convidado morria no
       navegador com "Origem não autorizada". O motivo: `pedir()` não manda
       `Origin` nenhum, e nenhum teste mandava.

       A página do convidado é servida POR ESTE SERVIÇO. Os pedidos dela
       chegam com Origin igual ao endereço do próprio chat, que não estava na
       lista de origens do hospedeiro — e a defesa contra CSWSH, escrita para
       barrar site de terceiros, barrava a nossa própria página.

       Daqui em diante o teste fala como um navegador fala.
       ====================================================================== */
    P.secao("de onde o pedido veio");

    /* Sala PRÓPRIA: entrar consome vaga, e o teto é assunto de outro teste.
       Um teste que estraga o vizinho custa mais caro do que aparenta — a
       falha aparece longe da causa. */
    const paraOrigem = await ana.vai("/salas", {
      metodo: "POST", corpo: { titulo: "ZZ QA Origem", duracaoMin: 30, maxConvidados: 4 },
    });
    await ana.vai(`/salas/${paraOrigem.dados.id}/abrir`, { metodo: "POST" });
    const codigoDaOrigem = paraOrigem.dados.codigo;

    const daPropriaPagina = abaDeConvidado(chat.base);
    const comOrigemPropria = await daPropriaPagina.vai(`/call/${codigoDaOrigem}/entrar`, {
      metodo: "POST", corpo: { nome: "ZZ QA Origem" },
      cabecalhos: { Origin: chat.base.replace(/\/chat$/, "") },
    });
    P.eq(comOrigemPropria.status, 200,
      "a PRÓPRIA página do chat é aceita (Origin = o próprio serviço)",
      JSON.stringify(comOrigemPropria.dados)?.slice(0, 80));

    const deOutroSite = abaDeConvidado(chat.base);
    const comOrigemAlheia = await deOutroSite.vai(`/call/${codigoDaOrigem}/entrar`, {
      metodo: "POST", corpo: { nome: "ZZ QA Invasor" },
      cabecalhos: { Origin: "https://site-do-atacante.example" },
    });
    P.ok(comOrigemAlheia.status >= 400,
      "e um site estranho continua barrado — a defesa não foi afrouxada",
      String(comOrigemAlheia.status));

    /* ======================================================================
       O BILHETE DO SOCKET EXIGE O CSRF DO CONVIDADO

       Este caso existe por causa de um defeito de CLIENTE: ele mandava o
       cabeçalho CSRF vazio, porque procurava o cookie do funcionário. O
       servidor recusava — corretamente — e o convidado nunca abria o
       WebSocket. Sem socket, não há sinalização WebRTC, e a reunião ficava
       eternamente "conectando…".

       Aqui se fixa a CONSEQUÊNCIA no servidor: sem o token certo, não há
       bilhete. É o que dá sentido à trava do lado do cliente, em
       `testes/unidade.cjs`.
       ====================================================================== */
    P.secao("o bilhete do convidado");

    {
      const semToken = await pedir(`${chat.base}/bilhete`, {
        metodo: "POST",
        cabecalhos: {
          Cookie: [...convidado.potes].map(([k, v]) => `${k}=${v}`).join("; "),
          "X-Chat-Csrf": "",
        },
      });
      P.ok(semToken.status >= 400,
        "CSRF vazio NÃO tira bilhete — era assim que o convidado ficava sem socket",
        String(semToken.status));

      const comToken = await convidado.vai("/bilhete", { metodo: "POST" });
      P.eq(comToken.status, 200, "e com o token do cookie DELE, tira");
      P.ok(!!comToken.dados?.bilhete, "vindo um bilhete de verdade");

      /* ==================================================================
         OS DOIS COOKIES NO MESMO NAVEGADOR

         É o caso NORMAL, não a exceção: um funcionário logado no sistema
         recebe um link de reunião e o abre ali mesmo. A partir daí a origem
         tem `cid` (funcionário) e `cvd` (convidado).

         A regra do roteador era "funcionário primeiro". O pedido da página do
         convidado levava o CSRF do CONVIDADO e era conferido contra a sessão
         do FUNCIONÁRIO: 403, sempre. Sem bilhete, sem socket, sem sinalização
         — e a reunião ficava eternamente em "conectando…".

         O cabeçalho `X-Chat-Como` desempata. Ele REBAIXA a identidade, nunca
         eleva: continua exigindo o cookie `cvd` e o CSRF que combina com ele.
         ================================================================== */
      const misturado = {
        Cookie: [...convidado.potes].map(([k, v]) => `${k}=${v}`).join("; ")
          + "; " + [...ana.potes].map(([k, v]) => `${k}=${v}`).join("; "),
      };

      const semDizer = await pedir(`${chat.base}/bilhete`, {
        metodo: "POST",
        cabecalhos: { ...misturado, "X-Chat-Csrf": convidado.csrf() },
      });
      P.ok(semDizer.status >= 400,
        "com os dois cookies e sem dizer quem é, o CSRF do convidado é recusado",
        String(semDizer.status));

      const dizendo = await pedir(`${chat.base}/bilhete`, {
        metodo: "POST",
        cabecalhos: { ...misturado, "X-Chat-Csrf": convidado.csrf(), "X-Chat-Como": "convidado" },
      });
      P.eq(dizendo.status, 200,
        "dizendo que fala como CONVIDADO, o bilhete sai — era este o defeito",
        JSON.stringify(dizendo.dados)?.slice(0, 70));

      /* E o cabeçalho não vira porta: sem sessão de convidado, ele não dá nada. */
      const soFuncionario = await pedir(`${chat.base}/bilhete`, {
        metodo: "POST",
        cabecalhos: {
          Cookie: [...ana.potes].map(([k, v]) => `${k}=${v}`).join("; "),
          "X-Chat-Csrf": ana.csrf(), "X-Chat-Como": "convidado",
        },
      });
      P.ok(soFuncionario.status >= 400,
        "e quem NÃO tem sessão de convidado não ganha nada com o cabeçalho",
        String(soFuncionario.status));
    }

    /* ====================================================================== */
    P.secao("O QUE O CONVIDADO NÃO ALCANÇA — o coração desta suíte");

    const proibidas = [
      ["GET", "/eu", "quem sou eu"],
      ["GET", "/conversas", "a lista de conversas da empresa"],
      ["GET", "/pessoas", "o diretório de pessoas"],
      ["GET", "/busca?q=orcamento", "a busca de mensagens"],
      ["GET", "/salas", "as salas de outras pessoas"],
      ["GET", "/admin/auditoria", "a auditoria"],
    ];
    for (const [metodo, rota, oQue] of proibidas) {
      const r = await convidado.vai(rota, { metodo });
      P.eq(r.status, 403, `convidado NÃO alcança ${oQue}`,
        `${r.status} ${JSON.stringify(r.dados)?.slice(0, 90)}`);
    }

    P.recusa(await convidado.vai("/salas", { metodo: "POST", corpo: { duracaoMin: 30 } }), 403,
      "convidado NÃO cria sala");
    P.recusa(await convidado.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: bruno.usuario.id },
    }), 403, "convidado NÃO abre conversa com ninguém");

    /* ====================================================================== */
    P.secao("o convidado não aparece na empresa");

    const pessoas = await ana.vai("/pessoas");
    P.ok(!pessoas.dados.pessoas.some((x) => x.nome.includes("Visitante")),
      "o convidado NÃO aparece no diretório",
      pessoas.dados.pessoas.map((x) => x.nome).join(", "));

    const busca = await ana.vai("/busca?q=" + encodeURIComponent("Visitante"));
    P.eq(busca.dados.pessoas.length, 0, "nem na busca de pessoas");

    const grupoComConvidado = await ana.vai("/conversas/grupo", {
      metodo: "POST",
      corpo: { titulo: "ZZ QA Tentativa", membros: [entrou.dados.eu.id] },
    });
    P.recusa(grupoComConvidado, 400,
      "e NÃO pode ser posto num grupo interno");

    /* ====================================================================== */
    P.secao("a reunião funciona para o convidado");

    const bilhete = await convidado.vai("/bilhete", { metodo: "POST" });
    P.eq(bilhete.status, 200, "o convidado pega bilhete do WebSocket");

    const ws = new WebSocket(
      `ws://127.0.0.1:${chat.porta}/chat/ws?t=${encodeURIComponent(bilhete.dados.bilhete)}`,
      { headers: { Origin: "http://127.0.0.1:5299" } });
    const recebidas = [];
    ws.on("message", (d) => { try { recebidas.push(JSON.parse(d.toString())); } catch { } });
    ws.on("error", () => { });
    const abriu = await new Promise((r) => {
      const t = setTimeout(() => r(false), 5000);
      ws.on("open", () => { clearTimeout(t); r(true); });
      ws.on("unexpected-response", (_, res) => { clearTimeout(t); r("status " + res.statusCode); });
    });
    P.eq(abriu, true, "e o socket dele abre", String(abriu));

    const chamadaId = aberta.dados.chamada.id;
    const disp = await convidado.vai(`/chamadas/${chamadaId}/dispositivos`, {
      metodo: "PATCH", corpo: { microfone: false },
    });
    P.eq(disp.status, 200, "consegue se silenciar na reunião dele");

    /* Mas não alcança OUTRA chamada. */
    const conversaInterna = (await ana.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: bruno.usuario.id },
    })).dados.id;
    const chamadaInterna = (await ana.vai(`/conversas/${conversaInterna}/chamada`,
      { metodo: "POST" })).dados.id;
    P.recusa(await convidado.vai(`/chamadas/${chamadaInterna}/entrar`, { metodo: "POST" }), 404,
      "NÃO entra numa reunião interna da empresa");
    await ana.vai(`/chamadas/${chamadaInterna}/sair`, { metodo: "POST" });

    /* ====================================================================== */
    P.secao("o teto de convidados");

    const c2 = abaDeConvidado(chat.base);
    P.eq((await c2.vai(`/call/${sala.codigo}/entrar`, {
      metodo: "POST", corpo: { nome: "ZZ QA Segundo" },
    })).status, 200, "o segundo convidado entra (teto 2)");

    const c3 = abaDeConvidado(chat.base);
    P.recusa(await c3.vai(`/call/${sala.codigo}/entrar`, {
      metodo: "POST", corpo: { nome: "ZZ QA Terceiro" },
    }), 400, "o terceiro é recusado — a sala está no teto");

    /* ====================================================================== */
    P.secao("remover um convidado");

    const lista = await ana.vai(`/salas/${sala.id}/participantes`);
    P.eq(lista.status, 200, "o anfitrião vê quem entrou");
    P.ok(lista.dados.convidados.some((c) => c.nome === "ZZ QA Visitante"),
      "com o nome digitado, decifrado");

    const remover = await ana.vai(`/salas/${sala.id}/remover/${entrou.dados.eu.id}`, { metodo: "POST" });
    P.eq(remover.status, 200, "o anfitrião remove um convidado");

    await espera(400);
    const depoisDeRemovido = await convidado.vai(`/chamadas/${chamadaId}/dispositivos`, {
      metodo: "PATCH", corpo: { microfone: true },
    });
    P.recusa(depoisDeRemovido, 401,
      "o cookie do removido para de valer na hora (não é só até recarregar)");
    P.ok(ws.readyState !== 1, "e o socket dele cai", "readyState=" + ws.readyState);
    try { ws.terminate(); } catch { }

    /* ====================================================================== */
    P.secao("revogar derruba quem está dentro");

    const salaViva = (await ana.vai("/salas", {
      metodo: "POST", corpo: { titulo: "ZZ QA Viva", duracaoMin: 30, maxConvidados: 2 },
    })).dados;
    await ana.vai(`/salas/${salaViva.id}/abrir`, { metodo: "POST" });

    const dentro = abaDeConvidado(chat.base);
    P.eq((await dentro.vai(`/call/${salaViva.codigo}/entrar`, {
      metodo: "POST", corpo: { nome: "ZZ QA Dentro" },
    })).status, 200, "convidado entra na sala nova");

    await ana.vai(`/salas/${salaViva.id}`, { metodo: "DELETE" });
    await espera(400);

    P.recusa(await dentro.vai("/bilhete", { metodo: "POST" }), 401,
      "revogar o link derruba a sessão de quem estava dentro");
    const depoisDeRevogar = await pedir(`${chat.base}/call/${salaViva.codigo}/info`);
    P.eq(depoisDeRevogar.dados.ok, false, "e o link para de funcionar");

    /* ====================================================================== */
    P.secao("o tempo encerra a reunião — e o servidor é quem decide");

    const curta = (await ana.vai("/salas", {
      metodo: "POST", corpo: { titulo: "ZZ QA Curta", duracaoMin: 5, maxConvidados: 2 },
    })).dados;
    await ana.vai(`/salas/${curta.id}/abrir`, { metodo: "POST" });

    /* Viajar no tempo mexendo no banco é o único jeito de testar isto sem
       esperar cinco minutos. O que se prova é a REGRA, não o relógio. */
    const dbw = new Banco(path.join(chat.pastaDados, "chat.db"));
    dbw.prepare("UPDATE salas SET encerra_em = ? WHERE id = ?")
      .run(Date.now() - 1000, curta.id);
    dbw.close();

    /* O relógio das salas roda a cada 20s; a suíte não espera por ele — chama
       a mesma conferência pela porta da frente. */
    const ate = Date.now() + 25_000;
    let encerrou = false;
    while (Date.now() < ate && !encerrou) {
      const r = await pedir(`${chat.base}/call/${curta.codigo}/info`);
      encerrou = r.dados?.ok === false &&
        ["encerrada", "tempo_esgotado", "inexistente"].includes(r.dados?.motivo);
      if (!encerrou) await espera(1000);
    }
    P.ok(encerrou, "passado o tempo, a reunião é encerrada pelo servidor");

    /* ======================================================================
       ACABADO O TEMPO, ACABOU PARA TODO MUNDO

       O convidado sempre foi julgado pelo RELÓGIO. O anfitrião era julgado
       pelo ESTADO, que só vira 'encerrada' quando a faxina roda — até 20
       segundos depois. Nessa janela havia duas verdades sobre a mesma sala,
       dependendo de quem perguntava.

       Estes casos viajam no tempo mexendo em `encerra_em` direto no banco,
       que é o que permite provar em segundos o que levaria meia hora.
       ====================================================================== */
    /* ======================================================================
       RECARREGAR NÃO É ENTRAR DE NOVO

       No celular a recarga acontece o tempo todo: girar a tela, trocar de
       aplicativo, o navegador descartar a aba em segundo plano. Cada uma
       delas voltava à tela de nome — e entrar de novo criava um convidado
       NOVO, com id novo, gastando mais uma vaga do teto.

       Uma sala de cinco lugares se esgotava com UMA pessoa e quatro recargas,
       e o anfitrião via cinco desconhecidos com o mesmo nome.
       ====================================================================== */
    P.secao("o convidado que recarrega a página");

    {
      const criadaR = await ana.vai("/salas", {
        metodo: "POST", corpo: { titulo: "ZZ QA Recarga", duracaoMin: 30, maxConvidados: 2 },
      });
      const salaR = criadaR.dados;
      await ana.vai(`/salas/${salaR.id}/abrir`, { metodo: "POST" });

      const aba = abaDeConvidado(chat.base);
      const entrou1 = await aba.vai(`/call/${salaR.codigo}/entrar`, {
        metodo: "POST", corpo: { nome: "ZZ QA Recarrega" },
      });
      P.eq(entrou1.status, 200, "o convidado entra");
      const idPrimeiro = entrou1.dados.eu.id;

      /* A RECARGA: mesma aba, mesmo cookie, sem digitar nome nenhum. */
      const retomou = await aba.vai(`/call/${salaR.codigo}/eu`);
      P.eq(retomou.status, 200, "e ao recarregar, retoma sem pedir o nome de novo");
      P.eq(retomou.dados?.eu?.id, idPrimeiro,
        "é a MESMA pessoa — não um convidado novo");
      P.eq(retomou.dados?.eu?.nome, "ZZ QA Recarrega", "com o nome que ela digitou");
      P.ok(!!retomou.dados?.chamada?.id, "e já volta para dentro da chamada");

      /* A VAGA NÃO VAZA. Este é o teste que importa: com o teto em 2, três
         recargas seguidas não podem consumir a sala. */
      for (let i = 0; i < 3; i++) await aba.vai(`/call/${salaR.codigo}/eu`);
      const vagas = await ana.vai(`/salas/${salaR.id}/participantes`);
      const dentro = (vagas.dados?.convidados || []).filter((c) => !c.saiuEm && !c.expulso);
      P.eq(dentro.length, 1, "e quatro recargas continuam sendo UMA pessoa na sala",
        JSON.stringify(dentro.map((c) => c.nome)));

      const outro = abaDeConvidado(chat.base);
      P.eq((await outro.vai(`/call/${salaR.codigo}/entrar`, {
        metodo: "POST", corpo: { nome: "ZZ QA Segundo" },
      })).status, 200, "a segunda vaga continua disponível");

      /* Sem cookie não se retoma nada — é sessão, não é o código do link. */
      const semCookie = abaDeConvidado(chat.base);
      P.recusa(await semCookie.vai(`/call/${salaR.codigo}/eu`), 401,
        "quem não tem sessão NÃO retoma (o link sozinho não basta)");

      /* Nem o removido. */
      await ana.vai(`/salas/${salaR.id}/remover/${idPrimeiro}`, { metodo: "POST" });
      const depoisDeRemovido = await aba.vai(`/call/${salaR.codigo}/eu`);
      P.ok(depoisDeRemovido.status >= 400,
        "e quem foi REMOVIDO não volta recarregando", String(depoisDeRemovido.status));
    }

    /* ======================================================================
       O ANFITRIÃO VOLTA PARA A PRÓPRIA SALA

       `estado = 'ativa'` diz que a sala foi ABERTA, não que há reunião
       acontecendo. Quando o anfitrião sai e era o último, a CHAMADA encerra e
       a SALA continua ativa, apontando para ela.

       A tela oferecia "Entrar", que levava à chamada morta e respondia "Esta
       chamada já terminou" — o dono trancado do lado de fora da própria
       reunião, com o link já distribuído.
       ====================================================================== */
    P.secao("o anfitrião sai e volta");

    {
      const criadaV = await ana.vai("/salas", {
        metodo: "POST", corpo: { titulo: "ZZ QA Volta", duracaoMin: 30 },
      });
      const salaV = criadaV.dados;

      const abriu = await ana.vai(`/salas/${salaV.id}/abrir`, { metodo: "POST" });
      P.eq(abriu.status, 200, "o anfitrião abre a sala");
      const chamada1 = abriu.dados.chamada?.id;

      const lista1 = await ana.vai("/salas");
      const naLista1 = (lista1.dados?.salas || []).find((x) => x.id === salaV.id);
      P.eq(naLista1?.chamadaViva, true, "e a lista diz que a chamada está VIVA");

      await ana.vai(`/chamadas/${chamada1}/sair`, { metodo: "POST" });

      const lista2 = await ana.vai("/salas");
      const naLista2 = (lista2.dados?.salas || []).find((x) => x.id === salaV.id);
      P.eq(naLista2?.estado, "ativa", "saindo, a SALA continua ativa");
      P.eq(naLista2?.chamadaViva, false,
        "mas a lista já diz que NÃO há chamada viva — é o que muda o botão na tela");

      /* Entrar na chamada morta continua sendo recusado, e deve ser: ela
         acabou mesmo. O que não pode é ser o único caminho oferecido. */
      const naMorta = await ana.vai(`/chamadas/${chamada1}/entrar`, { metodo: "POST" });
      P.ok(naMorta.status >= 400, "a chamada encerrada não recebe ninguém", String(naMorta.status));

      const reabriu = await ana.vai(`/salas/${salaV.id}/abrir`, { metodo: "POST" });
      P.eq(reabriu.status, 200, "e o anfitrião REABRE a sala");
      P.ok(reabriu.dados.chamada?.id && reabriu.dados.chamada.id !== chamada1,
        "numa chamada nova", reabriu.dados.chamada?.id);
      P.eq(reabriu.dados.encerraEm, abriu.dados.encerraEm,
        "com o MESMO prazo — reabrir não estica a reunião");

      /* E o link continua o mesmo: é ele que já foi distribuído. */
      P.eq(reabriu.dados.codigo, salaV.codigo, "e o mesmo link, que já está com as pessoas");

      const convidadoTardio = abaDeConvidado(chat.base);
      P.eq((await convidadoTardio.vai(`/call/${salaV.codigo}/entrar`, {
        metodo: "POST", corpo: { nome: "ZZ QA Tardio" },
      })).status, 200, "e quem tinha o link entra na reunião reaberta");
    }

    P.secao("acabado o tempo, a reunião não volta");

    {
      const Banco2 = require("better-sqlite3");
      const bd = new Banco2(path.join(chat.pastaDados, "chat.db"));

      const criadaT = await ana.vai("/salas", {
        metodo: "POST", corpo: { titulo: "ZZ QA Prazo", duracaoMin: 30, maxConvidados: 4 },
      });
      const salaT = criadaT.dados;

      const abertaT = await ana.vai(`/salas/${salaT.id}/abrir`, { metodo: "POST" });
      P.eq(abertaT.status, 200, "o anfitrião abre a sala");
      const chamadaT = abertaT.dados.chamada?.id || abertaT.dados.chamadaId;

      /* ------------------------------------------------------------------
         REABRIR NÃO ESTICA O PRAZO. É a afirmação que faz "dura 30 minutos"
         ser sobre o TEMPO, e não sobre o número de aberturas.
         ------------------------------------------------------------------ */
      const prazo1 = Number(bd.prepare("SELECT encerra_em FROM salas WHERE id = ?").get(salaT.id).encerra_em);
      await espera(1100);
      const reaberta = await ana.vai(`/salas/${salaT.id}/abrir`, { metodo: "POST" });
      const prazo2 = Number(bd.prepare("SELECT encerra_em FROM salas WHERE id = ?").get(salaT.id).encerra_em);
      P.eq(prazo2, prazo1, "reabrir a sala NÃO adia a hora de acabar");

      /* E a sala passa a apontar para a chamada NOVA — sem isto ela ficava
         presa à chamada morta, e todo convidado esperava um anfitrião que já
         estava lá. */
      if (reaberta.status === 200) {
        const apontaPara = bd.prepare("SELECT chamada_id FROM salas WHERE id = ?").get(salaT.id).chamada_id;
        const chamadaNova = reaberta.dados.chamada?.id || chamadaT;
        P.eq(apontaPara, chamadaNova,
          "e a sala aponta para a chamada ATUAL, não para a anterior");
      }

      /* ------------------------------------------------------------------
         A VIAGEM NO TEMPO: o prazo vence AGORA, e a faxina ainda não rodou.
         É exatamente a janela em que o anfitrião tinha privilégio.
         ------------------------------------------------------------------ */
      bd.prepare("UPDATE salas SET encerra_em = ? WHERE id = ?")
        .run(Date.now() - 1000, salaT.id);

      const estadoAgora = bd.prepare("SELECT estado FROM salas WHERE id = ?").get(salaT.id).estado;
      P.eq(estadoAgora, "ativa",
        "a sala ainda consta ATIVA — a faxina não rodou (é a janela do defeito)");

      const reabrirVencida = await ana.vai(`/salas/${salaT.id}/abrir`, { metodo: "POST" });
      P.recusa(reabrirVencida, 400,
        "mesmo assim, o ANFITRIÃO não reabre uma reunião cujo tempo acabou");

      const infoVencida = await pedir(`${chat.base}/call/${salaT.codigo}/info`);
      P.eq(infoVencida.dados.ok, false, "e o link já recusa, pelo relógio");
      P.eq(infoVencida.dados.motivo, "tempo_esgotado", "dizendo que o tempo acabou");

      const entrarVencida = abaDeConvidado(chat.base);
      P.recusa(await entrarVencida.vai(`/call/${salaT.codigo}/entrar`, {
        metodo: "POST", corpo: { nome: "ZZ QA Atrasado" },
      }), 400, "e ninguém entra por ele");

      /* ------------------------------------------------------------------
         DEPOIS DA FAXINA: nada volta, por porta nenhuma.
         ------------------------------------------------------------------ */
      let encerrou = false;
      for (let i = 0; i < 30 && !encerrou; i++) {
        encerrou = bd.prepare("SELECT estado FROM salas WHERE id = ?").get(salaT.id).estado === "encerrada";
        if (!encerrou) await espera(1000);
      }
      P.ok(encerrou, "a faxina encerra a sala");

      P.recusa(await ana.vai(`/salas/${salaT.id}/abrir`, { metodo: "POST" }), 400,
        "a sala ENCERRADA não reabre");

      /* A outra porta: entrar direto na chamada, sem passar pela sala. Se ela
         estivesse aberta, o link morto não importaria. */
      const chamadaFinal = bd.prepare("SELECT chamada_id FROM salas WHERE id = ?").get(salaT.id).chamada_id;
      if (chamadaFinal) {
        const porFora = await ana.vai(`/chamadas/${chamadaFinal}/entrar`, { metodo: "POST" });
        P.ok(porFora.status >= 400,
          "nem entrando direto na chamada, por fora da sala", String(porFora.status));
      }

      const infoMorta = await pedir(`${chat.base}/call/${salaT.codigo}/info`);
      P.eq(infoMorta.dados.ok, false, "o link continua morto");

      bd.close();
    }

    /* ====================================================================== */
    P.secao("freio contra adivinhação de código");

    let travou = 0;
    for (let i = 0; i < 30; i++) {
      const r = await pedir(`${chat.base}/call/aaaaaaaaaa${i % 10}/info`);
      if (r.status === 429) travou++;
    }
    P.ok(travou > 0, `tentar códigos em rajada é freado (${travou} recusadas de 30)`);

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
