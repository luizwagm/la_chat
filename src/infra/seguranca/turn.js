/* ==========================================================================
   turn.js — as credenciais do servidor de relay

   ---------------------------------------------------------------------------
   POR QUE TURN EXISTE, E POR QUE NÃO É OPCIONAL

   O WebRTC tenta conectar os dois navegadores DIRETO. Na maioria das vezes
   consegue, com a ajuda do STUN (que só responde "o teu IP público é este").

   Entre 15% e 20% das vezes não consegue: NAT simétrico, firewall corporativo
   bloqueando UDP, operadora de celular com CGNAT. Nesses casos a mídia precisa
   de um intermediário que receba de um lado e mande para o outro — o TURN.

   E essa fatia NÃO é aleatória: ela se concentra em rede de empresa, que é
   exatamente o público deste chat. Sem TURN, o sintoma é "às vezes a chamada
   não conecta", intermitente e concentrado no cliente que mais importa. É o
   pior defeito possível de diagnosticar.

   ---------------------------------------------------------------------------
   POR QUE A CREDENCIAL É TEMPORÁRIA — e por que isso não é preciosismo

   A tentação é pôr usuário e senha fixos no `.env` e mandá-los ao navegador.
   Só que a credencial VAI para o navegador: ela aparece no DevTools de
   qualquer pessoa da empresa, e daí para um fórum é um passo.

   Um TURN com credencial fixa vazada é banda de graça para estranhos — o seu
   servidor vira relay de terceiros, e a conta é sua. Isso acontece o tempo
   todo com instalações de coturn.

   O coturn resolve isso com `use-auth-secret`: o servidor e o chat compartilham
   UM segredo, que nunca sai do servidor, e a credencial entregue ao navegador é
   derivada dele com prazo:

       usuário  = <instante de expiração em epoch>:<id do usuário>
       senha    = base64( HMAC-SHA1( segredo, usuário ) )

   O coturn refaz a mesma conta ao receber a conexão. Credencial vazada expira
   sozinha em horas, e ainda diz QUEM a pediu.

   ---------------------------------------------------------------------------
   SHA-1 AQUI NÃO É DESCUIDO

   É o que o RFC 5766 (TURN REST API) especifica e o que o coturn implementa —
   não há escolha. E o uso é HMAC para autenticação de curta duração, não
   assinatura de documento: as fraquezas conhecidas do SHA-1 (colisão) não se
   aplicam a HMAC-SHA1. O que protege aqui é o segredo e o prazo.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");

/* ==========================================================================
   O PRAZO

   Duas horas: uma reunião longa cabe inteira, e uma credencial roubada morre
   no mesmo turno. Prazo curto demais (minutos) faria a chamada cair no meio se
   a renegociação de ICE acontecesse depois da expiração — que é justamente
   quando a rede está ruim e o relay é mais necessário.
   ========================================================================== */
const TTL_PADRAO = 2 * 3600;

function criarTurn({ urls = [], segredo = "", stun = [], ttlSegundos = TTL_PADRAO,
                     soRelay = false, salaRelay = true } = {}) {
  const temTurn = !!(urls.length && segredo);

  if (urls.length && !segredo) {
    /* Recusar seria pior: o chat inteiro deixaria de subir por causa do vídeo.
       Mas o aviso é alto, porque uma lista de TURN sem segredo é uma lista de
       TURN que não funciona — e o defeito só aparece nas chamadas que
       precisavam de relay, ou seja, nas do cliente corporativo. */
    console.warn("  ⚠ CHAT_TURN definido sem CHAT_TURN_SEGREDO — o relay NÃO será usado.");
    console.warn("    Chamadas atrás de NAT simétrico ou firewall corporativo vão falhar.");
  }

  return {
    ativo: temTurn,
    soRelay: !!soRelay,

    /* ======================================================================
       AS CREDENCIAIS PARA UM USUÁRIO

       Devolve no formato que o `RTCPeerConnection` espera direto. O `iceServers`
       é montado no servidor, e não no cliente, porque o cliente não pode
       conhecer o segredo — e porque assim trocar de provedor de TURN é mexer
       numa variável de ambiente, sem tocar no navegador de ninguém.
       ====================================================================== */
    /* ======================================================================
       `aberta` — a política que não podia ser só global

       `CHAT_VIDEO_SO_RELAY` é chave de instalação: ou a empresa inteira passa
       pelo relay, ou ninguém passa. Isso serve mal ao caso que a reunião por
       link criou, porque os dois casos são diferentes:

         · entre COLEGAS o IP alheio não é segredo — mesma rede, mesmo prédio,
           mesmo cadastro. Forçar relay ali só gasta banda;

         · numa REUNIÃO POR LINK o IP é a única coisa que um estranho leva
           embora sem pedir. Na malha direta, quem recebe o convite descobre de
           onde o funcionário fala — casa, escritório, celular — e vice-versa.
           Ninguém pediu isso e ninguém foi avisado.

       Por isso a decisão passa a ser por CHAMADA. E ela é tomada na ABERTURA
       da sala, não quando o primeiro convidado chega: se só um dos lados
       estivesse em `relay`, o outro continuaria ANUNCIANDO os próprios
       candidatos, e o endereço vazaria assim mesmo. Política de transporte é
       decisão dos dois, ou não é de ninguém.
       ====================================================================== */
    credenciais(usuarioId, { aberta = false } = {}) {
      const servidores = [];

      for (const u of stun) servidores.push({ urls: u });

      if (temTurn) {
        const expira = Math.floor(Date.now() / 1000) + ttlSegundos;
        /* O id do usuário entra no nome de propósito: o log do coturn passa a
           dizer QUEM usou o relay, o que transforma "a banda subiu" numa
           pergunta respondível. */
        const usuario = `${expira}:${String(usuarioId || "anon").slice(0, 60)}`;
        const senha = crypto.createHmac("sha1", segredo).update(usuario).digest("base64");

        servidores.push({ urls: urls.slice(), username: usuario, credential: senha });
      }

      return {
        iceServers: servidores,
        /* `relay` força TODA a mídia pelo TURN: ninguém vê o IP de ninguém,
           ao custo de banda e um pouco de latência.

           O `temTurn` NÃO É DETALHE. Pedir `relay` sem servidor de relay não
           deixa a chamada mais privada: deixa a chamada IMPOSSÍVEL, porque o
           navegador descarta todo candidato que não seja de relay e não sobra
           nenhum. Falharia em silêncio, com cara de problema de rede. */
        /* `salaRelay` é a válvula: desligada, a reunião por link volta a
           tentar o caminho direto. Custa a privacidade do IP e devolve a
           reunião a quem está com o relay quebrado — ver config.js. */
        iceTransportPolicy: (soRelay || (aberta && salaRelay)) && temTurn ? "relay" : "all",
        expiraEm: temTurn ? Date.now() + ttlSegundos * 1000 : 0,
      };
    },

    /* Refaz a conta do coturn. Existe para a suíte poder provar que a
       credencial é a esperada sem subir um coturn de verdade — e para o
       `verificar.sh` conferir o segredo dos dois lados. */
    conferir(usuario, senha) {
      if (!temTurn) return false;
      const esperada = crypto.createHmac("sha1", segredo).update(String(usuario)).digest("base64");
      const a = Buffer.from(String(senha));
      const b = Buffer.from(esperada);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    },
  };
}

module.exports = { criarTurn, TTL_PADRAO };
