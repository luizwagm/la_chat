/* ==========================================================================
   sessao.js — cookie, CSRF e o bilhete do WebSocket

   ---------------------------------------------------------------------------
   1. O COOKIE E O `SameSite` — a decisão que depende de COMO foi instalado

   O chat roda em dois arranjos, e eles têm posturas de segurança diferentes.
   Fingir que são um só é como se ganha uma instalação insegura por descuido.

   ARRANJO A — ATRÁS DO HOSPEDEIRO (recomendado, e o padrão)

       navegador → https://site-do-cliente.com/chat/...  → conector → chat

   O conector do hospedeiro repassa as rotas `/chat/*`. Para o navegador, tudo
   acontece na MESMA origem do site. Então:

       SameSite=Strict   ← o cookie nunca sai numa requisição de outro site.
                           É a proteção mais forte contra CSRF que existe, e
                           vem de graça.

   ARRANJO B — EM SUBDOMÍNIO PRÓPRIO

       navegador → https://chat.empresa.com/...   (site em https://empresa.com)

   Agora é requisição entre sites. `SameSite=Strict` faria o cookie NUNCA ser
   enviado e o chat simplesmente não funcionaria. É preciso:

       SameSite=None; Secure   ← e, por consequência, CSRF volta a ser possível

   Por isso o arranjo B EXIGE as duas travas seguintes, que no arranjo A são
   reforço: o token CSRF e a lista de origens.

   ---------------------------------------------------------------------------
   2. CSRF POR DUPLA SUBMISSÃO

   O servidor manda um cookie `cid_csrf` (LEGÍVEL por JavaScript, de
   propósito) e o cliente devolve o mesmo valor no cabeçalho `X-Chat-Csrf`.

   Por que funciona: um site atacante CONSEGUE fazer o navegador enviar o
   cookie, mas NÃO consegue LER o cookie de outro domínio para copiá-lo no
   cabeçalho. A política de mesma origem, que falha para WebSocket, funciona
   perfeitamente para leitura de cookie.

   O token é AMARRADO à sessão (HMAC do id da sessão), e não sorteado à parte:
   assim ele não pode ser reaproveitado noutra sessão, e não é preciso guardar
   nada além do que já existe.

   ---------------------------------------------------------------------------
   3. O BILHETE DO WEBSOCKET — a defesa de verdade contra CSWSH

   Aqui está a decisão mais importante deste arquivo.

   O WebSocket NÃO é autenticado pelo cookie. Ele é autenticado por um BILHETE
   de 30 segundos, uso único, obtido por uma requisição HTTP normal — que passa
   por cookie, CSRF e Origin.

   O motivo é o que está escrito em `origem.js`: o navegador anexa cookies a
   qualquer WebSocket, inclusive um aberto por página maliciosa. Se o cookie
   bastasse, a conferência de `Origin` seria a ÚNICA coisa entre um anúncio
   malicioso e a conversa da empresa — e uma configuração errada de `Origin`
   viraria vazamento total.

   Com bilhete, o ataque morre na origem: a página maliciosa até consegue abrir
   o socket com o cookie da vítima, mas não tem bilhete, e não consegue obter um
   (obter exige ler a resposta de uma requisição entre sites, o que o navegador
   impede). A conferência de `Origin` continua existindo — como segunda tranca,
   que é o lugar dela.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");
const { iguaisEmTempoConstante } = require("./passe.js");

function criarSessoes({ repo, segredo, cookie = "cid", duracaoHoras = 12, seguro = true,
                        entreSites = false, caminho = "/chat" }) {
  const duracaoMs = duracaoHoras * 3600e3;
  const nomeCsrf = `${cookie}_csrf`;

  const hmac = (v) => crypto.createHmac("sha256", segredo).update(String(v)).digest("base64url");

  /* Bilhetes do WebSocket. Vivem só na memória: são de 30 segundos e de uso
     único, então perdê-los num reinício custa uma reconexão — e gravá-los no
     banco seria uma escrita por conexão para um dado que morre em meio minuto. */
  const bilhetes = new Map();   // bilhete -> { sessaoId, usuarioId, contextoId, expira }
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of bilhetes) if (v.expira <= t) bilhetes.delete(k);
  }, 30_000).unref();

  function lerCookie(req, nome) {
    const bruto = req.headers?.cookie || "";
    /* O nome é escapado antes de entrar na expressão: nome de cookie vem da
       configuração, e configuração com caractere especial viraria uma regex
       diferente da pretendida. */
    const escapado = nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|;\\s*)${escapado}=([^;]*)`).exec(bruto);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function cabecalhosDeCookie(token, sessaoId) {
    /* `SameSite` sai da decisão de arranjo explicada no topo. `Secure` é
       obrigatório com SameSite=None — sem ele o navegador DESCARTA o cookie,
       e o sintoma é "o chat não loga", sem erro nenhum no servidor. */
    const sameSite = entreSites ? "None" : "Strict";
    const flagSeguro = seguro || entreSites ? "; Secure" : "";
    const idade = Math.floor(duracaoMs / 1000);

    /* ======================================================================
       OS DOIS COOKIES TÊM ESCOPOS DIFERENTES, E ISSO É DELIBERADO.

       SESSÃO — `Path=/chat`. Ela vale como senha: quem a tiver É a pessoa.
       No arranjo recomendado o chat vive sob o domínio do site do cliente, e
       com `Path=/` esse token seria enviado em TODA requisição do site —
       cada página, cada imagem, cada folha de estilo. Bastaria o site registrar
       cabeçalhos no log de acesso (vários registram) para o token de sessão do
       chat ficar gravado em texto no disco do cliente.
       Restringindo o caminho, ele só viaja para as rotas do chat.

       CSRF — `Path=/`. Este PRECISA ser mais amplo, porque o JavaScript da
       PÁGINA do hospedeiro (que está em `/`) tem de conseguir lê-lo por
       `document.cookie` para devolvê-lo no cabeçalho. Com `Path=/chat` ele
       seria invisível para a página e nenhuma escrita funcionaria.

       A assimetria é segura: o token de CSRF sozinho não autentica nada —
       ele só prova que quem enviou consegue LER um cookie desta origem.
       ====================================================================== */
    return [
      `${cookie}=${token}; Path=${caminho}; HttpOnly; SameSite=${sameSite}${flagSeguro}; Max-Age=${idade}`,
      `${nomeCsrf}=${hmac(sessaoId)}; Path=/; SameSite=${sameSite}${flagSeguro}; Max-Age=${idade}`,
    ];
  }

  function cabecalhosDeSaida() {
    const sameSite = entreSites ? "None" : "Strict";
    const flagSeguro = seguro || entreSites ? "; Secure" : "";
    return [
      `${cookie}=; Path=${caminho}; HttpOnly; SameSite=${sameSite}${flagSeguro}; Max-Age=0`,
      `${nomeCsrf}=; Path=/; SameSite=${sameSite}${flagSeguro}; Max-Age=0`,
    ];
  }

  return {
    nomeCookie: cookie,
    nomeCsrf,

    /* ======================================================================
       ABRIR — depois de o passe ter sido conferido
       ====================================================================== */
    async abrir({ usuarioId, ipHash, agente }) {
      /* 32 bytes. Não é exagero: este valor é equivalente à senha da pessoa
         enquanto durar, e vive num cookie que trafega em toda requisição. */
      const token = crypto.randomBytes(32).toString("base64url");
      const sessaoId = await repo.abrir({ usuarioId, token, ipHash, agente, duracaoMs });
      return { token, sessaoId, cookies: cabecalhosDeCookie(token, sessaoId) };
    },

    async encerrar(req) {
      const token = lerCookie(req, cookie);
      if (token) await repo.encerrar(token);
      return cabecalhosDeSaida();
    },

    /* ======================================================================
       DE QUEM É ESTA REQUISIÇÃO
       ====================================================================== */
    async de(req) {
      const token = lerCookie(req, cookie);
      if (!token) return null;
      const s = await repo.porToken(token);
      if (!s) return null;

      /* Renovação por atividade, com escrita economizada (ver o repositório). */
      repo.renovar(s.id, duracaoMs).catch(() => { });

      return {
        sessaoId: s.id,
        usuarioId: s.usuario_id,
        contextoId: s.contexto_id,
        nome: [s.nome, s.sobrenome].filter(Boolean).join(" "),
        avatar: s.avatar || "",
        papel: s.papel,
        ehAdmin: s.papel === "admin",
        /* Vai junto para o WebSocket poder morrer quando a sessão morrer. Um
           socket aceito no aperto de mão não reconsulta a sessão a cada
           evento; sem este valor ele viveria além dela. */
        expiraEm: Number(s.expira_em) || 0,
      };
    },

    /* ======================================================================
       CSRF — exigido em TODA escrita

       GET e HEAD não passam por aqui porque não mudam nada. Se um dia algum
       GET mudar estado, o defeito é o GET, não esta conferência.
       ====================================================================== */
    conferirCsrf(req, sessaoId) {
      const doCabecalho = req.headers?.["x-chat-csrf"];
      if (!doCabecalho) return { ok: false, erro: "falta o cabeçalho X-Chat-Csrf" };
      const doCookie = lerCookie(req, nomeCsrf);
      if (!doCookie) return { ok: false, erro: "falta o cookie de CSRF" };

      /* As DUAS conferências. Bater cookie contra cabeçalho prova que quem
         mandou consegue LER o cookie (ou seja, é a mesma origem). Bater contra
         o HMAC da sessão prova que o valor é desta sessão, e não de outra que o
         atacante tenha aberto em nome próprio. Só a primeira seria burlável por
         quem consiga plantar um cookie no navegador da vítima. */
      if (!iguaisEmTempoConstante(doCabecalho, doCookie))
        return { ok: false, erro: "token CSRF não confere" };
      if (!iguaisEmTempoConstante(doCabecalho, hmac(sessaoId)))
        return { ok: false, erro: "token CSRF não pertence a esta sessão" };

      return { ok: true };
    },

    /* ======================================================================
       BILHETE DO WEBSOCKET
       ====================================================================== */
    emitirBilhete(sessao, validadeMs = 30_000) {
      const bilhete = crypto.randomBytes(24).toString("base64url");
      bilhetes.set(bilhete, {
        sessaoId: sessao.sessaoId,
        usuarioId: sessao.usuarioId,
        contextoId: sessao.contextoId,
        papel: sessao.papel,
        nome: sessao.nome,
        expira: Date.now() + validadeMs,
        /* Quando a SESSÃO expira — diferente de quando o BILHETE expira. O
           socket herda este prazo e cai com ele. */
        sessaoExpiraEm: Number(sessao.expiraEm) || (Date.now() + duracaoMs),
      });
      return bilhete;
    },

    /* USO ÚNICO: o bilhete é REMOVIDO ao ser conferido. Reconectar exige um
       bilhete novo — que é justamente o que impede alguém que tenha visto a URL
       (no log do nginx, no histórico do navegador, num Referer) de reusá-la. */
    resgatarBilhete(bilhete) {
      if (!bilhete) return null;
      const v = bilhetes.get(bilhete);
      if (!v) return null;
      bilhetes.delete(bilhete);
      if (v.expira <= Date.now()) return null;
      return v;
    },

    bilhetesAbertos: () => bilhetes.size,
  };
}

module.exports = { criarSessoes };
