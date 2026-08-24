/* ==========================================================================
   origem.js — de qual site veio esta requisição (§17)

   Este arquivo existe por causa de UMA frase, que é a mais importante deste
   projeto inteiro:

       O NAVEGADOR NÃO APLICA SAME-ORIGIN A WEBSOCKET.

   Tudo que se sabe sobre segurança de navegador — "outro site não consegue ler
   a resposta da minha API" — vale para `fetch` e `XMLHttpRequest`. NÃO vale
   para `new WebSocket(...)`. Qualquer página, de qualquer domínio, pode abrir
   um WebSocket para o nosso servidor, e o navegador ANEXA OS COOKIES da vítima
   nessa conexão de bom grado.

   O ataque completo (Cross-Site WebSocket Hijacking) é este:

       1. o funcionário está logado no chat da empresa (cookie válido);
       2. ele visita qualquer página — um anúncio, um link de e-mail;
       3. essa página roda:  new WebSocket("wss://chat.empresa.com/ws")
       4. o navegador manda o cookie. O servidor autentica. Pronto:
          o atacante lê e escreve mensagens em nome dele, ao vivo.

   Nenhuma senha foi roubada. Nenhum XSS foi necessário. E do lado do servidor
   parece uma conexão perfeitamente normal.

   A ÚNICA DEFESA no aperto de mão é conferir o cabeçalho `Origin` contra uma
   lista branca — e é isto que este arquivo faz. Não é "defesa em profundidade";
   é a defesa.

   ---------------------------------------------------------------------------
   POR QUE `Origin` PODE SER CONFIADO AQUI

   `Origin` é um cabeçalho PROTEGIDO: JavaScript de página não consegue
   alterá-lo. Um cliente que não seja navegador (curl, script) pode escrever o
   que quiser — mas esse cliente também não tem o cookie da vítima. A conferência
   não serve contra um atacante com credencial; serve contra um atacante que
   usa o navegador DA VÍTIMA como intermediário, e nesse caso o Origin é
   verdadeiro.

   ---------------------------------------------------------------------------
   VAZIO SIGNIFICA RECUSAR TODO MUNDO

   A lista de origens é obrigatória em produção (ver `config.js`). Um padrão
   permissivo aqui seria pior que não ter conferência nenhuma, porque
   pareceria protegido.
   ========================================================================== */
"use strict";

/* Normaliza para comparar: sem barra no fim, minúsculas, e porta padrão
   removida. Sem isso, "https://x.com" e "https://x.com/" e "https://X.com:443"
   seriam três origens diferentes — e a instalação falharia por um detalhe de
   digitação, o que leva a pessoa a "resolver" liberando tudo. */
function normalizar(origem) {
  const o = String(origem || "").trim().toLowerCase().replace(/\/+$/, "");
  if (!o) return "";
  try {
    const u = new URL(o);
    const portaPadrao = (u.protocol === "https:" && u.port === "443") ||
                        (u.protocol === "http:" && u.port === "80");
    return `${u.protocol}//${u.hostname}${u.port && !portaPadrao ? ":" + u.port : ""}`;
  } catch {
    return "";
  }
}

/* ==========================================================================
   A PRÓPRIA ORIGEM NUNCA PRECISOU DE CONVITE

   Desde que existe a página do convidado (`/call/<codigo>`), este serviço
   passou a servir HTML — e os pedidos dessa página trazem `Origin` igual ao
   endereço do PRÓPRIO chat. Sem a linha abaixo, ela era recusada com
   "Origem não autorizada", que é uma frase correta sobre um site invasor e
   sem sentido nenhum sobre uma página que este servidor acabou de entregar.

   Isto NÃO afrouxa a defesa contra CSWSH. O ataque é um site de TERCEIROS
   usando o navegador da vítima; um pedido cuja origem é a nossa é, por
   definição, mesma origem — o caso que toda a conferência existe para
   distinguir do outro. Quem já está na nossa origem não precisa do
   `Origin` para nos alcançar.

   E o valor vem de `CHAT_BASE`, que é configuração do servidor: não há
   como um visitante pôr a própria origem aqui dentro.
   ========================================================================== */
function criarPorteiro(origensPermitidas = [], base = "") {
  const lista = new Set(origensPermitidas.map(normalizar).filter(Boolean));
  const propria = normalizar(base);
  if (propria) lista.add(propria);

  return {
    lista: [...lista],

    /* ======================================================================
       PARA O APERTO DE MÃO DO WEBSOCKET

       `Origin` AUSENTE é recusado quando há lista configurada. Um navegador
       SEMPRE manda Origin ao abrir WebSocket; ausência significa "não é
       navegador" — e um cliente que não é navegador não deveria estar usando
       um cookie de sessão de navegador.

       (Em desenvolvimento, sem lista configurada, tudo passa — senão nada
       funcionaria em localhost. É por isso que `config.js` torna a lista
       obrigatória em produção: aqui, "sem lista" tem de ser impossível lá.)
       ====================================================================== */
    aceitaWebSocket(req) {
      if (!lista.size) return { ok: true, motivo: "sem lista (desenvolvimento)" };
      const o = normalizar(req.headers?.origin);
      if (!o) return { ok: false, motivo: "sem cabeçalho Origin" };
      if (!lista.has(o)) return { ok: false, motivo: `origem não autorizada: ${o}` };
      return { ok: true, origem: o };
    },

    /* ======================================================================
       PARA AS REQUISIÇÕES HTTP

       O chat é embutido em página de OUTRO domínio, então precisa de CORS com
       credenciais. E aí vale a regra que costuma ser violada:

           Access-Control-Allow-Origin NUNCA pode ser "*" junto com
           Access-Control-Allow-Credentials: true.

       O navegador até recusa essa combinação — mas o instinto de quem está
       depurando é justamente pôr "*" para "ver se funciona", e daí a "*" fica.
       Aqui só sai o valor EXATO da origem que pediu, e só se ela estiver na
       lista. É por construção que "*" não pode acontecer.
       ====================================================================== */
    cabecalhosCors(req) {
      const o = normalizar(req.headers?.origin);
      if (!o) return {};
      if (lista.size && !lista.has(o)) return {};
      return {
        "Access-Control-Allow-Origin": o,
        "Access-Control-Allow-Credentials": "true",
        /* `Vary: Origin` é obrigatório: sem ele, um proxy (ou o próprio nginx)
           guarda a resposta com o CORS de UMA origem e a devolve para outra.
           O sintoma é o chat funcionar num site e falhar em outro, sem padrão. */
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        /* `X-Chat-Como` diz com qual identidade o pedido fala — funcionário
           ou convidado de sala. Sem ele na lista, o pré-voo do navegador
           reprova o cabeçalho no ARRANJO B (chat em subdomínio próprio) e o
           convidado volta a ser confundido com o funcionário. */
        "Access-Control-Allow-Headers": "Content-Type, X-Chat-Csrf, X-Chat-Como",
        "Access-Control-Max-Age": "600",
      };
    },

    aceitaHttp(req) {
      if (!lista.size) return true;
      const o = normalizar(req.headers?.origin);
      /* Requisição sem Origin é permitida no HTTP: navegação normal e GET
         simples não mandam o cabeçalho. O que protege a ESCRITA nesse caso é o
         `SameSite=Strict` do cookie somado ao token CSRF — ver csrf.js. */
      if (!o) return true;
      return lista.has(o);
    },
  };
}

module.exports = { criarPorteiro, normalizar };
