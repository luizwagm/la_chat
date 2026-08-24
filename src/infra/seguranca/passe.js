/* ==========================================================================
   passe.js — como o chat sabe quem é a pessoa sem pedir senha (§18)

   O PROBLEMA

   O hospedeiro já autenticou o funcionário: ele tem a própria sessão, a
   própria tela de login, o próprio cadastro. O chat precisa saber a mesma
   coisa sem (a) pedir uma segunda senha, (b) manter um segundo cadastro de
   pessoas, (c) receber acesso ao banco de usuários do cliente.

   O QUE FOI DESCARTADO, E POR QUÊ

   · SESSÃO COMPARTILHADA (ler o cookie do hospedeiro). Exigiria que o chat
     conhecesse o formato de sessão de CADA sistema onde for instalado —
     acoplamento máximo, exatamente o que o §2 proíbe. E daria ao chat poder de
     forjar sessão do sistema do cliente.

   · O NAVEGADOR MANDAR "eu sou o João". É o modelo de segurança de um bilhete
     escrito a lápis. Óbvio, mas é o que acontece quando se aceita
     `?usuario=123` vindo do front.

   · JWT DE LONGA DURAÇÃO NO NAVEGADOR. Um token de horas, guardado no
     `localStorage`, é roubável por qualquer XSS em qualquer página do site e
     não dá para revogar antes de expirar.

   A ESCOLHA: PASSE CURTO, DE USO ÚNICO, ASSINADO PELOS DOIS LADOS

       1. o navegador pede um passe ao HOSPEDEIRO (rota do conector)
       2. o hospedeiro olha a PRÓPRIA sessão e assina os dados da pessoa
       3. o navegador entrega o passe ao CHAT, uma vez só
       4. o chat confere a assinatura e abre sessão PRÓPRIA (cookie HttpOnly)

   As quatro propriedades que fazem isso valer:

   · O SEGREDO NUNCA VAI AO NAVEGADOR. Ele mora em /etc/lachat.env dos dois
     lados. O navegador só carrega o resultado assinado.
   · VIDA DE 60 SEGUNDOS. Interceptar um passe em trânsito quase nunca serve, e
     nunca serve depois.
   · USO ÚNICO (`jti` guardado até expirar). Mesmo dentro dos 60 s, o segundo
     uso é recusado — quem interceptou perde para o dono legítimo.
   · A ASSINATURA COBRE TUDO. Nome, papel e contexto entram no corpo assinado;
     mexer em qualquer campo invalida.

   ---------------------------------------------------------------------------
   POR QUE HMAC-SHA256 E NÃO "UM JWT DE VERDADE"

   Porque o formato de JWT traz a família inteira de armadilhas dele — `alg:
   none`, confusão entre HS256 e RS256, bibliotecas que aceitam o algoritmo
   escrito pelo atacante DENTRO do próprio token. Nada disso existe aqui: o
   algoritmo é fixo no código, não vem no token, e não há negociação nenhuma.

   É o mesmo esquema que o conector do LA Sentinela já usa em produção neste
   parque.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const deB64url = (s) => Buffer.from(String(s), "base64url");

/* ==========================================================================
   COMPARAÇÃO EM TEMPO CONSTANTE

   `assinatura === esperada` compara byte a byte e PARA no primeiro diferente.
   A diferença de tempo é minúscula, mas mensurável por rede em muitas
   tentativas — e permite descobrir a assinatura correta um byte de cada vez,
   sem nunca conhecer o segredo. `timingSafeEqual` compara tudo sempre.

   Os tamanhos são conferidos ANTES: `timingSafeEqual` LANÇA quando os buffers
   têm tamanhos diferentes, e uma exceção não tratada aqui viraria erro 500
   numa rota de autenticação — que além de derrubar o login, informa ao
   atacante que o tamanho estava errado.
   ========================================================================== */
