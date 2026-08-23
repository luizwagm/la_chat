/* ==========================================================================
   convidado.js — a sessão de quem entra por link, e não é da casa

   ---------------------------------------------------------------------------
   ESTE É O ARQUIVO MAIS IMPORTANTE DA SALA ANÔNIMA

   A tentação, ao acrescentar convidado, é reaproveitar a sessão que já existe:
   o convidado entra, ganha o cookie `cid`, e pronto — todas as rotas passam a
   aceitá-lo.

   Isso seria um desastre silencioso. Todas as rotas do chat perguntam "há
   sessão?", não "há sessão DE FUNCIONÁRIO?". Um convidado com sessão de chat
   leria a lista de pessoas da empresa, buscaria mensagens, abriria conversa
   com qualquer um e criaria grupos. Nada disso apareceria como erro; ao
   contrário, funcionaria perfeitamente.

   Por isso a sessão de convidado é OUTRA COISA:

     · cookie próprio (`cvd`), com caminho próprio;
     · guardada só na memória, com prazo curto;
     · amarrada a UMA sala — ela não significa "estou autenticado", significa
       "estou nesta sala";
     · e as rotas do chat NÃO a consultam. Só as rotas de sala e de chamada.

   A pergunta que o roteador faz deixou de ser "há sessão?" e passou a ser
   "quem é, e para onde essa identidade vale?".

   ---------------------------------------------------------------------------
   POR QUE EM MEMÓRIA, E NÃO NO BANCO

   A sessão de funcionário é gravada porque um chat aberto o dia inteiro não
   pode cair a cada deploy. A de convidado é o oposto: ela dura o tempo de uma
   reunião, e se o serviço reiniciar no meio, entrar de novo pelo link é um
   clique — o link ainda está na mão da pessoa.

   Guardar no banco significaria escrever uma linha por visitante e ter de
   limpá-la depois; a memória resolve com um `Map` que morre junto com o
   processo, e nada de estranho fica gravado.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");
const { iguaisEmTempoConstante } = require("./passe.js");

/* Prazo do bilhete de convidado. Generoso o bastante para uma reunião de duas
   horas e um imprevisto, curto o bastante para não virar acesso permanente.
   O que encerra a reunião é a DURAÇÃO da sala, não este número. */
const VALIDADE_MS = 4 * 3600e3;

