/* ==========================================================================
   config.js — O ÚNICO lugar onde há número mágico neste projeto

   O §37 do briefing pede configuração centralizada. O motivo real de ela
   existir não é organização: é que um limite espalhado pelo código é um limite
   que ninguém consegue mudar sem ler o código. "Qual o tamanho máximo de
   arquivo?" tem de ter UMA resposta, encontrável por quem opera o servidor e
   não escreveu o sistema.

   REGRAS DESTE ARQUIVO

   1. Nenhum segredo aqui. Segredo vem do ambiente e NUNCA tem valor padrão —
      um padrão de segredo é um segredo público. Ver `exigirSegredo()`.
   2. Todo número tem um comentário dizendo por que é aquele número. Um limite
      sem justificativa é um limite que ninguém tem coragem de mudar.
   3. Nada de `process.env` fora daqui. Se aparecer em outro arquivo, é bug.
   ========================================================================== */
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const RAIZ = __dirname;

/* ==========================================================================
   .env — mesmo formato do resto do ecossistema

   Lido ANTES de qualquer coisa. Em produção o systemd já injeta as variáveis
   por `EnvironmentFile=/etc/lachat.env` e este arquivo nem existe; em
   desenvolvimento ele é o que evita segredo no código.

   O que já está no ambiente VENCE o arquivo: senão, um `.env` esquecido na
   máquina sobrescreveria a configuração real do servidor.
   ========================================================================== */
