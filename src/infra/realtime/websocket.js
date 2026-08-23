/* ==========================================================================
   realtime/websocket.js — o canal de tempo real

   ---------------------------------------------------------------------------
   AS QUATRO TRAVAS DO APERTO DE MÃO, na ordem em que rodam

   1. ORIGEM. `Origin` conferido contra a lista branca. O navegador NÃO aplica
      same-origin a WebSocket — ver `seguranca/origem.js`, que explica o ataque
      inteiro.

   2. BILHETE, e NÃO COOKIE. O socket é autenticado por um bilhete de 30 s, de
      uso único, obtido antes por uma requisição HTTP normal (que passou por
      cookie, CSRF e Origin). É esta trava que mata o Cross-Site WebSocket
      Hijacking na raiz: a página maliciosa consegue abrir o socket com o
      cookie da vítima, mas não tem bilhete e não consegue obter um.

   3. TETO DE CONEXÕES POR PESSOA. Sem ele, uma aba com defeito (ou um
      roteiro) abre mil sockets e consome a memória do servidor — cada socket
      tem buffers do kernel, e mil deles derrubam um servidor que hospeda
      vinte sites.

   4. LIMITE DE TAMANHO DE QUADRO. `maxPayload` no `ws`. Um quadro anunciando
      500 MB faria o servidor alocar 500 MB a pedido de quem conectou. É a
      negação de serviço mais barata que existe contra WebSocket.

   ---------------------------------------------------------------------------
   POR QUE `noServer: true`

   Porque assim o aperto de mão só acontece DEPOIS das travas. Com o `ws`
   ligado direto no servidor HTTP, a conexão é aceita primeiro e a checagem
   viria depois — e nesse intervalo o socket já existe, já consome recursos, e
   já pode ter recebido dados.

   ---------------------------------------------------------------------------
   O BATIMENTO — e por que ele não é opcional

   Um socket cujo cabo foi arrancado, ou cujo notebook foi fechado, NÃO fecha
   do lado do servidor. Ele fica aberto por minutos, às vezes horas, até o
   TCP desistir. Sem batimento, essas pessoas ficam "online" para todos os
   colegas, e o servidor guarda conexões mortas.

   Ping a cada 25 s (menor que o tempo em que proxies e NAT fecham conexão
   parada); quem não devolver pong dentro de 60 s é derrubado.
   ========================================================================== */
"use strict";

const { WebSocketServer } = require("ws");
const { TIPOS } = require("./transporte.js");