function iguaisEmTempoConstante(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function criarPasses({ segredo, validadeSegundos = 60 }) {
  if (!segredo || String(segredo).length < 32)
    throw new Error("CHAT_SEGREDO_PASSE precisa ter pelo menos 32 caracteres");

  const chave = Buffer.from(String(segredo));
  const assinar = (texto) => b64url(crypto.createHmac("sha256", chave).update(texto).digest());

  return {
    /* ======================================================================
       EMITIR — roda no HOSPEDEIRO (dentro do conector)

       Recebe o que o site sabe sobre a pessoa. Nada aqui vem do navegador.
       ====================================================================== */
    emitir(usuario, { contexto = "padrao" } = {}) {
      if (!usuario || !usuario.id || !usuario.nome)
        throw new Error("passe exige, no mínimo, id e nome do usuário");

      const iat = Math.floor(Date.now() / 1000);
      const corpo = {
        sub: String(usuario.id),
        /* QUEM A PESSOA É, quando o hospedeiro sabe dizer por algo que
           sobrevive à troca de conta (ver a migração 002). O passe precisa
           carregá-la porque ENTRAR também cria pessoa: se só o elenco a
           levasse, um login por uma conta que não fosse a última sincronizada
           criaria a segunda ficha — que é exatamente o defeito que a
           identidade veio consertar.

           Vai DENTRO do corpo assinado, como todo o resto: uma identidade que
           viajasse fora da assinatura seria um campo pelo qual alguém escolhe
           de quem quer ser a conversa. */
        ident: String(usuario.identidade || "").slice(0, 120),
        nome: String(usuario.nome).slice(0, 120),
        sobrenome: String(usuario.sobrenome || "").slice(0, 120),
        email: String(usuario.email || "").slice(0, 200),
        avatar: String(usuario.avatar || "").slice(0, 500),
        cargo: String(usuario.cargo || "").slice(0, 120),
        departamento: String(usuario.departamento || "").slice(0, 120),
        /* Só dois papéis atravessam a fronteira. Um papel livre vindo do
           hospedeiro viraria escalonamento de privilégio se o site do cliente
           tivesse um bug — aqui, o que não for "admin" é "membro". */
        papel: usuario.papel === "admin" ? "admin" : "membro",
        /* ==================================================================
           A CAPACIDADE, e não um papel novo

           O papel continua fechado em dois valores, pela razão de sempre. Mas
           os clientes têm mais perfis do que isso, e alguns deles precisam
           criar reunião por link.

           Uma capacidade NOMEADA delega exatamente uma decisão — a que o
           cliente quis delegar — em vez de dar ao hospedeiro o poder de
           inventar privilégios que o chat não previu. O pior que um site com
           defeito consegue aqui é deixar alguém criar um link.

           Booleano forçado: qualquer coisa que venha do hospedeiro vira
           `true` ou `false`, nunca um valor de confiança.
           ================================================================== */
        sala: !!usuario.podeSala,
        ctx: String(contexto).slice(0, 60),
        iat,
        exp: iat + validadeSegundos,
        /* O identificador único do passe. É ele que a trava de repetição
           guarda. 16 bytes aleatórios: adivinhar um jti não serve de nada,
           mas repetir um previsível serviria. */
        jti: crypto.randomBytes(16).toString("base64url"),
      };

      const corpoB64 = b64url(JSON.stringify(corpo));
      return `${corpoB64}.${assinar(corpoB64)}`;
    },

    /* ======================================================================
       CONFERIR — roda no CHAT

       A ORDEM DAS CONFERÊNCIAS IMPORTA. A assinatura é conferida ANTES de
       qualquer coisa ser lida do corpo. Se o conteúdo fosse interpretado
       primeiro (para "ver se expirou", por exemplo), o chat estaria
       processando JSON escolhido pelo atacante antes de saber se ele tem
       direito de mandar JSON nenhum.
       ====================================================================== */
    conferir(passe) {
      if (typeof passe !== "string" || passe.length > 4000)
        return { ok: false, erro: "passe ausente ou grande demais" };

      const ponto = passe.indexOf(".");
      if (ponto < 1) return { ok: false, erro: "passe malformado" };

      const corpoB64 = passe.slice(0, ponto);
      const assinatura = passe.slice(ponto + 1);

      if (!iguaisEmTempoConstante(assinatura, assinar(corpoB64)))
        return { ok: false, erro: "assinatura inválida" };

      let corpo;
      try {
        corpo = JSON.parse(deB64url(corpoB64).toString("utf8"));
      } catch {
        return { ok: false, erro: "corpo ilegível" };
      }

      const agoraS = Math.floor(Date.now() / 1000);

      if (!corpo.exp || agoraS > corpo.exp)
        return { ok: false, erro: "passe expirado" };

      /* Passe emitido no FUTURO é sinal de relógio dessincronizado entre o
         hospedeiro e o chat. 60 s de tolerância cobrem o desvio normal; além
         disso, recusar é o certo — um passe "do futuro" com validade longa
         seria um passe eterno. */
      if (corpo.iat && corpo.iat > agoraS + 60)
        return { ok: false, erro: "relógio do hospedeiro está adiantado" };

      if (!corpo.sub || !corpo.nome || !corpo.jti)
        return { ok: false, erro: "passe incompleto" };

      return {
        ok: true,
        jti: corpo.jti,
        expiraEm: corpo.exp * 1000,
        contexto: corpo.ctx || "padrao",
        /* A versão do conector que emitiu este passe. Ausente = anterior à
           1.6, quando o campo nasceu. */
        versaoConector: String(corpo.cv || "") || null,
        usuario: {
          id: corpo.sub,
          identidade: corpo.ident || "",
          nome: corpo.nome,
          sobrenome: corpo.sobrenome || "",
          email: corpo.email || "",
          avatar: corpo.avatar || "",
          cargo: corpo.cargo || "",
          departamento: corpo.departamento || "",
          papel: corpo.papel === "admin" ? "admin" : "membro",
          podeSala: !!corpo.sala,
        },
      };
    },
  };
}

module.exports = { criarPasses, iguaisEmTempoConstante };