function carregarAmbiente(dir = RAIZ) {
  const arq = path.join(dir, ".env");
  let texto = "";
  try { texto = fs.readFileSync(arq, "utf8"); } catch { return; }

  for (const linha of texto.split(/\r?\n/)) {
    const t = linha.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const chave = t.slice(0, i).trim();
    let valor = t.slice(i + 1).trim();
    /* Aspas são retiradas porque quem escreve .env à mão as usa por hábito, e
       uma chave base64 entre aspas falharia a conferência de 32 bytes com a
       mensagem errada ("não tem 32 bytes" em vez de "tire as aspas"). */
    if ((valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'")))
      valor = valor.slice(1, -1);
    if (!(chave in process.env)) process.env[chave] = valor;
  }
}
carregarAmbiente();

const num = (v, padrao) => (Number.isFinite(Number(v)) && String(v).trim() !== "" ? Number(v) : padrao);
const bool = (v, padrao) => (v === undefined || v === "" ? padrao : /^(1|true|sim|on)$/i.test(String(v)));
const lista = (v, padrao = []) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : padrao);

/* ==========================================================================
   SEGREDOS

   Faltar segredo NÃO é motivo para subir com um padrão. É motivo para o
   processo recusar-se a subir, dizendo qual falta e como gerar.

   A exceção é o modo de desenvolvimento, onde um segredo é SORTEADO na
   memória e avisado em voz alta. Sorteado, e não fixo: um valor fixo de
   desenvolvimento acaba em produção — é assim que "changeme" vira segredo real.
   ========================================================================== */
const AMBIENTE = process.env.NODE_ENV || "development";
const PRODUCAO = AMBIENTE === "production";

const faltando = [];
function exigirSegredo(nome, comoGerar) {
  const v = process.env[nome];
  if (v && v.length >= 32) return v;
  if (PRODUCAO) { faltando.push(`${nome}  →  ${comoGerar}`); return ""; }
  const sorteado = require("node:crypto").randomBytes(32).toString("base64");
  console.warn(`  ⚠ ${nome} não definida — usando valor SORTEADO só para desenvolvimento.`);
  console.warn(`    Em produção isto derruba o serviço. Gere com: ${comoGerar}`);
  return sorteado;
}

const CONF = {
  ambiente: AMBIENTE,
  producao: PRODUCAO,
  versao: require("./package.json").version,

  /* ------------------------------------------------------------------ rede */
  /* 5197 é a primeira porta livre do parque (5180–5196 estão tomadas).
     127.0.0.1 porque quem fala com a internet é o nginx — expor a porta
     contornaria TLS, limites e cabeçalhos do proxy. */
  porta: num(process.env.PORT, 5197),
  host: process.env.HOST || "127.0.0.1",

  /* Endereço público do chat, usado para montar URL de arquivo e conferir
     Origin. Sem barra no fim, sempre — concatenar produz `//` de outro jeito. */
  base: (process.env.CHAT_BASE || `http://127.0.0.1:${num(process.env.PORT, 5197)}`).replace(/\/+$/, ""),

  /* ==========================================================================
     PREFIXO DAS ROTAS

     Tudo do chat vive sob `/chat`. Isso existe para o ARRANJO A da instalação
     (ver seguranca/sessao.js): o conector do hospedeiro repassa `/chat/*` para
     cá, e o navegador enxerga tudo na mesma origem do site do cliente — o que
     permite o cookie `SameSite=Strict`, que é a proteção mais forte contra CSRF.

     Sem prefixo, o conector teria de adivinhar quais caminhos são do chat, e
     um caminho novo (uma rota acrescentada numa versão futura) deixaria de ser
     repassado sem ninguém perceber.
     ========================================================================== */
  prefixo: "/" + String(process.env.CHAT_PREFIXO || "chat").replace(/^\/+|\/+$/g, ""),

  /* Cookie entre sites: liga `SameSite=None; Secure`. Só é necessário no
     ARRANJO B (chat em subdomínio próprio, sem passar pelo conector). Errado
     para mais, enfraquece o CSRF sem motivo; errado para menos, o chat
     simplesmente não recebe o cookie e "não loga". */
  entreSites: bool(process.env.CHAT_ENTRE_SITES, false),

  /* ==========================================================================
     ORIGENS AUTORIZADAS — a defesa contra Cross-Site WebSocket Hijacking

     O navegador NÃO aplica same-origin a WebSocket. Sem esta lista, qualquer
     site que a vítima visitasse poderia abrir um socket para o chat, e o
     navegador anexaria o cookie de sessão de bom grado. O atacante passaria a
     ler e escrever mensagens em nome dela sem nunca ter roubado nada.

     Por isso a lista é OBRIGATÓRIA em produção, e vazia significa "recuse
     todo mundo" — nunca "aceite todo mundo". Um padrão permissivo aqui é a
     diferença entre uma trava e um enfeite.
     ========================================================================== */
  origensPermitidas: lista(process.env.CHAT_ORIGENS),

  /* ---------------------------------------------------------------- banco */
  banco: {
    /* `sqlite` serve os 16 sites que só têm SQLite; `pg` entra quando houver
       volume ou mais de um processo. Ver DATABASE.md. */
    motor: (process.env.CHAT_BANCO || "sqlite").toLowerCase(),
    arquivo: process.env.CHAT_SQLITE || path.join(RAIZ, "dados", "chat.db"),
    pg: {
      host: process.env.PGHOST || "127.0.0.1",
      porta: num(process.env.PGPORT, 5432),
      banco: process.env.PGDATABASE || "lachat",
      usuario: process.env.PGUSER || "lachat",
      senha: process.env.PGPASSWORD || "",
      /* 10 conexões: o chat faz muitas consultas curtas. Pool maior que isso
         num servidor compartilhado com 20 sites tira conexão dos outros. */
      maximo: num(process.env.PGMAX, 10),
    },
  },

  /* -------------------------------------------------------------- segredos */
  segredos: {
    /* Assina o passe que o hospedeiro emite. É o MESMO valor nos dois lados —
       é ele que faz o chat confiar em "este é o João" sem pedir senha. */
    passe: exigirSegredo("CHAT_SEGREDO_PASSE", "openssl rand -base64 32"),
    /* Deriva os tokens do índice cego. SEPARADO da chave dos dados de
       propósito: se um vazar, o outro não entrega nada. */
    busca: exigirSegredo("CHAT_SEGREDO_BUSCA", "openssl rand -base64 32"),
  },

  /* --------------------------------------------------------------- sessão */
  sessao: {
    /* 12 h para acompanhar o turno, como no /restrito do ecossistema. */
    horas: num(process.env.CHAT_SESSAO_HORAS, 12),
    cookie: process.env.CHAT_COOKIE || "cid",
    /* O passe vive 60 s. É tempo de sobra para o navegador dar dois saltos e
       curto demais para servir a quem interceptou. */
    passeSegundos: num(process.env.CHAT_PASSE_SEGUNDOS, 60),
  },

  /* -------------------------------------------------------------- arquivos */
  arquivos: {
    /* FORA de qualquer pasta servida pelo nginx. É o que impede baixar um
       anexo sabendo o nome — todo download passa pela conferência de membro. */
    pasta: process.env.CHAT_ARQUIVOS || path.join(RAIZ, "dados", "arquivos"),
    /* 10 MB. Acima disso o navegador segura a aba enviando, e o caso real
       (foto, PDF de orçamento, planilha) cabe folgado. Configurável porque
       quem instala conhece o próprio uso. */
    tamanhoMaximo: num(process.env.CHAT_ARQUIVO_MAX, 10 * 1024 * 1024),
    /* LISTA BRANCA. Nunca lista negra: proibir `.exe` deixa passar `.scr`,
       `.js`, `.hta`, `.lnk` e o que aparecer no Windows do ano que vem. */
    tiposPermitidos: lista(process.env.CHAT_TIPOS, [
      "image/jpeg", "image/png", "image/webp", "image/gif",
      "application/pdf",
      "text/plain", "text/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/zip",
    ]),
    /* Miniatura de 320 px de largura: é o que a bolha da mensagem mostra.
       Gerar do tamanho da tela custaria banda à toa no celular. */
    miniaturaLargura: num(process.env.CHAT_MINIATURA, 320),
  },

  /* --------------------------------------------------------------- limites
     Todos configuráveis (§32). Os padrões são folgados para gente e apertados
     para robô — que é o critério certo para limite de aplicação. */
  limites: {
    /* 30 mensagens/min é digitação humana rápida e contínua. Acima disso é
       roteiro, e o custo do fan-out passa a ser do servidor. */
    mensagensPorMinuto: num(process.env.CHAT_LIM_MSG, 30),
    /* 4.000 caracteres. Acima disso não é mensagem, é documento — e para
       documento existe anexo. Também trava o abuso de encher o banco. */
    tamanhoMensagem: num(process.env.CHAT_LIM_TAMANHO, 4000),
    /* ====================================================================
       A JANELA PARA EDITAR

       Cinco minutos. O número não é sobre generosidade, é sobre o que editar
       serve para fazer: consertar o erro de digitação que a pessoa viu logo
       depois de enviar. Esse conserto acontece em segundos.

       Uma janela LARGA muda a natureza da coisa. Num chat de clínica, onde a
       conversa registra o que foi combinado sobre um paciente, poder reescrever
       o que se disse meia hora atrás — depois de o outro ler e responder — não
       é correção, é reescrever a história. Curto, o estrago possível é pequeno.

       Que ela seja CONFIGURÁVEL aqui, e não fixa no código, é o que permite um
       cliente com outra realidade ajustar sem tocar em lógica nenhuma.
       ==================================================================== */
    janelaEdicaoMin: num(process.env.CHAT_LIM_EDICAO, 5),
    uploadsPorHora: num(process.env.CHAT_LIM_UPLOAD, 60),
    buscasPorMinuto: num(process.env.CHAT_LIM_BUSCA, 20),
    conversasPorHora: num(process.env.CHAT_LIM_CONVERSA, 30),
    /* Conexões simultâneas por PESSOA, não por IP: um escritório inteiro sai
       pelo mesmo IP, e limitar por IP derrubaria o escritório. 6 cobre
       computador + celular + abas esquecidas, e trava quem abre mil sockets. */
    conexoesPorUsuario: num(process.env.CHAT_LIM_CONEXOES, 6),
    /* Página de histórico. 50 enche uma tela alta com folga; o teto impede
       `?por=100000` de virar negação de serviço. */
    porPagina: num(process.env.CHAT_POR_PAGINA, 50),
    tetoPorPagina: num(process.env.CHAT_TETO_PAGINA, 200),
  },

  /* -------------------------------------------------------------- realtime */
  realtime: {
    /* Ping do servidor a cada 25 s, derrubada em 60 s sem pong.

       25 s porque proxies e NAT fecham conexão parada por volta de 60 s — o
       ping precisa caber com folga dentro dessa janela.

       O pong é o que detecta cabo arrancado e notebook fechado: nesses casos o
       socket continua "aberto" do lado do servidor por minutos, e sem o
       batimento a pessoa ficaria eternamente online para todo mundo. */
    pingMs: num(process.env.CHAT_PING_MS, 25_000),
    mortoMs: num(process.env.CHAT_MORTO_MS, 60_000),
    /* Quadro maior que isto derruba a conexão. É defesa contra alocar memória
       a pedido do cliente — a mensagem legítima maior tem 4.000 caracteres. */
    quadroMaximo: num(process.env.CHAT_QUADRO_MAX, 64 * 1024),
    /* Carência antes de declarar OFFLINE. Trocar de aba fecha e reabre o
       socket; sem carência o status piscaria na tela de todo mundo. */
    carenciaOfflineMs: num(process.env.CHAT_CARENCIA_MS, 30_000),
    /* "Está digitando" expira sozinho. Sem isso, quem fecha a aba no meio de
       uma frase fica digitando para sempre. */
    digitandoMs: num(process.env.CHAT_DIGITANDO_MS, 6_000),
  },

  /* ==========================================================================
     VÍDEO (reunião)

     Topologia: MALHA. Cada pessoa manda o próprio vídeo para cada uma das
     outras, direto, cifrado por DTLS-SRTP — a mídia NUNCA passa por este
     servidor. Ver docs/VIDEO.md para a decisão e para quando ela deixa de
     servir.
     ========================================================================== */
  video: {
    /* Desligado por padrão. Uma instalação existente não deve ganhar botão de
       câmera num deploy sem que alguém tenha decidido isso — e sem TURN
       configurado o recurso funcionaria pela metade, que é pior que não ter. */
    ativo: bool(process.env.CHAT_VIDEO, false),

    /* Seis é o limite honesto da malha (ver dominio/chamadas.js). Configurável
       PARA BAIXO — uma instalação com internet ruim pode querer 4. Subir daqui
       não melhora nada: derruba o áudio de todo mundo em vez de recusar a
       sétima pessoa na porta. */
    teto: Math.min(6, num(process.env.CHAT_VIDEO_TETO, 6)),

    /* Quanto tempo o telefone toca. 45 s é o que o celular faz. */
    tocandoMs: num(process.env.CHAT_VIDEO_TOCANDO_MS, 45_000),

    /* STUN: só responde "o teu IP público é este". Não vê mídia, não custa
       banda. O padrão usa o servidor público do Google porque ele é gratuito e
       não recebe conteúdo nenhum — mas quem quiser autonomia total aponta para
       o próprio coturn, que também faz STUN. */
    stun: lista(process.env.CHAT_STUN, ["stun:stun.l.google.com:19302"]),

    /* TURN: o relay para quando a conexão direta não fecha. Sem ele, de 15% a
       20% das chamadas falham — concentradas em rede corporativa. */
    turn: lista(process.env.CHAT_TURN),
    turnSegredo: process.env.CHAT_TURN_SEGREDO || "",
    turnTtl: num(process.env.CHAT_TURN_TTL, 2 * 3600),

    /* Força TODA a mídia pelo TURN. Custa banda e latência; em troca, os
       participantes deixam de ver o IP uns dos outros. É decisão de quem
       instala — ver a nota de exposição de IP em docs/VIDEO.md. */
    soRelay: bool(process.env.CHAT_VIDEO_SO_RELAY, false),

    /* ======================================================================
       O RELAY OBRIGATÓRIO DA SALA POR LINK — e a válvula que ele precisava

       Toda reunião nascida de um `/call/<codigo>` usa `relay`, para que o
       convidado de fora não descubra o IP de quem está dentro (e vice-versa).
       É a decisão certa de privacidade, e continua sendo o padrão.

       Mas ela tem um custo que só aparece com o relay QUEBRADO: pedir
       `relay` faz o navegador descartar todo candidato que não seja de relay,
       e sem relay utilizável não sobra nenhum. A reunião por link fica
       IMPOSSÍVEL — enquanto a chamada interna, que usa `all`, continua
       funcionando perfeitamente.

       O sintoma engana: "o chat funciona, só o link não". Leva a procurar
       defeito na sala, e o defeito está no coturn — credencial recusada,
       porta fechada, serviço fora do ar.

       Esta chave existe para desatar esse nó enquanto o relay é consertado.
       Desligá-la NÃO é neutro: os participantes voltam a ver o IP uns dos
       outros, inclusive o estranho que recebeu o convite. É troca consciente,
       e por isso ela tem nome longo e padrão seguro.
       ====================================================================== */
    salaRelay: bool(process.env.CHAT_VIDEO_SALA_RELAY, true),

    /* ======================================================================
       O FREIO DE ENTRADA NA SALA — por IP, e apertado de propósito

       \`/call/<codigo>/entrar\` é a rota mais exposta do sistema: responde a
       quem não tem credencial nenhuma. Dez por minuto por endereço é folgado
       para gente entrando numa reunião e apertado para quem varre códigos.

       Configurável porque a SUÍTE precisa subir o teto: todos os testes saem
       do mesmo 127.0.0.1, e a partir de certa quantidade de casos eles passam
       a esbarrar num limite que existe para outra coisa — o resultado é um
       teste vermelho que não denuncia defeito nenhum.
       ====================================================================== */
    freioEntrar: num(process.env.CHAT_SALA_FREIO_ENTRAR, 10),

    /* Compartilhar tela. Separado do vídeo porque há cliente que quer reunião
       com câmera e NÃO quer que a tela do sistema de gestão possa ser
       compartilhada por engano. */
    tela: bool(process.env.CHAT_VIDEO_TELA, true),

    /* Chamadas iniciadas por hora, por pessoa. Tocar o telefone dos colegas é
       barato para quem chama e caro para quem recebe — é assédio de baixo
       custo se não tiver freio. */
    porHora: num(process.env.CHAT_VIDEO_POR_HORA, 30),
  },

  /* ---------------------------------------------------------- notificações */
  notificacoes: {
    ativas: bool(process.env.CHAT_NOTIFICACOES, true),
    som: bool(process.env.CHAT_SOM, true),
  },

  /* ------------------------------------------------------------- retenção
     0 = guardar para sempre. Qualquer valor diferente APAGA mensagem antiga,
     e por isso o padrão é não apagar: retenção é decisão do cliente, com
     implicação jurídica (§34), e nunca deve acontecer por padrão do software. */
  retencaoDias: num(process.env.CHAT_RETENCAO_DIAS, 0),

  /* ------------------------------------------------------------ auditoria */
  auditoria: {
    /* Registrar IP tem base legal a validar caso a caso (§34). Por isso vem
       LIGADO mas com o IP guardado em hash — serve para investigar abuso
       ("foram 400 tentativas do mesmo lugar") sem manter um cadastro de onde
       cada funcionário estava. */
    registrarIp: bool(process.env.CHAT_AUDIT_IP, true),
    diasParaGuardar: num(process.env.CHAT_AUDIT_DIAS, 365),
  },

  /* ---------------------------------------------------------------- proxy
     Quantos saltos de proxy existem na frente. É o número de itens que se
     descarta do FIM do X-Forwarded-For para achar o IP verdadeiro.

     ISTO NÃO É DETALHE. Ler o PRIMEIRO item do cabeçalho — que é o erro
     natural e o que este ecossistema já cometeu nos quatro servidores — é ler
     TEXTO ESCRITO PELO ATACANTE: basta ele mandar `X-Forwarded-For: 1.2.3.4`
     para o limitador contar as tentativas dele numa conta alheia, e para a
     auditoria registrar o IP que ele escolher. Ver seguranca/ip.js.

     CONTE OS SALTOS:
         navegador → nginx → chat                       → 1
         navegador → nginx → site (conector) → chat     → 2   (arranjo A)

     O arranjo A é o recomendado e tem DOIS saltos. Com 1 ali, o chat enxerga
     o próprio conector: todo visitante vira 127.0.0.1, o limitador passa a
     tratar a empresa como um endereço só e a auditoria perde a utilidade.
     O `server.js` avisa no log quando detecta esse sintoma. */
  proxiesConfiaveis: num(process.env.CHAT_PROXIES, 1),

  caminhos: { raiz: RAIZ, dados: path.join(RAIZ, "dados"), publico: path.join(RAIZ, "publico") },
};

/* ==========================================================================
   Recusar-se a subir errado.

   Em produção, faltar segredo ou lista de origens não é aviso: é parada. Um
   chat que sobe sem `CHAT_ORIGENS` aceita socket de qualquer site do mundo, e
   ninguém perceberia — funcionaria perfeitamente, inclusive para o atacante.
   ========================================================================== */
function conferir() {
  const erros = [...faltando];

  if (CONF.producao && CONF.origensPermitidas.length === 0)
    erros.push("CHAT_ORIGENS  →  lista de sites autorizados, separada por vírgula (ex.: https://bemestarclinic.com)");

  if (!["sqlite", "pg"].includes(CONF.banco.motor))
    erros.push(`CHAT_BANCO="${CONF.banco.motor}" não existe — use "sqlite" ou "pg"`);

  if (CONF.producao && CONF.banco.motor === "pg" && !CONF.banco.pg.senha)
    erros.push("PGPASSWORD  →  senha do papel do PostgreSQL");

  if (erros.length) {
    console.error("\n  ✖ LA Chat não pode subir. Falta configuração obrigatória:\n");
    for (const e of erros) console.error("      " + e);
    console.error("\n  Em produção estes valores vêm de /etc/lachat.env (modo 640).");
    console.error("  Em desenvolvimento, de um .env na raiz — veja .env.exemplo.\n");
    return false;
  }
  return true;
}

module.exports = { CONF, conferir, carregarAmbiente };