function criarTransporteWS({ conf, porteiro, sessoes, servico, chamadas, repos, limites, ipDe, ipEmHash }) {
  const wss = new WebSocketServer({
    noServer: true,
    /* Quadro maior que o teto derruba a conexão em vez de alocar. */
    maxPayload: conf.realtime.quadroMaximo,
    /* Compressão DESLIGADA de propósito. `permessage-deflate` no `ws` aloca
       um contexto de zlib POR CONEXÃO (~300 KB), o que com 500 pessoas
       conectadas são 150 MB só de compressor. E as mensagens de chat são
       pequenas — comprimir 80 bytes custa CPU e não economiza rede. */
    perMessageDeflate: false,
  });

  /* usuarioId -> Set<ws>. É a lista de para quem `publicar` consegue empurrar
     algo AGORA. Não é a fonte da verdade sobre presença — essa é o
     `expira_em` no banco, que sobrevive à morte do processo. */
  const porUsuario = new Map();

  function registrar(ws) {
    if (!porUsuario.has(ws.usuarioId)) porUsuario.set(ws.usuarioId, new Set());
    porUsuario.get(ws.usuarioId).add(ws);
  }
  function desregistrar(ws) {
    const s = porUsuario.get(ws.usuarioId);
    if (!s) return 0;
    s.delete(ws);
    if (!s.size) porUsuario.delete(ws.usuarioId);
    return s.size;
  }

  const enviar = (ws, obj) => {
    /* readyState 1 = OPEN. Escrever num socket fechando lança, e uma exceção
       no meio de um fan-out de 30 pessoas interromperia a entrega para as
       outras 29. */
    if (ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  };

  /* ==========================================================================
     RECUSAR O APERTO DE MÃO

     Responde HTTP cru e fecha. É preciso escrever a resposta na mão porque
     neste ponto o socket já saiu do servidor HTTP — não há `res` para usar.

     A mensagem é GENÉRICA de propósito. Dizer "bilhete inválido" versus
     "origem não autorizada" contaria ao atacante qual trava ele precisa
     contornar. O motivo real vai para o log e para a auditoria.
     ========================================================================== */
  function recusar(socket, codigo = 401, motivo = "") {
    try {
      socket.write(
        `HTTP/1.1 ${codigo} ${codigo === 429 ? "Too Many Requests" : "Unauthorized"}\r\n` +
        "Connection: close\r\nContent-Length: 0\r\n\r\n");
    } catch { }
    try { socket.destroy(); } catch { }
    if (motivo && process.env.CHAT_DEBUG) console.warn("  · ws recusado:", motivo);
  }

  const transporte = {
    tipo: "websocket",

    /* ======================================================================
       O APERTO DE MÃO
       ====================================================================== */
    async aceitar(req, socket, cabeca) {
      const ip = ipDe(req);

      /* Trava 1 — origem. */
      const origem = porteiro.aceitaWebSocket(req);
      if (!origem.ok) {
        await repos.auditoria.registrar({
          contextoId: "", evento: "ORIGEM_RECUSADA", ipHash: ipEmHash(ip),
          detalhe: origem.motivo,
        });
        return recusar(socket, 403, origem.motivo);
      }

      /* Freio por IP no próprio aperto de mão: sem ele, abrir e fechar
         conexões em rajada custa caro ao servidor e nada a quem ataca. */
      const freio = limites.conferir(`ws:${ipEmHash(ip)}`, { maximo: 60, janelaMs: 60e3 });
      if (!freio.ok) return recusar(socket, 429, "rajada de conexões");

      /* Trava 2 — bilhete. Uso único: `resgatar` já o remove. */
      let bilhete = "";
      try {
        bilhete = new URL(req.url, "http://interno").searchParams.get("t") || "";
      } catch { /* URL malformada: cai no recuse abaixo */ }

      const dono = sessoes.resgatarBilhete(bilhete);
      if (!dono) return recusar(socket, 401, "bilhete ausente, expirado ou já usado");

      /* Trava 3 — teto de conexões por pessoa. */
      const abertas = porUsuario.get(dono.usuarioId)?.size || 0;
      if (abertas >= conf.limites.conexoesPorUsuario)
        return recusar(socket, 429, "conexões demais para o mesmo usuário");

      wss.handleUpgrade(req, socket, cabeca, (ws) => {
        ws.usuarioId = dono.usuarioId;
        ws.contextoId = dono.contextoId;
        ws.sessaoId = dono.sessaoId;
        ws.papel = dono.papel;
        ws.nome = dono.nome;
        ws.vivo = true;
        ws.ipHash = ipEmHash(ip);
        /* O socket não sobrevive à sessão que o autorizou. Sem isto, uma aba
           esquecida aberta continuaria recebendo mensagens muito depois de a
           sessão ter expirado — o aperto de mão autentica UMA vez, e nada
           mais consultava a sessão. */
        ws.sessaoExpiraEm = Number(dono.sessaoExpiraEm) || 0;

        registrar(ws);
        repos.presenca.abriuCanal(dono.usuarioId, conf.realtime.mortoMs).catch(() => { });

        enviar(ws, { t: TIPOS.PRONTO, u: dono.usuarioId, agora: Date.now() });

        ws.on("pong", () => {
          ws.vivo = true;
          repos.presenca.batimento(ws.usuarioId, conf.realtime.mortoMs).catch(() => { });
        });

        ws.on("message", (dados) => tratarMensagem(ws, dados));

        ws.on("close", () => {
          const restantes = desregistrar(ws);

          /* FECHAR A ABA NÃO MANDA "SAIR DA REUNIÃO".

             Sem esta linha a pessoa fica eternamente `dentro` para os outros —
             um retrato congelado no grid — e a chamada nunca encerra sozinha,
             o que trava o índice único e faz o botão de chamar "parar de
             funcionar" naquela conversa.

             Só quando a ÚLTIMA conexão dela cai: fechar uma de duas abas não
             tira ninguém da reunião. */
          if (restantes === 0) chamadas?.socketCaiu(ws.usuarioId);

          repos.presenca
            .fechouCanal(ws.usuarioId, restantes, conf.realtime.carenciaOfflineMs)
            .then((ficouOffline) => {
              /* Só avisa os outros quando a ÚLTIMA conexão caiu. Avisar a cada
                 aba fechada faria o status piscar na tela de todo mundo. */
              if (ficouOffline) transporte.anunciarStatus(ws.contextoId, ws.usuarioId);
            })
            .catch(() => { });
        });

        /* Um erro de socket NÃO pode subir como exceção não tratada: 'error'
           sem ouvinte derruba o processo inteiro no Node. Uma conexão ruim tem
           de custar uma conexão, não o serviço. */
        ws.on("error", () => { try { ws.terminate(); } catch { } });
      });
    },

    /* ======================================================================
       PUBLICAR — o fan-out

       Recebe a lista de quem PODE receber (vinda da consulta de membros no
       banco) e entrega a quem estiver conectado. A autorização acontece antes
       de chegar aqui, e nunca sobre a lista de conexões abertas: quem está
       conectado não é a mesma coisa que quem tem direito.
       ====================================================================== */
    publicar(usuarioIds, evento, { exceto = null } = {}) {
      const texto = JSON.stringify(evento);
      let entregues = 0;
      for (const id of usuarioIds || []) {
        if (exceto && id === exceto) continue;
        const conexoes = porUsuario.get(id);
        if (!conexoes) continue;
        for (const ws of conexoes) {
          if (ws.readyState !== 1) continue;
          try { ws.send(texto); entregues++; } catch { /* uma conexão ruim não para as outras */ }
        }
      }
      return entregues;
    },

    /* Avisa os colegas que o status de alguém mudou.

       O aviso vai para TODO o contexto, e não só para quem conversa com a
       pessoa: a barra lateral mostra "quem está online" da empresa inteira.
       Só o id e o status viajam — nada mais. */
    async anunciarStatus(contextoId, usuarioId) {
      try {
        const s = await repos.presenca.de(usuarioId);
        /* SÓ o contexto da pessoa. Antes ia para TODO mundo conectado, e o
           status de um funcionário da empresa A aparecia no navegador de
           alguém da empresa B — quebrando o isolamento do §22 por um caminho
           que nenhuma consulta ao banco atravessava. */
        transporte.publicar(transporte.ligados(contextoId).filter((id) => id !== usuarioId),
          { t: TIPOS.STATUS, u: usuarioId, s: s.status });
      } catch { /* status é informativo: falhar aqui não pode quebrar nada */ }
    },

    encerrar(usuarioId, motivo = "sessao encerrada") {
      const conexoes = porUsuario.get(usuarioId);
      if (!conexoes) return 0;
      let n = 0;
      for (const ws of [...conexoes]) {
        /* `close` avisa o cliente com um código próprio (4001), para ele
           entender que não deve reconectar em laço; `terminate` logo depois
           garante a queda mesmo se o outro lado não responder ao fechamento. */
        try { ws.close(4001, motivo); } catch { }
        try { ws.terminate(); } catch { }
        n++;
      }
      porUsuario.delete(usuarioId);
      return n;
    },

    /* Quem está com canal aberto. Com `contextoId`, só os daquele contexto —
       é o que impede um aviso de presença de atravessar a fronteira entre
       empresas. Sem argumento, todos (usado só por diagnóstico). */
    ligados: (contextoId = null) => {
      if (!contextoId) return [...porUsuario.keys()];
      const alvos = [];
      for (const [id, conexoes] of porUsuario) {
        for (const ws of conexoes) {
          if (ws.contextoId === contextoId) { alvos.push(id); break; }
        }
      }
      return alvos;
    },
    conexoes: () => [...porUsuario.values()].reduce((a, s) => a + s.size, 0),

    encerrarTudo() {
      clearInterval(batimento);
      for (const conexoes of porUsuario.values())
        for (const ws of conexoes) { try { ws.terminate(); } catch { } }
      porUsuario.clear();
      try { wss.close(); } catch { }
    },
  };

  /* ==========================================================================
     O QUE O CLIENTE PODE MANDAR

     Lista curta e fechada. Tudo que MUDA dados de verdade (enviar mensagem,
     enviar arquivo) continua indo por HTTP, onde já existe CSRF, limitador e
     tratamento de erro. Pelo socket passam só avisos leves e de alta
     frequência — que é exatamente onde o WebSocket paga.

     Uma mensagem desconhecida é IGNORADA em silêncio, e não respondida com
     erro: responder daria ao atacante um oráculo para descobrir quais tipos
     existem.
     ========================================================================== */
  async function tratarMensagem(ws, dados) {
    let m;
    try {
      const texto = typeof dados === "string" ? dados : dados.toString("utf8");
      /* Teto antes do parse: `JSON.parse` de 60 KB de lixo já é trabalho a
         pedido de quem conectou. O `maxPayload` do `ws` já corta bem antes,
         mas esta linha é a que sobrevive a alguém mexer na configuração. */
      if (texto.length > 8192) return;
      m = JSON.parse(texto);
    } catch { return; }
    if (!m || typeof m.t !== "string") return;

    /* Freio por CONEXÃO. O cliente honesto manda um punhado de avisos por
       minuto; um cliente modificado mandaria milhares. */
    const ok = limites.conferir(`wsmsg:${ws.sessaoId}`, { maximo: 240, janelaMs: 60e3 });
    if (!ok.ok) return;

    /* A sessão é remontada a partir do que foi autenticado no aperto de mão —
       NUNCA a partir de campos que vieram na mensagem. Confiar num
       `m.usuarioId` seria deixar o cliente escolher quem ele é. */
    const sessao = {
      usuarioId: ws.usuarioId, contextoId: ws.contextoId, sessaoId: ws.sessaoId,
      papel: ws.papel, ehAdmin: ws.papel === "admin", nome: ws.nome,
    };

    try {
      switch (m.t) {
        case TIPOS.PING:
          enviar(ws, { t: TIPOS.PING });
          await repos.presenca.batimento(ws.usuarioId, conf.realtime.mortoMs);
          break;

        case TIPOS.DIGITANDO_ENVIO:
          await servico.digitando(sessao, String(m.c || ""));
          break;

        case TIPOS.LIDA_ENVIO:
          await servico.marcarLida(sessao, String(m.c || ""), Number(m.seq) || 0);
          break;

        /* ==================================================================
           O SINAL DO WebRTC — o único evento de reunião que vem pelo SOCKET.

           Iniciar, entrar, sair e mudo continuam indo por HTTP, onde já há
           CSRF, limitador e tratamento de erro. O sinal vem por aqui porque é
           o único de ALTA FREQUÊNCIA: montar uma malha de seis pessoas troca
           algumas centenas de candidatos ICE em poucos segundos, e cada um
           deles por HTTP seria uma requisição inteira com cabeçalhos.

           A autorização NÃO é relaxada por isso: `servico.sinalizar` confere,
           a cada sinal, que quem manda está dentro da chamada e que quem
           recebe também está. E o `de` é carimbado pela sessão do socket,
           nunca lido do corpo.
           ================================================================== */
        case TIPOS.CHAMADA_SINAL: {
          /* Balde próprio e mais largo que o geral: 240/min derrubaria a
             negociação de uma reunião de seis pessoas no meio, e o sintoma
             seria "a chamada conecta com uns e não com outros". */
          const vaga = limites.conferir(`sinal:${ws.sessaoId}`, { maximo: 900, janelaMs: 60e3 });
          if (!vaga.ok) break;

          await chamadas.sinalizar(sessao, String(m.c || ""), {
            tipo: String(m.tipo || ""),
            para: String(m.para || ""),
            dados: m.dados,
          });
          break;
        }

        case TIPOS.SINCRONIZAR: {
          const r = await servico.sincronizar(sessao, String(m.c || ""), Number(m.desde) || 0);
          enviar(ws, { t: TIPOS.SINCRONIZAR, c: m.c, ...r });
          break;
        }

        default:
          /* silêncio proposital */
          break;
      }
    } catch (e) {
      /* Erro de caso de uso (não é membro, limite atingido) vira um aviso
         discreto. Nunca detalhe técnico, e nunca derrubar o socket: quem
         errou um id não perdeu o direito de continuar conversando. */
      enviar(ws, { t: TIPOS.ERRO, m: e.seguroParaUsuario ? e.message : "Não foi possível concluir." });
    }
  }

  /* ==========================================================================
     BATIMENTO
     ========================================================================== */
  const batimento = setInterval(() => {
    const agora = Date.now();
    for (const conexoes of porUsuario.values()) {
      for (const ws of conexoes) {
        /* A sessão que autorizou este socket já venceu: derruba. Custa uma
           comparação de números — nenhuma ida ao banco por conexão. */
        if (ws.sessaoExpiraEm && agora > ws.sessaoExpiraEm) {
          try { ws.close(4001, "sessao expirada"); } catch { }
          try { ws.terminate(); } catch { }
          continue;
        }
        /* Não respondeu ao ping anterior: está morto. `terminate` fecha na
           marra — `close` esperaria uma resposta que não virá. */
        if (!ws.vivo) { try { ws.terminate(); } catch { } continue; }
        ws.vivo = false;
        try { ws.ping(); } catch { try { ws.terminate(); } catch { } }
      }
    }
  }, conf.realtime.pingMs);
  batimento.unref();

  return transporte;
}

/* ==========================================================================
   LIGAR O BARRAMENTO AO TRANSPORTE

   Separado da criação do transporte de propósito: é aqui, e só aqui, que se lê
   a lista completa do que o tempo real entrega. Espalhar `publicar()` pelos
   casos de uso faria essa lista deixar de existir em lugar nenhum.
   ========================================================================== */
function ligarAoBarramento({ barramento, transporte, EVENTOS }) {
  barramento.escutar(EVENTOS.MENSAGEM_ENVIADA, ({ conversaId, mensagem, membros, autorId }) => {
    /* O corpo VIAJA JUNTO — a exceção medida da regra "só o assunto".

       Sem ele, cada mensagem custaria uma volta ao servidor por destinatário
       antes de aparecer, e o chat pareceria lento justamente na ação mais
       comum. A autorização foi feita sobre `membros`, que veio do banco: a
       lista de conexões abertas nunca decide quem recebe. */
    transporte.publicar(membros, {
      t: "msg", c: conversaId, m: mensagem,
    }, { exceto: autorId });
  });

  barramento.escutar(EVENTOS.MENSAGEM_APAGADA, ({ conversaId, mensagemId, seq, membros }) => {
    transporte.publicar(membros, { t: "apagada", c: conversaId, id: mensagemId, seq });
  });

  barramento.escutar(EVENTOS.MENSAGEM_EDITADA, ({ conversaId, mensagem, membros }) => {
    transporte.publicar(membros, { t: "editada", c: conversaId, m: mensagem });
  });

  barramento.escutar(EVENTOS.MENSAGEM_LIDA, ({ conversaId, usuarioId, ateSeq, membros }) => {
    /* O aviso de leitura vai para os OUTROS: quem leu já sabe que leu, e
       mandar de volta faria a tela dele reprocessar à toa. */
    transporte.publicar(membros, { t: "lida", c: conversaId, u: usuarioId, seq: ateSeq },
      { exceto: usuarioId });
  });

  barramento.escutar(EVENTOS.USUARIO_DIGITANDO, ({ conversaId, usuarioId, nome, membros }) => {
    transporte.publicar(membros, { t: "digit", c: conversaId, u: usuarioId, n: nome },
      { exceto: usuarioId });
  });

  barramento.escutar(EVENTOS.USUARIO_STATUS, ({ contextoId, usuarioId, status }) => {
    /* `ligados(contextoId)` e não `ligados()`: a presença não atravessa a
       fronteira entre empresas. Ver anunciarStatus(). */
    transporte.publicar(transporte.ligados(contextoId).filter((id) => id !== usuarioId),
      { t: "status", u: usuarioId, s: status });
  });

  /* ==========================================================================
     SALA POR LINK

     O aviso e o fim vêm do SERVIDOR. O navegador até sabe a hora de término,
     mas o relógio dele é do visitante — e adiantá-lo é um clique nas
     configurações do sistema. Quem encerra a reunião é quem a hospeda.
     ========================================================================== */
  barramento.escutar(EVENTOS.SALA_AVISO, ({ paraIds, salaId, restanteMs }) => {
    transporte.publicar(paraIds, { t: "sala.aviso", s: salaId, restanteMs });
  });

  barramento.escutar(EVENTOS.SALA_ENCERRADA, ({ paraIds, salaId, motivo }) => {
    transporte.publicar(paraIds, { t: "sala.fim", s: salaId, motivo });
  });

  /* ==========================================================================
     EXPULSAR — bloqueio e saída fecham o canal na hora.

     Sem este ouvinte, apagar a sessão no banco cortava só o HTTP: o WebSocket
     já autenticado continuava aberto e entregando mensagens a quem acabara de
     ser bloqueado.
     ========================================================================== */
  barramento.escutar(EVENTOS.USUARIO_EXPULSO, ({ usuarioId, motivo }) => {
    transporte.encerrar(usuarioId, motivo || "acesso encerrado");
  });

  /* A lista de gente mudou: quem está com o chat aberto recarrega a aba
     "Pessoas" sozinho. Vai só para o contexto que mudou — a mesma fronteira
     da presença; o elenco de uma empresa não é assunto de outra. */
  barramento.escutar(EVENTOS.ELENCO_MUDOU, ({ contextoId }) => {
    transporte.publicar(transporte.ligados(contextoId), { t: "elenco" });
  });

  barramento.escutar(EVENTOS.CONVERSA_CRIADA, ({ conversaId, membros }) => {
    /* Avisa para a barra lateral do outro lado aparecer sozinha, sem F5. */
    transporte.publicar(membros, { t: "conversa", c: conversaId });
  });

  /* ==========================================================================
     REUNIÃO

     Todos entregam para `paraIds`, que veio do BANCO — a lista de quem está
     dentro da chamada, ou de quem deve receber o toque. A lista de conexões
     abertas nunca decide quem recebe; ela só decide quem consegue receber
     agora.
     ========================================================================== */

  barramento.escutar(EVENTOS.CHAMADA_TOCANDO, ({ paraIds, chamadaId, conversaId, de, chamada }) => {
    transporte.publicar(paraIds, {
      t: "cham.toca", c: conversaId, id: chamadaId, de, chamada,
    });
  });

  barramento.escutar(EVENTOS.CHAMADA_ENTROU, ({ paraIds, chamadaId, conversaId, usuarioId, participantes }) => {
    /* Vai para quem JÁ ESTAVA dentro, inclusive para quem entrou — o cliente
       precisa da lista completa para saber com quantas pessoas abrir conexão.
       Quem entrou é identificado por `u`, e é ele quem NÃO deve iniciar a
       oferta: ver a regra do "educado" em docs/VIDEO.md. */
    transporte.publicar(paraIds, {
      t: "cham.entrou", c: conversaId, id: chamadaId, u: usuarioId,
      participantes: (participantes || []).map((p) => ({
        id: p.usuario_id, estado: p.estado,
        microfone: !!p.microfone, camera: !!p.camera, tela: !!p.tela,
      })),
    });
  });

  barramento.escutar(EVENTOS.CHAMADA_SAIU, ({ paraIds, chamadaId, conversaId, usuarioId, motivo }) => {
    transporte.publicar(paraIds, {
      t: "cham.saiu", c: conversaId, id: chamadaId, u: usuarioId, motivo,
    });
  });

  barramento.escutar(EVENTOS.CHAMADA_ENCERRADA, ({ paraIds, chamadaId, conversaId, motivo }) => {
    transporte.publicar(paraIds, {
      t: "cham.fim", c: conversaId, id: chamadaId, motivo,
    });
  });

  barramento.escutar(EVENTOS.CHAMADA_DISPOSITIVOS, ({ paraIds, chamadaId, usuarioId, microfone, camera, tela }) => {
    transporte.publicar(paraIds, {
      t: "cham.disp", id: chamadaId, u: usuarioId, microfone, camera, tela,
    }, { exceto: usuarioId });
  });

  /* ==========================================================================
     O SINAL — o único evento que vai para UMA pessoa

     `de` foi carimbado pelo servidor em `aplicacao/chamadas.js`, a partir da
     sessão do socket. O campo que veio do cliente foi descartado lá. Se um dia
     alguém propagar o `de` do corpo até aqui, qualquer participante passa a
     conseguir injetar uma oferta de mídia em nome de outro.
     ========================================================================== */
  barramento.escutar(EVENTOS.CHAMADA_SINAL, ({ paraIds, chamadaId, de, tipo, dados }) => {
    transporte.publicar(paraIds, {
      t: "cham.sinal", id: chamadaId, de, tipo, dados,
    });
  });

}

module.exports = { criarTransporteWS, ligarAoBarramento };