function criarConvidados({ segredo, seguro = true, entreSites = false, caminho = "/chat" }) {
  const nomeCookie = "cvd";
  const nomeCsrf = "cvd_csrf";

  /* token -> { usuarioId, salaId, conversaId, contextoId, nome, expira } */
  const sessoes = new Map();

  const hmac = (v) => crypto.createHmac("sha256", segredo).update(String(v)).digest("base64url");

  /* Faxina periódica. Sem ela o mapa cresce para sempre num serviço que fica
     meses de pé — um vazamento lento que ninguém liga a salas de reunião. */
  const faxina = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of sessoes) if (v.expira <= t) sessoes.delete(k);
  }, 5 * 60e3);
  faxina.unref();

  function lerCookie(req, nome) {
    const bruto = req.headers?.cookie || "";
    const escapado = nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|;\\s*)${escapado}=([^;]*)`).exec(bruto);
    return m ? decodeURIComponent(m[1]) : "";
  }

  return {
    nomeCookie,
    nomeCsrf,

    /* ======================================================================
       ABRIR — depois de o link ter sido conferido e o nome, saneado
       ====================================================================== */
    abrir({ usuarioId, salaId, conversaId, contextoId, nome }) {
      /* 32 bytes, como a sessão de funcionário: enquanto durar, este valor É a
         pessoa dentro daquela sala. */
      const token = crypto.randomBytes(32).toString("base64url");
      sessoes.set(token, {
        usuarioId, salaId, conversaId, contextoId, nome,
        expira: Date.now() + VALIDADE_MS,
      });

      const sameSite = entreSites ? "None" : "Strict";
      const flagSeguro = seguro || entreSites ? "; Secure" : "";
      const idade = Math.floor(VALIDADE_MS / 1000);

      return {
        token,
        cookies: [
          `${nomeCookie}=${token}; Path=${caminho}; HttpOnly; SameSite=${sameSite}${flagSeguro}; Max-Age=${idade}`,
          /* Legível por JavaScript, como o CSRF do funcionário — a página do
             convidado precisa devolvê-lo no cabeçalho. Sozinho não autentica
             nada. */
          `${nomeCsrf}=${hmac(token)}; Path=/; SameSite=${sameSite}${flagSeguro}; Max-Age=${idade}`,
        ],
      };
    },

    /* ======================================================================
       DE QUEM É ESTA REQUISIÇÃO

       Devolve um objeto com `ehConvidado: true` — e é essa marca que as rotas
       usam para recusar tudo que não seja sala ou chamada. Ela nunca deve ser
       apagada ao repassar a sessão adiante.
       ====================================================================== */
    de(req) {
      const token = lerCookie(req, nomeCookie);
      if (!token) return null;
      const s = sessoes.get(token);
      if (!s) return null;
      if (s.expira <= Date.now()) { sessoes.delete(token); return null; }

      return {
        ehConvidado: true,
        usuarioId: s.usuarioId,
        salaId: s.salaId,
        conversaId: s.conversaId,
        contextoId: s.contextoId,
        nome: s.nome,
        /* Convidado nunca é admin. Explícito porque `sessao.ehAdmin` é
           consultado em rotas de administração, e um `undefined` ali dependeria
           de o `if` estar escrito de um jeito e não de outro. */
        ehAdmin: false,
        papel: "convidado",
        sessaoId: "cvd:" + s.salaId,
      };
    },

    conferirCsrf(req) {
      const token = lerCookie(req, nomeCookie);
      const doCabecalho = req.headers?.["x-chat-csrf"];
      if (!token || !doCabecalho) return { ok: false, erro: "falta o token de sessão" };
      const doCookie = lerCookie(req, nomeCsrf);
      if (!doCookie) return { ok: false, erro: "falta o cookie de CSRF" };

      /* As duas conferências, como na sessão de funcionário: bater cabeçalho
         contra cookie prova que quem mandou consegue LER o cookie (mesma
         origem); bater contra o HMAC do token prova que é desta sessão. */
      if (!iguaisEmTempoConstante(doCabecalho, doCookie))
        return { ok: false, erro: "token CSRF não confere" };
      if (!iguaisEmTempoConstante(doCabecalho, hmac(token)))
        return { ok: false, erro: "token CSRF não pertence a esta sessão" };

      return { ok: true };
    },

    encerrar(req) {
      const token = lerCookie(req, nomeCookie);
      if (token) sessoes.delete(token);
      const sameSite = entreSites ? "None" : "Strict";
      const flagSeguro = seguro || entreSites ? "; Secure" : "";
      return [
        `${nomeCookie}=; Path=${caminho}; HttpOnly; SameSite=${sameSite}${flagSeguro}; Max-Age=0`,
        `${nomeCsrf}=; Path=/; SameSite=${sameSite}${flagSeguro}; Max-Age=0`,
      ];
    },

    /* ======================================================================
       EXPULSAR

       Quando o anfitrião remove alguém, ou a sala acaba, as sessões daquela
       sala morrem na hora. Sem isto, "removi da reunião" valeria só até a
       próxima requisição do convidado — e ele voltaria pelo mesmo cookie.
       ====================================================================== */
    encerrarDaSala(salaId) {
      let n = 0;
      for (const [k, v] of sessoes) if (v.salaId === salaId) { sessoes.delete(k); n++; }
      return n;
    },

    encerrarDoUsuario(usuarioId) {
      let n = 0;
      for (const [k, v] of sessoes) if (v.usuarioId === usuarioId) { sessoes.delete(k); n++; }
      return n;
    },

    abertas: () => sessoes.size,
    encerrarTudo() { clearInterval(faxina); sessoes.clear(); },
  };
}

module.exports = { criarConvidados, VALIDADE_MS };
