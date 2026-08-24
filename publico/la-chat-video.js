/* ==========================================================================
   la-chat-video.js — a reunião por vídeo, do lado do navegador

   ---------------------------------------------------------------------------
   ESTE ARQUIVO SÓ CHEGA AO NAVEGADOR QUANDO O VÍDEO ESTÁ LIGADO

   O servidor concatena `la-chat.js` + este arquivo ao servir `/chat/cliente.js`,
   e só concatena quando `CHAT_VIDEO=1`. Numa instalação sem vídeo, nada disto
   é baixado, avaliado ou executado — o recurso não existe, em vez de existir
   escondido atrás de um `if`.

   ---------------------------------------------------------------------------
   COMO ELE SE LIGA AO CHAT: REMENDANDO O PROTÓTIPO

   Ele não é um segundo componente. Ele pega a classe já registrada
   (`customElements.get("la-chat")`) e acrescenta métodos, embrulhando os
   poucos pontos onde precisa interceptar.

   A alternativa seria espalhar `if (video)` pelo `la-chat.js` inteiro. Assim,
   o arquivo do chat não sabe que existe vídeo — e continua funcionando
   exatamente igual quando este aqui não vem junto.

   ---------------------------------------------------------------------------
   A TOPOLOGIA: MALHA

   Cada pessoa abre uma conexão WebRTC com cada outra. A mídia NUNCA passa pelo
   servidor — ele é só a telefonista que repassa envelopes fechados.

   Consequência boa e não acidental: o vídeo é ponta a ponta de verdade.
   DTLS-SRTP é obrigatório no WebRTC; não é opção, não é configuração, e o
   servidor não teria como decifrar nem se quisesse.

   Consequência ruim, e por isso o teto de 6: cada pessoa SOBE (N-1) fluxos.
   Ver dominio/chamadas.js e docs/VIDEO.md.
   ========================================================================== */
(function () {
  "use strict";

  const LaChat = customElements.get("la-chat");
  if (!LaChat || LaChat.prototype.receberChamada) return;   // já carregado

  /* ==========================================================================
     1. ESTILO — acrescentado ao mesmo Shadow DOM
     ========================================================================== */
  const CSS_VIDEO = `
/* ==========================================================================
   O ATRIBUTO hidden NÃO VENCE UM display DECLARADO.

   O navegador aplica [hidden] { display: none } na folha de estilo DELE, que
   tem a menor prioridade de todas. Qualquer regra nossa com display — e
   estas duas têm — passa por cima, e o elemento "escondido" aparece.

   O sintoma foi exatamente esse: abrir o chat mostrava uma TELA PRETA. Era o
   painel da reunião, com hidden no atributo e display: flex no CSS,
   cobrindo tudo com o próprio fundo escuro.

   .chamada[hidden] tem especificidade maior que .chamada, então resolve
   sem !important.
   ========================================================================== */
.chamada[hidden], .toque[hidden] { display: none; }

.chamada {
  position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column;
  background: #0d1117; color: #e8eaee;
}
.chamada-topo {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  color: #b9c0cc; font-size: 13px; flex: none;
}
.chamada-topo b { color: #e8eaee; font-size: 14px; }
.chamada-topo .relogio { font-variant-numeric: tabular-nums; opacity: .8; }
.chamada-topo .rede { margin-left: auto; font-size: 11.5px; }
.chamada-topo .rede.ruim { color: #f0a020; }

/* Os botões de JANELA ficam no topo, e não na fileira de controles, porque
   respondem a uma pergunta diferente: a fileira é sobre o que você TRANSMITE
   (microfone, câmera, tela); estes são sobre COMO VOCÊ OLHA. Misturar os dois
   coloca "sair da reunião" ao lado de "aumentar a janela". */
.chamada-topo .vista { display: flex; gap: 4px; flex: none; margin-left: auto; }
.chamada-topo .vista button {
  background: transparent; border: 1px solid #30363d; color: #b9c0cc;
  border-radius: 7px; padding: 3px 8px; font-size: 13px; cursor: pointer;
  line-height: 1.4;
}
.chamada-topo .vista button:hover { background: #21262d; color: #e8eaee; }
.chamada-topo .vista button:focus-visible { outline: 2px solid #58a6ff; outline-offset: 1px; }

/* O aviso que fica no lugar da reunião enquanto ela está na outra janela.
   Sem ele, quem fechasse a janela de vista acharia que a reunião caiu. */
.chamada-fora {
  position: absolute; inset: 0; z-index: 20; display: grid; place-items: center;
  background: #0d1117; color: #b9c0cc; text-align: center; padding: 24px;
}
.chamada-fora[hidden] { display: none; }
.chamada-fora b { display: block; color: #e8eaee; font-size: 15px; margin-bottom: 6px; }
.chamada-fora p { margin: 0 0 16px; font-size: 13px; line-height: 1.5; max-width: 30ch; }
.chamada-fora button {
  background: #21262d; border: 1px solid #30363d; color: #e8eaee; border-radius: 9px;
  padding: 9px 16px; font: inherit; font-size: 13px; cursor: pointer;
}
.chamada-fora button:hover { background: #30363d; }

/* ==========================================================================
   A GRADE

   auto-fit com minmax resolve 1, 2, 4 e 6 pessoas sem nenhuma conta de
   layout em JavaScript: o navegador acomoda. Foi a alternativa a calcular
   linhas e colunas por número de participantes, que é código que erra em 3 e
   em 5 e ninguém lembra de testar.
   ========================================================================== */
.grade {
  flex: 1; display: grid; gap: 8px; padding: 0 12px 8px; min-height: 0;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  /* OCUPAR A ALTURA, e não centralizar retratos pequenos no meio do vazio.
     A primeira versão usava align-content:center com linhas do tamanho do
     conteudo: numa reuniao de duas pessoas sobravam duas faixas escuras em
     cima e embaixo, e o rosto ficava do tamanho de um selo.
     Com grid-auto-rows:1fr as linhas dividem a altura disponivel. */
  grid-auto-rows: 1fr;
  align-content: stretch;
}
.grade[data-n="1"] { grid-template-columns: 1fr; }
/* Duas pessoas lado a lado so faz sentido em tela larga; em tela alta e
   estreita, empilhadas aproveitam muito mais. */
@media (max-aspect-ratio: 1/1) {
  .grade[data-n="2"] { grid-template-columns: 1fr; }
}

/* ==========================================================================
   DESTAQUE — um video ampliado, os outros numa tira embaixo

   Os demais CONTINUAM no DOM (nao sao removidos nem escondidos com display:
   none): e o elemento <video> deles que toca o audio. Tira-los da tela
   tiraria a voz junto, que foi exatamente o defeito corrigido no quadro.
   ========================================================================== */
.grade[data-destaque] {
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  grid-template-rows: 1fr 84px;
  grid-auto-rows: 84px;
}
.grade[data-destaque] .quadro { grid-row: 2; min-height: 0; }
.grade[data-destaque] .quadro.grande {
  grid-column: 1 / -1; grid-row: 1; min-height: 0;
}
/* Na tira, o rotulo inteiro nao cabe: fica so o aviso de mudo. */
.grade[data-destaque] .quadro:not(.grande) .rotulo span { display: none; }
.grade[data-destaque] .quadro:not(.grande) .estado { display: none; }

.quadro { cursor: zoom-in; }
.quadro.grande { cursor: zoom-out; }
.quadro:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }

.quadro {
  position: relative; background: #161b22; border-radius: 12px; overflow: hidden;
  min-height: 120px; display: grid; place-items: center;
  border: 2px solid transparent; transition: border-color .18s;
}
/* Quem está falando ganha borda. É o sinal que substitui o "quem falou?" de
   uma reunião com seis retratos parados. */
.quadro.falando { border-color: #3fb950; }
.quadro video {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; background: #161b22;
}
/* O próprio vídeo vai espelhado — é como a pessoa se vê no espelho, e é o que
   todo aplicativo de chamada faz. Sem isso, levantar a mão direita parece a
   esquerda e a sensação é de estar olhando outra pessoa. */
.quadro.eu video { transform: scaleX(-1); }
/* Tela compartilhada NÃO é espelhada, e precisa caber inteira: cortar as
   bordas de uma planilha é perder justamente a coluna que se queria mostrar. */
.quadro.tela video { transform: none; object-fit: contain; background: #000; }

/* Camada POR CIMA do video, e nao no lugar dele: o <video> continua no DOM
   tocando o audio de quem esta com a camera desligada. */
.quadro .semvideo {
  position: absolute; inset: 0; z-index: 1;
  display: grid; place-items: center; gap: 6px;
  color: #8b949e; background: #161b22;
}
.quadro .semvideo .ini {
  width: 64px; height: 64px; border-radius: 50%; background: #21262d;
  display: grid; place-items: center; font-size: 22px; font-weight: 700; color: #c9d1d9;
}
.quadro .rotulo {
  position: absolute; left: 8px; bottom: 8px; z-index: 2;
  background: rgba(0,0,0,.55); border-radius: 7px; padding: 3px 8px;
  font-size: 12px; display: flex; align-items: center; gap: 6px; max-width: calc(100% - 16px);
}
.quadro .rotulo span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.quadro .mudo { color: #f85149; }
.quadro .estado {
  position: absolute; inset: auto 8px 8px auto; z-index: 2;
  font-size: 11px; color: #8b949e; background: rgba(0,0,0,.55);
  border-radius: 7px; padding: 3px 8px;
}

/* ---------------------------------------------------------------- controles */
.controles {
  flex: none; display: flex; justify-content: center; align-items: center; gap: 10px;
  padding: 12px; background: #0d1117;
}
.ctrl {
  width: 46px; height: 46px; border-radius: 50%; border: 0; cursor: pointer;
  background: #21262d; color: #e8eaee; font-size: 18px; display: grid; place-items: center;
  position: relative;
}
.ctrl:hover { background: #30363d; }
.ctrl:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
.ctrl[aria-pressed="true"] { background: #f85149; color: #fff; }
.ctrl.desligar { background: #da3633; color: #fff; width: 58px; }
.ctrl.desligar:hover { background: #f85149; }
.ctrl:disabled { opacity: .4; cursor: default; }

/* ------------------------------------------------------------------- toque */
.toque {
  position: absolute; inset: 0; z-index: 30; display: grid; place-items: center;
  background: rgba(8, 11, 16, .82); padding: 20px;
}
.toque .cartao {
  background: var(--fundo); color: var(--tinta); border-radius: var(--chat-raio);
  padding: 26px; width: min(320px, 100%); text-align: center; box-shadow: var(--sombra);
}
.toque .av { width: 84px; height: 84px; margin: 0 auto 14px; }
.toque h3 { margin: 0 0 4px; font-size: 18px; }
.toque .sub { color: var(--tinta-2); font-size: 13px; margin-bottom: 18px; }
.toque .botoes { display: flex; gap: 10px; }
.toque .botoes button {
  flex: 1; padding: 12px; border: 0; border-radius: 10px; cursor: pointer;
  font: inherit; font-weight: 600; font-size: 14px; color: #fff;
}
.toque .aceitar { background: #2da44e; }
.toque .recusar { background: #cf222e; }
.toque .pulsa { animation: pulsa 1.4s ease-in-out infinite; }
@keyframes pulsa { 0%,100% { transform: scale(1) } 50% { transform: scale(1.06) } }
@media (prefers-reduced-motion: reduce) { .toque .pulsa { animation: none } }

/* -------------------------------------------------- a linha no histórico */
.evento { display: flex; justify-content: center; margin: 10px 0; }
.evento .caixa {
  display: flex; align-items: center; gap: 8px;
  background: var(--fundo-3); color: var(--tinta-2);
  border-radius: 10px; padding: 6px 12px; font-size: 12.5px;
}
.evento .caixa b { color: var(--tinta); font-weight: 600; }
.evento .perdida { color: var(--perigo); }
.evento button {
  border: 0; background: none; color: var(--chat-primaria); cursor: pointer;
  font: inherit; font-size: 12.5px; font-weight: 600; padding: 0;
}

/* --------------------------------------------------------------- avisos */
.chamada .faixa-video {
  flex: none; text-align: center; padding: 8px; font-size: 12.5px;
  background: #21262d; color: #f0a020;
}

@media (max-width: 720px) {
  .grade { grid-template-columns: repeat(auto-fit, minmax(45%, 1fr)); padding: 0 8px 6px; }
  .ctrl { width: 52px; height: 52px; font-size: 20px; }
}
`;

  /* ==========================================================================
     O CSS DA SALA E O DA ABA DE REUNIÕES — declarados AQUI, e não lá embaixo
     junto do código que eles vestem. O motivo custou caro:

     a varredura da seção 7 chama `prepararVideo()` DURANTE a avaliação deste
     arquivo, para alcançar o componente que o `data-auto` já montou. Com
     estas constantes declaradas depois dela, `prepararVideo` esbarrava na
     zona morta temporal do `const` e estourava ReferenceError — dentro de um
     `try { } catch { }` vazio, que engolia tudo.

     O resultado na tela: um chat perfeito, SEM VÍDEO, sem erro no console e
     com a suíte inteira verde. `const` é declaração com hora marcada, e
     código que roda no meio do arquivo tem de respeitar essa hora.
     ========================================================================== */

  /* O estilo do modo sala. Declarado AQUI, junto do que ele veste, e não lá
     em cima com o CSS de vídeo — `prepararVideo` só roda quando alguém monta
     um componente, muito depois deste arquivo terminar de ser avaliado. */
  const CSS_SALA = `
.chamada-topo .relogio.acabando {
  color: #fca5a5;
  background: rgba(220, 38, 38, .18);
  border-radius: 999px;
  padding: 1px 8px;
}
:host([modo="sala"]) .barra,
:host([modo="sala"]) .redator,
:host([modo="sala"]) .faixa { display: none !important; }
:host([modo="sala"]) .moldura { position: relative; width: 100%; height: 100%; padding: 0; }
:host([modo="sala"]) .painel { width: 100%; height: 100%; border-radius: 0; }
:host([modo="sala"]) .chamada { border-radius: 0; }
`;

  const CSS_REUNIOES = `
.sala-linha { display: block; width: 100%; text-align: left; padding: 10px var(--espaco);
  border-bottom: 1px solid var(--linha); }
.sala-linha .topo { display: flex; align-items: baseline; gap: 8px; }
.sala-linha .topo b { font-size: 14px; font-weight: 600; flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sala-linha .selo { font-size: 11px; padding: 1px 7px; border-radius: 999px; flex: none;
  background: var(--fundo-3); color: var(--tinta-2); }
.sala-linha .selo.viva { background: rgba(22, 163, 74, .16); color: var(--online); }
.sala-linha .link { display: flex; gap: 6px; margin-top: 7px; }
.sala-linha .link code { flex: 1; min-width: 0; font-size: 11.5px; padding: 5px 7px;
  background: var(--fundo-2); border: 1px solid var(--linha); border-radius: 7px;
  color: var(--tinta-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sala-linha .acoes { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
.sala-linha .acoes button { font: inherit; font-size: 12px; padding: 5px 10px; cursor: pointer;
  border-radius: 7px; border: 1px solid var(--linha); background: var(--fundo-2); color: var(--tinta); }
.sala-linha .acoes button.forte { background: var(--chat-primaria); color: var(--chat-primaria-texto);
  border-color: transparent; }
.sala-linha .acoes button.risco { color: var(--perigo); }
.sala-linha .acoes button:hover { filter: brightness(1.08); }
.sala-linha .quem { margin-top: 7px; font-size: 12px; color: var(--tinta-2); }
.sala-linha .quem div { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.sala-linha .quem span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.sala-linha .quem button { font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer;
  border-radius: 6px; border: 1px solid var(--linha); background: transparent; color: var(--perigo); }
.sala-nova { padding: 10px var(--espaco); border-bottom: 1px solid var(--linha); }
.sala-nova input, .sala-nova select { width: 100%; font: inherit; font-size: 13px; padding: 7px 9px;
  margin-bottom: 6px; border-radius: 8px; border: 1px solid var(--linha);
  background: var(--fundo-2); color: var(--tinta); }
.sala-nova button { width: 100%; font: inherit; font-size: 13px; font-weight: 600; padding: 8px;
  border-radius: 8px; border: 0; cursor: pointer;
  background: var(--chat-primaria); color: var(--chat-primaria-texto); }
`;

  /* ==========================================================================
     2. UTILIDADES
     ========================================================================== */
  const criar = (tag, props = {}, filhos = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "texto") el.textContent = v;               // NUNCA innerHTML
      else if (k === "classe") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
    }
    for (const f of [].concat(filhos)) if (f) el.appendChild(f);
    return el;
  };
  const limpar = (el) => { while (el && el.firstChild) el.removeChild(el.firstChild); };
  const iniciais = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2)
    .map((p) => p[0] || "").join("").toUpperCase() || "?";

  const relogio = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  /* ==========================================================================
     3. O TOQUE

     Gerado, não baixado: um `.mp3` seria mais um recurso a carregar, mais um
     caminho para a política de segurança do site hospedeiro bloquear, e mais
     um pedido de rede no pior momento.

     Se o navegador recusar o áudio (política de autoplay), o aviso VISUAL
     continua — o toque é reforço, nunca o único sinal.
     ========================================================================== */
  const toque = {
    ctx: null, timer: null,
    tocar() {
      try {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return;
        this.ctx = this.ctx || new C();
        if (this.ctx.state === "suspended") this.ctx.resume();
        const bipe = () => {
          const t = this.ctx.currentTime;
          for (const [atraso, hz] of [[0, 660], [0.18, 880]]) {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = "sine";
            o.frequency.setValueAtTime(hz, t + atraso);
            g.gain.setValueAtTime(0.0001, t + atraso);
            g.gain.exponentialRampToValueAtTime(0.05, t + atraso + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t + atraso + 0.16);
            o.connect(g); g.connect(this.ctx.destination);
            o.start(t + atraso); o.stop(t + atraso + 0.18);
          }
        };
        bipe();
        this.parar();
        this.timer = setInterval(bipe, 2600);
      } catch { /* sem áudio: o aviso visual basta */ }
    },
    parar() { if (this.timer) { clearInterval(this.timer); this.timer = null; } },
  };

  /* ==========================================================================
     4. A MALHA — uma RTCPeerConnection por participante

     ---------------------------------------------------------------------
     QUEM FAZ A OFERTA: QUEM JÁ ESTAVA NA SALA

     Quando alguém entra, TODOS os que já estavam criam uma oferta para o
     recém-chegado; ele só responde. Isso é determinístico e evita a colisão
     ("glare") no caso comum, sem nenhuma negociação sobre quem começa.

     ---------------------------------------------------------------------
     A COLISÃO AINDA EXISTE — na RENEGOCIAÇÃO

     Compartilhar tela acrescenta uma trilha e dispara `negotiationneeded` do
     lado de quem compartilhou. Se duas pessoas compartilharem no mesmo
     instante, as duas ofertam ao mesmo tempo e a conexão trava num estado
     inválido.

     A saída é o padrão "negociação perfeita": um dos lados é EDUCADO e cede;
     o outro é rude e ignora a oferta que chegou fora de hora. O papel é
     decidido comparando os ids — sem combinar nada, os dois lados chegam a
     conclusões opostas, que é exatamente o necessário.
     ========================================================================== */
  function criarMalha({ meuId, mandarSinal, aoMudar, aoErro }) {
    const pares = new Map();     // usuarioId -> { pc, fluxo, educado, ... }
    let fluxoLocal = null;
    let iceServers = [];
    let politica = "all";

    function servidores(cred) {
      iceServers = cred?.iceServers || [];
      politica = cred?.iceTransportPolicy || "all";
    }

    function par(id) {
      if (pares.has(id)) return pares.get(id);

      const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: politica });
      /* Educado = id menor. Determinístico, e os dois lados chegam a papéis
         OPOSTOS sem trocar mensagem nenhuma. */
      const p = {
        pc, id, fluxo: null,
        educado: String(meuId) < String(id),
        fazendoOferta: false,
        ignorandoOferta: false,
      };
      pares.set(id, p);

      /* As trilhas locais entram agora. Se a câmera ainda não abriu, entram
         depois em `definirLocal` — a ordem não pode importar, porque a pessoa
         pode entrar na reunião antes de conceder a permissão. */
      if (fluxoLocal) for (const t of fluxoLocal.getTracks()) pc.addTrack(t, fluxoLocal);

      pc.onicecandidate = (e) => {
        if (e.candidate) mandarSinal(id, "candidato", e.candidate.toJSON());
      };

      pc.ontrack = (e) => {
        p.fluxo = e.streams[0] || new MediaStream([e.track]);
        aoMudar();
      };

      pc.onnegotiationneeded = async () => {
        try {
          p.fazendoOferta = true;
          await pc.setLocalDescription();
          mandarSinal(id, "oferta", pc.localDescription.toJSON());
        } catch (e) {
          aoErro?.(e);
        } finally {
          p.fazendoOferta = false;
        }
      };

      /* ====================================================================
         POR QUE NÃO CONECTOU

         "conectando…" para sempre é o pior diagnóstico possível: não diz se o
         problema é a rede da pessoa, o servidor de relay ou a credencial dele.
         E, do lado de fora, os três são indistinguíveis.

         O navegador SABE a resposta e a entrega aqui. Os códigos que importam:

           401/403  o relay recusou a credencial — o segredo do chat não bate
                    com o `static-auth-secret` do coturn;
           701      não deu para falar com o servidor de relay (porta fechada,
                    endereço errado, serviço fora do ar).

         Traduzir isso numa frase economiza a investigação inteira.
         ==================================================================== */
      pc.onicecandidateerror = (e) => {
        const cod = Number(e?.errorCode || 0);
        if (!cod || cod === 600) return;   // 600 = "não há mais candidatos", normal

        /* ==================================================================
           O ERRO BRUTO FICA GUARDADO, e não só traduzido.

           A frase na tela serve a quem está na reunião. Quem vai CONSERTAR
           precisa de outra coisa: qual servidor falhou, com que código, com
           que texto. Sem isso, "não falei com o relay" manda investigar o
           relay — e já aconteceu de o relay estar perfeito e o erro ser de
           outro endereço da lista.

           Dez basta: o que interessa é o começo da negociação.
           ================================================================== */
        const registro = {
          quando: new Date().toISOString(),
          codigo: cod,
          url: e?.url || "",
          texto: e?.errorText || "",
          endereco: e?.address || "",
          porta: e?.port || 0,
        };
        /* ==================================================================
           REGISTRA, MAS NÃO AVISA.

           `onicecandidateerror` dispara por SERVIDOR e por tentativa. Numa
           lista com STUN e TURN, UDP e TCP, é normal que alguma entrada falhe
           enquanto outra funciona e a chamada conecta perfeitamente.

           A primeira versão punha esse erro na tela na hora. O resultado foi
           uma frase alarmante — "não foi possível falar com o servidor de
           relay" — durante uma reunião numa instalação onde o relay estava
           PERFEITO: TCP e UDP chegando, credencial aceita, alocação concedida.
           Custou horas de investigação num lugar onde não havia defeito.

           Aviso na tela é para FALHA, não para tentativa frustrada. Quem
           decide isso é o estado da conexão, mais abaixo.
           ================================================================== */
        aoErro(Object.assign(new Error("candidato recusado (" + cod + ")"),
          { codigoIce: cod, registro, silencioso: true }));
      };

      pc.oniceconnectionstatechange = () => {
        /* `failed` é diferente de `disconnected`: o segundo costuma se
           recuperar sozinho em segundos (troca de rede, wifi oscilando). Só o
           primeiro merece um restart de ICE. */
        if (pc.iceConnectionState === "failed") {
          try { pc.restartIce(); } catch { }
          /* AQUI a conexão falhou de verdade — não é uma tentativa entre
             outras. É o único momento em que vale interromper a reunião de
             alguém com uma mensagem. */
          aoErro(Object.assign(new Error("A conexão com esta pessoa falhou."),
            { falhaDeConexao: true, com: id }));
        }
        aoMudar();
      };

      return p;
    }

    return {
      servidores,

      /* ====================================================================
         DESCER DO RELAY PARA A CONEXÃO DIRETA

         `iceTransportPolicy` é definida na CRIAÇÃO de cada RTCPeerConnection e
         não pode ser trocada depois. Mudar de ideia, portanto, é refazer as
         conexões — não há caminho mais barato, e fingir que há produziria uma
         malha metade numa política e metade noutra.

         Isto existe porque a alternativa era pior: numa rede que bloqueia UDP
         para o relay, uma reunião por link com `relay` obrigatório
         simplesmente NÃO ACONTECE, enquanto a chamada interna entre as mesmas
         duas pessoas funciona. "O chat funciona, só o link não" — e o motivo
         não aparece em lugar nenhum.

         A troca é consciente e tem preço: sem relay, os participantes voltam a
         ver o IP uns dos outros. Por isso quem chama isto avisa na tela, e por
         isso acontece uma vez só, depois de a conexão ter FALHADO de verdade.
         ==================================================================== */
      politicaAtual() { return politica; },

      refazerCom(novaPolitica) {
        politica = novaPolitica;
        const ids = [...pares.keys()];
        for (const p of pares.values()) { try { p.pc.close(); } catch { } }
        pares.clear();
        return ids;
      },

      async definirLocal(fluxo) {
        fluxoLocal = fluxo;
        for (const p of pares.values()) {
          for (const t of fluxo.getTracks()) {
            /* `addTrack` numa conexão que já tem essa trilha estoura; então
               troca-se quando já existe emissor do mesmo tipo. */
            const emissor = p.pc.getSenders().find((s) => s.track?.kind === t.kind);
            if (emissor) await emissor.replaceTrack(t).catch(() => { });
            else p.pc.addTrack(t, fluxo);
          }
        }
      },

      /* Substitui a trilha de vídeo sem renegociar — é assim que o
         compartilhamento de tela entra e sai instantaneamente. `replaceTrack`
         não dispara `negotiationneeded`, o que evita uma rodada de oferta e
         resposta com cada participante a cada clique. */
      async trocarVideo(trilha) {
        for (const p of pares.values()) {
          const emissor = p.pc.getSenders().find((s) => s.track?.kind === "video");
          if (emissor) await emissor.replaceTrack(trilha).catch(() => { });
        }
      },

      /* Chamado por quem JÁ ESTAVA na sala, para o recém-chegado. */
      /* ====================================================================
         REOFERECER — para a oferta que se perdeu no caminho

         `convidar` é idempotente: se o par já existe, ele não oferece de novo.
         É o certo no caso comum e é o errado quando a primeira oferta se
         perdeu — e ela se perde sempre que o outro lado ainda não tinha o
         socket aberto, o que é a regra e não a exceção para quem acabou de
         entrar por um link.

         Aqui a pergunta é outra: "esta conexão está de pé?". Se não estiver,
         oferece de novo. Se estiver, não mexe — renegociar uma conexão viva
         cortaria a imagem de todo mundo por um instante, sem motivo.
         ==================================================================== */
      reconvidar(id) {
        const existente = pares.get(id);
        if (!existente) return this.convidar(id);

        const st = existente.pc.connectionState;
        if (st === "connected" || st === "connecting") return existente;

        (async () => {
          try {
            existente.fazendoOferta = true;
            await existente.pc.setLocalDescription();
            mandarSinal(id, "oferta", existente.pc.localDescription.toJSON());
          } catch (e) {
            aoErro?.(e);
          } finally {
            existente.fazendoOferta = false;
          }
        })();
        return existente;
      },

      convidar(id) {
        const p = par(id);
        /* `onnegotiationneeded` dispara sozinho ao acrescentar as trilhas.
           Se não houver trilha nenhuma (câmera negada), força a oferta — senão
           quem entrou sem câmera nunca conecta e fica invisível. */
        if (!fluxoLocal || !fluxoLocal.getTracks().length) {
          p.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })
            .then(async (o) => {
              await p.pc.setLocalDescription(o);
              mandarSinal(id, "oferta", p.pc.localDescription.toJSON());
            }).catch((e) => aoErro?.(e));
        }
        return p;
      },

      /* ====================================================================
         RECEBER SINAL — negociação perfeita
         ==================================================================== */
      async receber(de, tipo, dados) {
        const p = par(de);
        const pc = p.pc;

        try {
          if (tipo === "candidato") {
            /* Candidato que chega antes da descrição remota é normal e não é
               erro: guardá-lo daria trabalho, e o padrão já tolera o descarte
               quando estamos ignorando uma oferta em colisão. */
            try { await pc.addIceCandidate(dados); }
            catch (e) { if (!p.ignorandoOferta) throw e; }
            return;
          }

          if (tipo === "resposta") {
            await pc.setRemoteDescription(dados);
            return;
          }

          if (tipo === "oferta") {
            const colisao = p.fazendoOferta || pc.signalingState !== "stable";
            /* O RUDE ignora a oferta que chegou no meio da dele. O EDUCADO
               desfaz a própria e aceita a do outro. Sem esta assimetria, os
               dois desfazem, os dois reofertam, e a negociação entra em laço. */
            p.ignorandoOferta = !p.educado && colisao;
            if (p.ignorandoOferta) return;

            await pc.setRemoteDescription(dados);
            await pc.setLocalDescription();
            mandarSinal(de, "resposta", pc.localDescription.toJSON());
          }
        } catch (e) {
          aoErro?.(e);
        }
      },

      remover(id) {
        const p = pares.get(id);
        if (!p) return;
        try { p.pc.close(); } catch { }
        pares.delete(id);
        aoMudar();
      },

      fluxoDe: (id) => pares.get(id)?.fluxo || null,
      estadoDe: (id) => pares.get(id)?.pc?.iceConnectionState || "novo",
      ids: () => [...pares.keys()],

      encerrar() {
        for (const p of pares.values()) { try { p.pc.close(); } catch { } }
        pares.clear();
        if (fluxoLocal) for (const t of fluxoLocal.getTracks()) { try { t.stop(); } catch { } }
        fluxoLocal = null;
      },
    };
  }

  /* ==========================================================================
     5. DETECTOR DE QUEM ESTÁ FALANDO

     Sem isso, uma reunião de seis pessoas é seis retratos parados e ninguém
     sabe de quem é a voz. Com `getStats` daria para tirar do próprio WebRTC,
     mas a leitura é assíncrona e por conexão; um analisador de áudio é mais
     barato e responde na hora.

     O limiar e a inércia (`decaimento`) existem para a borda não piscar a cada
     sílaba — o que seria pior que não ter indicador nenhum.
     ========================================================================== */
  function criarDetector(aoFalar) {
    let ctx = null;
    const fontes = new Map();   // id -> { analisador, nivel }
    let timer = null;

    function garantirContexto() {
      if (ctx) return ctx;
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
      return ctx;
    }

    return {
      acompanhar(id, fluxo) {
        if (!fluxo || fontes.has(id)) return;
        const c = garantirContexto();
        if (!c || !fluxo.getAudioTracks().length) return;
        try {
          const fonte = c.createMediaStreamSource(fluxo);
          const analisador = c.createAnalyser();
          analisador.fftSize = 512;
          analisador.smoothingTimeConstant = 0.4;
          fonte.connect(analisador);
          fontes.set(id, { analisador, dados: new Uint8Array(analisador.frequencyBinCount), nivel: 0 });
          if (!timer) timer = setInterval(medir, 220);
        } catch { /* navegador sem suporte: fica sem indicador */ }
      },
      esquecer(id) {
        fontes.delete(id);
        if (!fontes.size && timer) { clearInterval(timer); timer = null; }
      },
      encerrar() {
        fontes.clear();
        if (timer) { clearInterval(timer); timer = null; }
        try { ctx?.close(); } catch { }
        ctx = null;
      },
    };

    function medir() {
      let falando = null;
      let maior = 0;
      for (const [id, f] of fontes) {
        f.analisador.getByteFrequencyData(f.dados);
        let soma = 0;
        for (let i = 0; i < f.dados.length; i++) soma += f.dados[i];
        const media = soma / f.dados.length;
        /* Inércia: sobe rápido, desce devagar. É o que impede a borda de
           piscar entre as sílabas de uma mesma frase. */
        f.nivel = Math.max(media, f.nivel * 0.7);
        if (f.nivel > 12 && f.nivel > maior) { maior = f.nivel; falando = id; }
      }
      aoFalar(falando);
    }
  }

  /* ==========================================================================
     6. OS MÉTODOS ACRESCENTADOS AO COMPONENTE
     ========================================================================== */

  Object.assign(LaChat.prototype, {

    /* ----------------------------------------------------------------------
       Preparado uma vez, na montagem.
       ---------------------------------------------------------------------- */
    prepararVideo() {
      if (this.el.chamada) return;

      const estilo = document.createElement("style");
      estilo.textContent = CSS_VIDEO + CSS_SALA;
      this.raiz.appendChild(estilo);

      const chamada = criar("div", { classe: "chamada", hidden: "", role: "region",
        "aria-label": "Reunião por vídeo" });
      const toqueEl = criar("div", { classe: "toque", hidden: "", role: "dialog",
        "aria-label": "Chamada recebida" });

      this.el.painel.append(chamada, toqueEl);
      this.el.chamada = chamada;
      this.el.toque = toqueEl;

      this.video = {
        chamada: null,        // a chamada em que estou
        recebendo: null,      // a chamada que está tocando para mim
        malha: null,
        detector: null,
        local: null,          // MediaStream da câmera
        tela: null,           // MediaStream da tela
        falando: null,
        destaque: null,
        microfone: true,
        camera: true,
        participantes: new Map(),
        timer: null,
      };
    },

    /* ======================================================================
       EVENTOS QUE CHEGAM PELO SOCKET
       ====================================================================== */
    receberChamada(m) {
      const v = this.video;
      if (!v) return;

      switch (m.t) {
        case "cham.toca": {
          /* Já estou numa reunião? Então não toca — e o servidor já sabe que
             estou ocupado pelo estado do participante. Tocar por cima de uma
             reunião em andamento é o defeito mais irritante que um chat pode
             ter. */
          if (v.chamada) return;
          v.recebendo = m.chamada || { id: m.id, conversaId: m.c };
          v.recebendo.de = m.de;
          this.pintarToque();
          break;
        }

        case "cham.entrou": {
          if (!v.chamada || m.id !== v.chamada.id) return;
          /* MESCLA, e não substitui. O evento é a fonte da verdade para o
             ESTADO (quem está dentro, mudo, com câmera), mas um campo ausente
             nele não deve apagar o que já se sabia — foi assim que o nome de
             todos sumiu quando o servidor parou de enviá-lo. Segunda tranca:
             a primeira é o servidor mandar o nome. */
          for (const p of m.participantes || [])
            v.participantes.set(p.id, { ...(v.participantes.get(p.id) || {}), ...p });
          /* EU JÁ ESTAVA AQUI: sou eu quem oferece ao recém-chegado.
             Quem chega não oferece a ninguém — só responde. É o que evita a
             colisão de ofertas no caso comum. */
          if (m.u !== this.estado.eu?.id) v.malha?.convidar(m.u);
          this.pintarChamada();
          break;
        }

        case "cham.saiu": {
          if (!v.chamada || m.id !== v.chamada.id) return;
          v.malha?.remover(m.u);
          v.detector?.esquecer(m.u);
          v.participantes.delete(m.u);
          if (v.destaque === m.u) v.destaque = null;
          this.pintarChamada();
          break;
        }

        case "cham.fim": {
          if (v.recebendo && m.id === v.recebendo.id) { v.recebendo = null; this.pintarToque(); }
          if (v.chamada && m.id === v.chamada.id) this.desmontarChamada(m.motivo);
          this.carregarConversas();
          break;
        }

        case "cham.disp": {
          if (!v.chamada || m.id !== v.chamada.id) return;
          const p = v.participantes.get(m.u) || { id: m.u };
          if (m.microfone !== undefined) p.microfone = m.microfone;
          if (m.camera !== undefined) p.camera = m.camera;
          if (m.tela !== undefined) p.tela = m.tela;
          v.participantes.set(m.u, p);
          this.pintarChamada();
          break;
        }

        case "cham.sinal": {
          if (!v.chamada || m.id !== v.chamada.id) return;
          v.malha?.receber(m.de, m.tipo, m.dados);
          break;
        }
      }
    },

    /* ======================================================================
       INICIAR / ENTRAR
       ====================================================================== */
    async iniciarChamada() {
      if (!this.estado.atual) return;
      try {
        const r = await this.api(`/conversas/${this.estado.atual.id}/chamada`, { metodo: "POST" });
        await this.montarChamada(r);
      } catch (e) {
        this.mostrarFaixa(e.message, true);
      }
    },

    async atenderChamada() {
      const v = this.video;
      if (!v.recebendo) return;
      const id = v.recebendo.id;
      v.recebendo = null;
      toque.parar();
      this.pintarToque();
      try {
        const r = await this.api(`/chamadas/${id}/entrar`, { metodo: "POST" });
        await this.montarChamada(r);
      } catch (e) {
        this.mostrarFaixa(e.message, true);
      }
    },

    async recusarChamada() {
      const v = this.video;
      if (!v.recebendo) return;
      const id = v.recebendo.id;
      v.recebendo = null;
      toque.parar();
      this.pintarToque();
      try { await this.api(`/chamadas/${id}/recusar`, { metodo: "POST" }); } catch { }
    },

    /* ======================================================================
       MONTAR A REUNIÃO

       A CÂMERA É PEDIDA DEPOIS DE ENTRAR, e a falha dela NÃO cancela a
       reunião: quem negou a permissão, ou está num computador sem câmera,
       participa só com áudio — ou só ouvindo. Cancelar seria transformar um
       problema de hardware numa reunião perdida.
       ====================================================================== */
    async montarChamada(dados) {
      const v = this.video;
      v.chamada = dados;
      v.participantes = new Map((dados.participantes || []).map((p) => [p.id, p]));
      v.microfone = true;
      v.camera = true;
      v.destaque = null;

      v.malha = criarMalha({
        meuId: this.estado.eu?.id,
        mandarSinal: (para, tipo, dadosSinal) => {
          this.enviarPeloSocket({ t: "cham.sinal", c: v.chamada.id, para, tipo, dados: dadosSinal });
        },
        /* AGENDA em vez de pintar na hora. O ICE muda de estado muitas vezes
           por segundo enquanto negocia, e cada mudança pedia uma tela inteira.
           Com o agendamento, uma rajada de vinte eventos vira UMA pintura no
           próximo quadro de vídeo do navegador. */
        aoMudar: () => this.agendarPintura(),
        aoErro: (e) => {
          if (window.CHAT_DEBUG) console.warn("webrtc:", e?.message || e);

          /* ==================================================================
             ERRO DE CANDIDATO É REGISTRO, NUNCA AVISO.

             `onicecandidateerror` dispara por servidor e por tentativa. Numa
             lista com STUN e TURN, UDP, TCP e TLS, é normal alguma entrada
             falhar enquanto outra funciona e a chamada conecta.

             Fica guardado para quem for diagnosticar — e o lugar dele é o
             console, não a cara de quem está reunido:

                 document.querySelector("la-chat").video.errosIce
             ================================================================== */
          if (e?.registro) {
            const v = this.video;
            if (v) {
              v.errosIce = v.errosIce || [];
              if (v.errosIce.length < 10) v.errosIce.push(e.registro);
            }
          }

          /* A FALHA DE CONEXÃO — esta sim fala com a pessoa, em uma frase. */
          if (e?.falhaDeConexao) this.recuarDoRelay(e);
        },
      });
      v.malha.servidores(dados.credenciais);

      v.detector = criarDetector((quem) => {
        if (quem === v.falando) return;
        v.falando = quem;
        this.pintarChamada();
      });

      this.el.chamada.hidden = false;
      this.pintarChamada();

      /* O relógio da reunião. Um número que anda é o que faz a tela parecer
         viva quando todos estão de câmera fechada. */
      clearInterval(v.timer);
      v.timer = setInterval(() => this.pintarRelogio(), 1000);

      /* ====================================================================
         O RELÓGIO DA PACIÊNCIA

         "Conectando…" para sempre não é um estado — é a ausência de resposta,
         e ela não diz nada a quem está esperando. Pior: num celular não há
         console para descobrir o motivo, então a pessoa fica sem nenhuma
         informação e sem nenhum caminho.

         O ICE só declara `failed` depois de esgotar as tentativas, e às vezes
         não declara nunca — fica em `checking` indefinidamente. Então quem
         avisa é o relógio: passados 20 segundos com alguém ainda travado, a
         tela conta o que foi tentado.

         Não interrompe nada: a negociação continua, e se ela fechar depois o
         aviso some junto com a próxima pintura.
         ==================================================================== */
      clearTimeout(v.paciencia);
      v.paciencia = setTimeout(() => this.diagnosticarDemora(), 20000);

      await this.abrirCamera();

      /* Quem ENTROU oferece para quem já estava. Quem já estava recebe o
         `cham.entrou` e oferece para o novato — as duas pontas cobrem o caso
         em que um dos avisos se perde. */
      for (const p of v.participantes.values()) {
        if (p.id !== this.estado.eu?.id && p.estado === "dentro") v.malha.convidar(p.id);
      }
    },

    async abrirCamera() {
      const v = this.video;
      try {
        v.local = await navigator.mediaDevices.getUserMedia({
          /* `echoCancellation` e `noiseSuppression` são o que separa uma
             reunião utilizável de uma com microfonia — e vêm de graça no
             navegador. */
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        });
      } catch {
        /* Sem câmera, tenta só o microfone. Sem nada, participa ouvindo. */
        try {
          v.local = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          v.camera = false;
          this.avisoDeVideo("Sua câmera não está disponível — você entrou só com áudio.");
        } catch {
          v.camera = false;
          v.microfone = false;
          this.avisoDeVideo("Sem acesso à câmera e ao microfone — você entrou apenas ouvindo.");
        }
      }

      if (v.local) {
        await v.malha?.definirLocal(v.local);
        v.detector?.acompanhar(this.estado.eu?.id, v.local);
      }
      this.pintarChamada();
    },

    /* ======================================================================
       CONTROLES
       ====================================================================== */
    async alternarMicrofone() {
      const v = this.video;
      if (!v.local) return;
      v.microfone = !v.microfone;
      for (const t of v.local.getAudioTracks()) t.enabled = v.microfone;
      this.pintarChamada();
      try {
        await this.api(`/chamadas/${v.chamada.id}/dispositivos`, {
          metodo: "PATCH", corpo: { microfone: v.microfone },
        });
      } catch { /* o estado local já mudou; o aviso aos outros é que falhou */ }
    },

    async alternarCamera() {
      const v = this.video;
      if (!v.local) return;
      v.camera = !v.camera;
      for (const t of v.local.getVideoTracks()) t.enabled = v.camera;
      this.pintarChamada();
      try {
        await this.api(`/chamadas/${v.chamada.id}/dispositivos`, {
          metodo: "PATCH", corpo: { camera: v.camera },
        });
      } catch { }
    },

    /* ----------------------------------------------------------------------
       COMPARTILHAR TELA

       Usa `replaceTrack`, e não uma trilha nova: assim a troca é instantânea e
       não dispara renegociação com cada participante. Numa malha de seis
       pessoas, renegociar seria cinco rodadas de oferta e resposta a cada
       clique no botão.

       O `onended` da trilha é obrigatório: o navegador tem o PRÓPRIO botão de
       "parar compartilhamento", e sem escutá-lo a pessoa para de compartilhar
       pelo navegador e o chat continua achando que ela compartilha.
       ---------------------------------------------------------------------- */
    async alternarTela() {
      const v = this.video;
      if (v.tela) return this.pararTela();

      try {
        v.tela = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 10, max: 15 } },
          audio: false,
        });
      } catch {
        return;   // a pessoa cancelou o seletor: não é erro
      }

      const trilha = v.tela.getVideoTracks()[0];
      trilha.addEventListener("ended", () => this.pararTela());
      await v.malha?.trocarVideo(trilha);
      this.pintarChamada();

      try {
        await this.api(`/chamadas/${v.chamada.id}/dispositivos`, {
          metodo: "PATCH", corpo: { tela: true },
        });
      } catch (e) {
        this.mostrarFaixa(e.message, true);
      }
    },

    async pararTela() {
      const v = this.video;
      if (!v.tela) return;
      for (const t of v.tela.getTracks()) { try { t.stop(); } catch { } }
      v.tela = null;

      const daCamera = v.local?.getVideoTracks()[0] || null;
      await v.malha?.trocarVideo(daCamera);
      this.pintarChamada();

      try {
        await this.api(`/chamadas/${v.chamada.id}/dispositivos`, {
          metodo: "PATCH", corpo: { tela: false },
        });
      } catch { }
    },

    async sairDaChamada() {
      const v = this.video;
      const id = v.chamada?.id;
      this.desmontarChamada();
      if (!id) return;
      try { await this.api(`/chamadas/${id}/sair`, { metodo: "POST" }); } catch { }
      this.carregarConversas();
    },

    /* Desmonta TUDO. Chamado ao sair, ao receber `cham.fim` e ao fechar o
       componente — as três precisam soltar a câmera, ou a luzinha continua
       acesa e a pessoa acha que está sendo filmada. */
    desmontarChamada(motivo) {
      const v = this.video;
      if (!v) return;
      clearInterval(v.timer);
      clearTimeout(v.paciencia);
      v.timer = null;
      v.paciencia = null;
      toque.parar();

      if (v.tela) { for (const t of v.tela.getTracks()) { try { t.stop(); } catch { } } v.tela = null; }
      v.malha?.encerrar();
      v.detector?.encerrar();
      v.malha = null;
      v.detector = null;
      v.local = null;
      v.chamada = null;
      v.participantes = new Map();
      v.falando = null;
      v.destaque = null;

      if (this.el.chamada) { this.el.chamada.hidden = true; limpar(this.el.chamada); }
      if (motivo === "ninguem_atendeu") this.mostrarFaixa("Ninguém atendeu.", false);
      if (motivo === "recusada") this.mostrarFaixa("Chamada recusada.", false);
      if (motivo) setTimeout(() => this.esconderFaixa(), 4000);
    },

    avisoDeVideo(texto) {
      this.el.chamada.dataset.aviso = texto || "";
      this.pintarChamada();
    },

    /* ======================================================================
       PINTURA
       ====================================================================== */
    pintarToque() {
      const v = this.video;
      const alvo = this.el.toque;
      limpar(alvo);

      if (!v.recebendo) { alvo.hidden = true; toque.parar(); return; }

      alvo.hidden = false;
      toque.tocar();

      const quem = v.recebendo.participantes?.find((p) => p.id === v.recebendo.de);
      const nome = quem?.nome || "Alguém";
      const conversa = this.estado.conversas.find((c) => c.id === v.recebendo.conversaId);
      const ehGrupo = conversa?.tipo === "grupo";

      const av = criar("div", { classe: "av pulsa" }, [
        quem?.avatar
          ? criar("img", { src: quem.avatar, alt: "" })
          : criar("div", { classe: "ini", texto: iniciais(nome) }),
      ]);

      alvo.appendChild(criar("div", { classe: "cartao" }, [
        av,
        criar("h3", { texto: nome }),
        criar("div", { classe: "sub",
          texto: ehGrupo ? `Reunião em ${conversa.titulo || "grupo"}` : "Chamada de vídeo" }),
        criar("div", { classe: "botoes" }, [
          criar("button", { classe: "recusar", texto: "Recusar",
            onclick: () => this.recusarChamada() }),
          criar("button", { classe: "aceitar", texto: "Atender",
            onclick: () => this.atenderChamada() }),
        ]),
      ]));

      alvo.querySelector(".aceitar")?.focus();
    },

    pintarRelogio() {
      const v = this.video;
      const el = this.el.chamada?.querySelector(".relogio");
      if (!el || !v.chamada) return;
      const inicio = v.chamada.atendidaEm || v.chamada.iniciadaEm || Date.now();
      el.textContent = relogio(Date.now() - inicio);
    },

    /* ======================================================================
       A REPINTURA NÃO PODE DESTRUIR OS <video>

       Esta função reconstrói a tela inteira, e é chamada de dentro do
       `oniceconnectionstatechange` — que dispara muitas vezes por segundo
       enquanto a conexão não fecha. Cada chamada recriava os elementos de
       vídeo e reatribuía as streams, e o efeito na tela era PISCAR.

       Os dois sintomas eram a mesma cadeia: conexão travada → rajada de
       eventos de ICE → rajada de repinturas → piscar. Quem estivesse com a
       reunião funcionando não via nada; quem estivesse com problema de rede
       via o problema em dobro.

       Aqui os elementos são GUARDADOS antes de limpar e devolvidos aos
       quadros novos. Trocar de lugar no DOM não interrompe a mídia; recriar
       o elemento, sim.
       ====================================================================== */
    /* Coalesce as repinturas: várias no mesmo quadro viram uma. Sem
       `requestAnimationFrame` (aba em segundo plano, navegador antigo) cai
       num `setTimeout` curto, que é pior mas nunca deixa de pintar. */
    agendarPintura() {
      if (this._pinturaAgendada) return;
      this._pinturaAgendada = true;
      const pintar = () => { this._pinturaAgendada = false; this.pintarChamada(); };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(pintar);
      else setTimeout(pintar, 40);
    },

    pintarChamada() {
      const v = this.video;
      const alvo = this.el.chamada;
      if (!v?.chamada || !alvo) return;

      const videosVivos = new Map();
      for (const q of alvo.querySelectorAll(".quadro")) {
        const vid = q.querySelector("video");
        if (vid && q.dataset.quem) videosVivos.set(q.dataset.quem, vid);
      }
      this._videosVivos = videosVivos;

      limpar(alvo);

      const dentro = [...v.participantes.values()].filter((p) => p.estado === "dentro");
      const eu = this.estado.eu;

      /* ---- topo ---- */
      const conversa = this.estado.conversas.find((c) => c.id === v.chamada.conversaId);
      const titulo = conversa?.tipo === "grupo"
        ? (conversa.titulo || "Reunião")
        : (conversa?.outro?.nome || "Chamada");

      alvo.appendChild(criar("div", { classe: "chamada-topo" }, [
        criar("b", { texto: titulo }),
        criar("span", { classe: "relogio", texto: "00:00" }),
        criar("span", { texto: `· ${dentro.length} ${dentro.length === 1 ? "pessoa" : "pessoas"}` }),
        this.botoesDeVista(),
      ]));

      if (alvo.dataset.aviso)
        alvo.appendChild(criar("div", { classe: "faixa-video", texto: alvo.dataset.aviso }));

      /* ---- a grade ---- */
      const grade = criar("div", { classe: "grade" });
      grade.dataset.n = String(dentro.length);
      /* Com alguém em destaque, a grade troca de layout: o escolhido ocupa a
         área toda e os demais viram uma tira embaixo — continuam no DOM, e
         portanto continuam tocando o áudio. */
      if (v.destaque) grade.dataset.destaque = "1";

      /* Eu primeiro — é onde a pessoa procura para saber se está enquadrada. */
      grade.appendChild(this.quadroDe({
        id: eu?.id, nome: eu?.nome + " (você)", avatar: eu?.avatar,
        fluxo: v.tela || v.local, ehEu: true,
        camera: v.camera || !!v.tela, microfone: v.microfone, tela: !!v.tela,
      }));

      for (const p of dentro) {
        if (p.id === eu?.id) continue;
        const fluxo = v.malha?.fluxoDe(p.id);
        if (fluxo) v.detector?.acompanhar(p.id, fluxo);
        grade.appendChild(this.quadroDe({
          id: p.id, nome: p.nome || "…", avatar: p.avatar,
          fluxo, camera: p.camera !== false, microfone: p.microfone !== false, tela: !!p.tela,
          estadoRede: v.malha?.estadoDe(p.id),
        }));
      }
      alvo.appendChild(grade);

      /* ---- controles ---- */
      const botao = (classe, texto, rotulo, ativo, aoClicar, desabilitado) => {
        const b = criar("button", {
          classe: "ctrl " + classe, texto, "aria-label": rotulo, title: rotulo,
          "aria-pressed": String(!!ativo),
          onclick: aoClicar,
        });
        if (desabilitado) b.disabled = true;
        return b;
      };

      const controles = criar("div", { classe: "controles" }, [
        botao("", v.microfone ? "🎤" : "🔇",
          v.microfone ? "Desligar microfone" : "Ligar microfone",
          !v.microfone, () => this.alternarMicrofone(), !v.local),
        /* Um ícone só para cada botão, e o ESTADO vem da cor (vermelho quando
           desligado, via `aria-pressed`). Dois ícones diferentes — câmera e
           câmera-cortada — ficam quase idênticos em 18px, e a pessoa precisa
           olhar duas vezes para saber se está transmitindo. */
        botao("", "📹",
          v.camera ? "Desligar câmera" : "Ligar câmera",
          !v.camera, () => this.alternarCamera(), !v.local),
      ]);

      /* Compartilhar tela não existe em celular — `getDisplayMedia` não é
         suportado, e um botão que não faz nada é pior que botão nenhum. */
      if (navigator.mediaDevices?.getDisplayMedia) {
        controles.appendChild(botao("", "🖥", v.tela ? "Parar de compartilhar" : "Compartilhar tela",
          !!v.tela, () => this.alternarTela()));
      }

      controles.appendChild(botao("desligar", "📞", "Sair da reunião", false,
        () => this.sairDaChamada()));

      alvo.appendChild(controles);
      this.pintarRelogio();
    },

    /* ======================================================================
       AMPLIAR / REDUZIR

       Clicar num vídeo o coloca em destaque; clicar de novo (ou no que já está
       em destaque) volta à grade. Quem sai da reunião levando o destaque junto
       devolve a grade ao normal — senão a tela ficaria presa num retrato que
       não existe mais.
       ====================================================================== */
    alternarDestaque(id) {
      const v = this.video;
      if (!v?.chamada) return;
      v.destaque = v.destaque === id ? null : id;
      this.pintarChamada();
    },

    quadroDe({ id, nome, avatar, fluxo, ehEu, camera, microfone, tela, estadoRede }) {
      const v = this.video;
      const reaproveitar = this._videosVivos?.get(String(id));
      const destacado = v.destaque === id;
      const q = criar("div", {
        classe: "quadro" + (ehEu ? " eu" : "") + (tela ? " tela" : "") +
                (destacado ? " grande" : "") + (v.falando === id ? " falando" : ""),
        /* Clicável para ampliar. `role` e `tabindex` porque um `<div>` que age
           como botão precisa dizer isso — senão o teclado e o leitor de tela
           não alcançam a única forma de ver o rosto de perto. Não uso `<button>`
           de verdade porque ele quebra o vídeo dentro em alguns navegadores. */
        role: "button",
        tabindex: "0",
        "aria-pressed": String(destacado),
        "aria-label": (destacado ? "Reduzir vídeo de " : "Ampliar vídeo de ") + (nome || ""),
        onclick: () => this.alternarDestaque(id),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.alternarDestaque(id); }
        },
      });

      q.dataset.quem = String(id);

      const temVideo = fluxo && fluxo.getVideoTracks().some((t) => t.readyState === "live") && camera;

      /* ==================================================================
         O ELEMENTO <video> FICA SEMPRE, MESMO COM A CÂMERA DESLIGADA.

         É ELE que toca o áudio do outro lado. A primeira versão só o criava
         quando havia imagem — então, quando alguém desligava a câmera, o
         elemento saía do DOM e **a voz dessa pessoa sumia junto**.

         O sintoma que se vê é "desliguei o vídeo e o áudio foi junto", e a
         causa não parece estar no áudio em lugar nenhum: `alternarCamera` só
         mexe nas trilhas de vídeo. Era a pintura da tela.

         Com a câmera desligada, o retrato é uma camada POR CIMA — o vídeo
         continua no DOM, tocando.
         ================================================================== */
      if (fluxo) {
        /* REAPROVEITA o elemento da pintura anterior, se houver. É isto que
           impede o piscar: um <video> novo reinicia a decodificação; o mesmo
           <video>, movido de lugar, não. */
        const vid = reaproveitar || criar("video", { autoplay: "", playsinline: "" });
        /* O próprio vídeo vai MUDO, sempre. Sem isto o microfone capta o
           próprio alto-falante e a reunião vira microfonia — e é o defeito
           número um de quem escreve isto pela primeira vez. */
        if (ehEu) vid.muted = true;
        /* Só reatribui se MUDOU. Reatribuir a mesma stream reinicia o
           elemento, que é justamente o que estamos evitando. */
        if (vid.srcObject !== fluxo) vid.srcObject = fluxo;
        /* `play()` pode ser recusado pela política de autoplay; o `autoplay`
           com `muted` cobre o caso do próprio vídeo, e o remoto tem gesto do
           usuário atrás (ele clicou para entrar). */
        if (vid.paused) vid.play?.().catch(() => { });
        q.appendChild(vid);
      }

      if (!temVideo) {
        q.appendChild(criar("div", { classe: "semvideo" }, [
          avatar
            ? criar("img", { src: avatar, alt: "", classe: "ini" })
            : criar("div", { classe: "ini", texto: iniciais(nome) }),
        ]));
      }

      const rotulo = criar("div", { classe: "rotulo" }, [
        criar("span", { texto: nome || "…" }),
      ]);
      if (!microfone) rotulo.appendChild(criar("span", { classe: "mudo", texto: "🔇" }));
      if (tela) rotulo.appendChild(criar("span", { texto: "🖥" }));
      q.appendChild(rotulo);

      /* O estado da conexão só aparece quando é RUIM. Mostrar "conectado" o
         tempo todo é ruído; mostrar "conectando…" quando trava é informação. */
      if (!ehEu && estadoRede && !["connected", "completed"].includes(estadoRede)) {
        q.appendChild(criar("div", { classe: "estado",
          texto: estadoRede === "failed" ? "sem conexão" : "conectando…" }));
      }

      return q;
    },
  });

  /* ==========================================================================
     7. OS REMENDOS — onde o vídeo se enxerta no chat

     Cada um embrulha o método original e chama-o. Nenhum deles substitui
     comportamento: o chat continua fazendo o que fazia.
     ========================================================================== */

  const montarOriginal = LaChat.prototype.montar;
  LaChat.prototype.montar = function () {
    montarOriginal.call(this);
    this.prepararVideo();
  };

  /* ==========================================================================
     OS ELEMENTOS QUE JÁ EXISTEM QUANDO ESTE ARQUIVO RODA

     Ordem real de execução do arquivo concatenado:

         la-chat.js      define a classe, registra, e o bloco `data-auto`
                         JÁ CRIA o <la-chat> e chama `montar()`
         la-chat-video.js  ← só agora remenda o protótipo

     Ou seja: para a instância criada pelo `data-auto`, o remendo do `montar`
     chega TARDE. O botão de reunião não aparecia e `this.video` nem existia —
     e nada quebrava, o chat só não tinha vídeo.

     Por isso a varredura: quem já montou recebe o preparo agora. `prepararVideo`
     é idempotente (sai na hora se já houver `this.el.chamada`), então rodar duas
     vezes não custa nada.
     ========================================================================== */
  for (const el of document.querySelectorAll("la-chat")) {
    /* `el.el` só existe depois de `montar()`. Sem esta guarda, um elemento
       ainda não conectado estouraria aqui. */
    if (el.el && !el.el.chamada) {
    /* SEM `catch` VAZIO. Foi um deles que escondeu um ReferenceError que
       deixava o chat sem vídeo — a tela parecia certa e o console, limpo.
       Engolir exceção aqui não protege ninguém: se este preparo falha, o
       vídeo não existe, e alguém precisa saber disso. */
      try {
        el.prepararVideo();
        el.pintarCabecalho?.();
      } catch (e) {
        console.error("la-chat: o preparo do vídeo falhou —", e);
      }
    }
  }

  const receberOriginal = LaChat.prototype.receber;
  LaChat.prototype.receber = function (m) {
    if (typeof m?.t === "string" && m.t.startsWith("cham.")) return this.receberChamada(m);
    return receberOriginal.call(this, m);
  };

  /* O botão de chamar entra no cabeçalho da conversa. */
  const cabecalhoOriginal = LaChat.prototype.pintarCabecalho;
  LaChat.prototype.pintarCabecalho = function () {
    cabecalhoOriginal.call(this);
    const c = this.estado.atual;
    if (!c || !this.el.cab) return;

    const botao = criar("button", {
      classe: "icone", texto: "🎥", "aria-label": "Iniciar reunião por vídeo",
      title: "Iniciar reunião por vídeo",
      onclick: () => this.iniciarChamada(),
    });

    /* Antes do botão de fechar, se ele existir — para o "✕" continuar sendo o
       último elemento do cabeçalho, que é onde a mão procura. */
    const fechar = [...this.el.cab.querySelectorAll(".icone")]
      .find((b) => b.getAttribute("aria-label") === "Fechar chat");
    if (fechar) this.el.cab.insertBefore(botao, fechar);
    else this.el.cab.appendChild(botao);
  };

  /* ==========================================================================
     A FRASE DA BARRA LATERAL

     O servidor manda o evento ESTRUTURADO, nunca a frase pronta — porque ela
     depende de quem lê: quem ligou vê "ninguém atendeu"; quem recebeu vê
     "chamada perdida". A mesma linha do banco, duas leituras.

     Sem este método, `textoDaPrevia` devolve vazio e a linha fica em branco —
     que é o desfecho correto quando não há quem saiba traduzir. O que NUNCA
     acontece é o JSON aparecer, que era o defeito.
     ========================================================================== */
  LaChat.prototype.fraseDoEvento = function (ev, conversa) {
    if (!ev || ev.ev !== "chamada") return "";

    const souOAutor = conversa?.previa?.autorId === this.estado.eu?.id;

    if (ev.motivo === "recusada")
      return souOAutor ? "📵 Chamada recusada" : "📵 Você recusou";
    if (ev.motivo === "ninguem_atendeu")
      return souOAutor ? "📵 Ninguém atendeu" : "📵 Chamada perdida";

    const s = Number(ev.dur) || 0;
    const min = Math.floor(s / 60);
    return "🎥 Reunião · " + (min >= 1 ? min + " min" : s + "s");
  };

  /* A mensagem de sistema da chamada vira uma linha centralizada, e não uma
     bolha — é um acontecimento da conversa, não uma fala de alguém. */
  const bolhaOriginal = LaChat.prototype.bolha;
  LaChat.prototype.bolha = function (m, primeira) {
    if (m.tipo !== "sistema") return bolhaOriginal.call(this, m, primeira);

    let ev = null;
    try { ev = JSON.parse(m.corpo); } catch { }
    if (!ev || ev.ev !== "chamada") return bolhaOriginal.call(this, m, primeira);

    const souOAutor = m.autorId === this.estado.eu?.id;
    const perdida = ev.motivo === "ninguem_atendeu" || ev.motivo === "recusada";

    const texto = perdida
      ? (ev.motivo === "recusada"
          ? (souOAutor ? "Chamada recusada" : "Você recusou a chamada")
          : (souOAutor ? "Ninguém atendeu" : "Chamada perdida"))
      : "Reunião encerrada";

    const caixa = criar("div", { classe: "caixa" }, [
      criar("span", { texto: perdida ? "📵" : "🎥" }),
      criar("b", { classe: perdida ? "perdida" : "", texto }),
    ]);

    if (!perdida && ev.dur) {
      const min = Math.floor(ev.dur / 60);
      caixa.appendChild(criar("span", {
        texto: "· " + (min >= 1 ? `${min} min` : `${ev.dur}s`) +
               (ev.n > 2 ? ` · ${ev.n} pessoas` : ""),
      }));
    }

    /* Ligar de volta, direto da linha do histórico — é o que se quer fazer ao
       ver uma chamada perdida. */
    if (perdida) {
      caixa.appendChild(criar("button", {
        texto: "Ligar de volta", onclick: () => this.iniciarChamada(),
      }));
    }

    return criar("div", { classe: "evento" }, [caixa]);
  };

  /* Ao abrir uma conversa, descobrir se já há reunião rolando — quem chega
     depois precisa ver "Entrar na reunião", não "Chamar". */
  const abrirOriginal = LaChat.prototype.abrirConversa;
  LaChat.prototype.abrirConversa = async function (conversa) {
    await abrirOriginal.call(this, conversa);
    if (!conversa?.id || this.video?.chamada) return;
    try {
      const r = await this.api(`/conversas/${conversa.id}/chamada`);
      if (r?.chamada && r.chamada.estado !== "encerrada") this.mostrarReuniaoEmAndamento(r.chamada);
    } catch { /* sem vídeo nesta instalação, ou conversa sem permissão */ }
  };

  LaChat.prototype.mostrarReuniaoEmAndamento = function (chamada) {
    const dentro = (chamada.participantes || []).filter((p) => p.estado === "dentro");
    if (!dentro.length) return;
    this.mostrarFaixa(
      `Reunião em andamento com ${dentro.length} ${dentro.length === 1 ? "pessoa" : "pessoas"}.`);
    const faixa = this.el.faixa;
    faixa.appendChild(document.createTextNode(" "));
    faixa.appendChild(criar("button", {
      texto: "Entrar",
      style: "border:0;background:none;color:var(--chat-primaria);cursor:pointer;font:inherit;font-weight:600",
      onclick: async () => {
        try {
          const r = await this.api(`/chamadas/${chamada.id}/entrar`, { metodo: "POST" });
          this.esconderFaixa();
          await this.montarChamada(r);
        } catch (e) { this.mostrarFaixa(e.message, true); }
      },
    }));
  };

  /* Fechar o componente solta a câmera. Sem isto a luzinha continua acesa
     depois de o chat sumir da tela, e a pessoa acha que está sendo filmada. */
  const desconectarOriginal = LaChat.prototype.disconnectedCallback;
  LaChat.prototype.disconnectedCallback = function () {
    this.desmontarChamada();
    desconectarOriginal?.call(this);
  };

  /* Sair do chat pela tecla ESC não pode deixar a reunião rodando invisível.
     A hierarquia passa a ser: reunião → conversa → painel. */
  const fecharOriginal = LaChat.prototype.fechar;
  LaChat.prototype.fechar = function () {
    if (this.video?.chamada) return;   // com reunião aberta, o ✕ não fecha o chat
    fecharOriginal.call(this);
  };

  /* ==========================================================================
     8. MODO SALA — a reunião por link, para quem não tem conta

     O convidado NÃO ganha um cliente próprio. Ele ganha o MESMO componente,
     em outro modo. A tentação de escrever uma tela separada é grande — ela
     seria menor e mais simples — e seria a decisão errada: duplicaria a
     negociação WebRTC, que é o código mais difícil deste projeto e o único
     onde um defeito só aparece com três pessoas e duas redes diferentes.

     O que muda no modo sala:
       · não há passe, nem `/eu`, nem conversas — a identidade já veio do
         `POST /call/<codigo>/entrar` e é a única que existe;
       · o relógio conta PARA TRÁS, porque a sala tem hora para acabar;
       · o fim é decidido pelo SERVIDOR, e chega pelo socket.
     ========================================================================== */

  /* DUAS PERGUNTAS DIFERENTES, e confundi-las foi um defeito real:

     `ehConvidado` — esta janela pertence a quem entrou pelo link? Governa
                     o que NÃO existe para ele: a barra lateral, o redator,
                     e voltar para a conversa ao sair da reunião.

     `naSala`      — a reunião em curso tem hora para acabar? Governa o
                     título e a contagem regressiva, que interessam a TODOS
                     os presentes.

     Uma condição só, escrita pensando no convidado, deixava o ANFITRIÃO
     sem a informação que ele próprio definiu: quem marcou a hora via
     "Chamada" e um relógio contando para cima, e seria a última pessoa
     que deveria ser pega de surpresa pelo fim. */
  const ehConvidado = (el) => el.modo === "sala";
  const naSala = (el) => !!el.sala?.encerraEm;

  /* ------------------------------------------------------------------------
     A ENTRADA. Chamada pela página do convidado com o que o servidor devolveu.
     ------------------------------------------------------------------------ */
  /* ------------------------------------------------------------------------
     O SOCKET ABRIU — refaz o que se perdeu enquanto ele estava fechado

     Sinal de WebRTC é entregue ao vivo: se ninguém estava escutando, acabou.
     Não há `seq`, não há retomada, e ninguém reoferece sozinho.

     A janela em que isso acontece não é rara — é o caso NORMAL de quem entra
     por um link: o servidor marca a pessoa como `dentro` e avisa o anfitrião
     enquanto ela ainda está abrindo o socket. A oferta do anfitrião chega para
     ninguém, a dela sai antes da hora, e os dois ficam em "conectando…" para
     sempre — até alguém sair e voltar, que é o que reconstruía tudo.

     Vale também para reconexão no meio da reunião, que tem a mesma forma.
     ------------------------------------------------------------------------ */
  LaChat.prototype.aoSocketAberto = function () {
    const v = this.video;
    if (!v?.chamada || !v.malha) return;
    for (const p of v.participantes.values()) {
      if (p.id !== this.estado.eu?.id && p.estado === "dentro") {
        try { v.malha.reconvidar(p.id); } catch { }
      }
    }
  };

  LaChat.prototype.entrarNaSala = async function ({ eu, sala, chamada }) {
    this.estado.eu = eu;
    this.estado.conversas = [];
    this.sala = sala || null;

    this.setAttribute("aberto", "");

    /* O socket vem ANTES de montar a chamada — e ESPERA-SE que ele abra.
       `ligar()` termina quando o `new WebSocket` é construído, não quando a
       conexão abre; oferecer nesse intervalo é oferecer para um socket em
       `CONNECTING`, e o sinal é descartado em silêncio.

       Se não abrir a tempo, segue mesmo assim: o gancho `aoSocketAberto`
       reoferece quando ele abrir. Esperar para sempre seria pior que tentar. */
    await this.ligar();
    await this.esperarSocket(5000);
    await this.montarChamada(chamada);
    this.pintarRelogio();
  };

  /* ------------------------------------------------------------------------
     O RELÓGIO QUE CONTA PARA TRÁS

     Numa reunião comum o relógio conta o tempo decorrido — é informação sem
     consequência. Numa sala com hora marcada, o número que importa é quanto
     FALTA, e ele fica vermelho no fim para que ninguém seja surpreendido.
     ------------------------------------------------------------------------ */
  const relogioOriginal = LaChat.prototype.pintarRelogio;
  LaChat.prototype.pintarRelogio = function () {
    if (!naSala(this)) return relogioOriginal.call(this);

    const el = this.el.chamada?.querySelector(".relogio");
    if (!el) return;

    const resta = Math.max(0, Number(this.sala.encerraEm) - Date.now());
    el.textContent = "termina em " + relogio(resta);
    el.classList.toggle("acabando", resta <= 5 * 60_000);
  };

  /* ------------------------------------------------------------------------
     O TÍTULO. Sem lista de conversas, `pintarChamada` chamaria a reunião de
     "Chamada". O nome que o anfitrião deu é melhor, e é o que o convidado
     viu no convite.
     ------------------------------------------------------------------------ */
  const pintarChamadaOriginal = LaChat.prototype.pintarChamada;
  LaChat.prototype.pintarChamada = function () {
    pintarChamadaOriginal.call(this);
    if (!naSala(this)) return;
    const b = this.el.chamada?.querySelector(".chamada-topo b");
    if (b) b.textContent = this.sala?.titulo || "Reunião";
  };

  /* ------------------------------------------------------------------------
     OS DOIS AVISOS DO SERVIDOR

     `sala.aviso` e `sala.fim` não são negociáveis pelo cliente. Quem conta o
     tempo é o servidor: um relógio de navegador atrasado, adiantado ou
     alterado de propósito não estende reunião nenhuma. O relógio da tela é
     enfeite honesto — a decisão está do outro lado.
     ------------------------------------------------------------------------ */
  const receberDaSala = LaChat.prototype.receber;
  LaChat.prototype.receber = function (m) {
    if (m?.t === "sala.aviso") return this.avisoDaSala(m);
    if (m?.t === "sala.fim") return this.fimDaSala(m);
    return receberDaSala.call(this, m);
  };

  LaChat.prototype.avisoDaSala = function (m) {
    const min = Math.max(1, Math.round(Number(m.restanteMs || 0) / 60_000));
    const texto = min === 1
      ? "Falta 1 minuto para o fim da reunião."
      : "Faltam " + min + " minutos para o fim da reunião.";

    this.avisoDeVideo(texto);
    /* Um aviso que some sozinho seria perdido por quem estava falando. Este
       fica até o fim — é o último momento em que ainda dá para se despedir. */

    this.dispatchEvent(new CustomEvent("chat:sala-aviso", {
      bubbles: true, composed: true, detail: { restanteMs: Number(m.restanteMs || 0) },
    }));
  };

  const MOTIVOS_DA_SALA = {
    tempo_esgotado: "O tempo da reunião terminou.",
    revogada: "O anfitrião encerrou esta reunião.",
    removido: "Você foi removido da reunião.",
    encerrada: "A reunião foi encerrada.",
  };

  LaChat.prototype.fimDaSala = function (m) {
    const motivo = String(m?.motivo || "encerrada");
    const mensagem = MOTIVOS_DA_SALA[motivo] || MOTIVOS_DA_SALA.encerrada;

    this.desmontarChamada();

    /* O CONVIDADO sai do sistema: o socket dele não serve para mais nada,
       e a página assume a partir daqui. O ANFITRIÃO continua no chat —
       derrubar o socket dele aqui o desconectaria da empresa inteira por
       causa do fim de UMA reunião. */
    if (ehConvidado(this)) {
      this.desligar();
    } else {
      this.mostrarFaixa(mensagem, false);
      setTimeout(() => this.esconderFaixa(), 6000);
      if (this.estado.aba === "reunioes") this.carregarSalas?.();
    }

    this.dispatchEvent(new CustomEvent("chat:sala-fim", {
      bubbles: true, composed: true, detail: { motivo, mensagem },
    }));
  };

  /* ------------------------------------------------------------------------
     SAIR. No chat, sair da chamada devolve à conversa. Na sala não HÁ conversa
     para onde voltar — sair é ir embora, e quem decide o que mostrar depois é
     a página.
     ------------------------------------------------------------------------ */
  const sairOriginal = LaChat.prototype.sairDaChamada;
  LaChat.prototype.sairDaChamada = async function () {
    if (!ehConvidado(this)) return sairOriginal.call(this);

    const id = this.video?.chamada?.id;
    this.desmontarChamada();
    if (id) { try { await this.api("/chamadas/" + id + "/sair", { metodo: "POST" }); } catch { } }
    this.desligar();

    this.dispatchEvent(new CustomEvent("chat:sala-fim", {
      bubbles: true, composed: true,
      detail: { motivo: "saiu", mensagem: "Você saiu da reunião." },
    }));
  };


  /* ==========================================================================
     9. A ABA "REUNIÕES" — o lado de quem CRIA o link

     Mora no módulo de vídeo, e não no núcleo, pela mesma razão de tudo aqui:
     numa instalação com CHAT_VIDEO=0 este arquivo não é servido, e a aba não
     existe — em vez de existir cinzenta, explicando que o recurso está
     desligado. Um produto não deve anunciar no rodapé o que ele não faz.
     ========================================================================== */

  /* ------------------------------------------------------------------------
     VESTIR UM COMPONENTE COM A ABA — idempotente, e por um motivo concreto

     Este arquivo pode chegar DEPOIS de o componente já ter montado: o
     hospedeiro que usa data-auto monta durante o parse do HTML, e a seção 7
     já precisou de uma varredura por causa disso.

     A primeira versão desta aba esqueceu a lição e só a acrescentava dentro
     de montar(). O resultado na tela foi um chat com duas abas, nenhum erro
     no console e a suíte inteira verde — porque teste de servidor não vê
     tela. Foi assim que o defeito apareceu: olhando.

     Agora há UMA função, chamada dos dois lugares, que sai na hora se já
     tiver feito o serviço.
     ------------------------------------------------------------------------ */
  function vestirDeReunioes(el) {
    if (el.__reunioes) return;
    el.__reunioes = true;

    const estilo = document.createElement("style");
    estilo.textContent = CSS_REUNIOES;
    el.raiz.appendChild(estilo);

    /* NUNCA no modo sala: o convidado não tem por que ver a lista de
       reuniões de ninguém. O servidor recusaria de qualquer forma — esta é
       a segunda tranca, não a primeira. */
    if (el.modo === "sala" || !el.el?.abas) return;
    if (el.el.abas.querySelector('[data-aba="reunioes"]')) return;

    /* ==================================================================
       A ABA SÓ EXISTE PARA QUEM PODE CRIAR

       O servidor recusa a criação a quem não é administrador — essa é a
       tranca de verdade. Aqui é sobre não oferecer: uma aba que só sabe
       dizer "você não pode" ocupa espaço na barra e ensina a ignorar o
       menu.

       `estado.eu` pode ainda não ter chegado quando o componente monta.
       Por isso a aba é acrescentada TAMBÉM ao fim de `iniciar()`, quando a
       identidade já se conhece — e esta função sai na hora se já tiver
       feito o serviço. */
    /* Administrador ou quem o site declarou capaz. A tranca de verdade é a
       do servidor; aqui é sobre não oferecer o que a pessoa não pode fazer. */
    const podeCriar = (u) => u?.papel === "admin" || !!u?.podeSala;
    if (el.estado?.eu && !podeCriar(el.estado.eu)) return;
    if (!el.estado?.eu) { el.__reunioes = false; return; }

    const b = criar("button", {
      classe: "aba", role: "tab", "aria-selected": "false", texto: "Reuniões",
      onclick: () => el.trocarAba("reunioes"),
    });
    b.dataset.aba = "reunioes";
    el.el.abas.appendChild(b);
  }

  const montarComAba = LaChat.prototype.montar;
  LaChat.prototype.montar = function () {
    montarComAba.call(this);
    vestirDeReunioes(this);
  };

  /* Quem já estava montado quando este arquivo chegou. */
  for (const el of document.querySelectorAll("la-chat")) {
    if (el.el) { try { vestirDeReunioes(el); } catch { } }
  }

  /* A IDENTIDADE CHEGA DEPOIS DA MONTAGEM.

     `montar()` desenha a barra antes de o `/eu` responder, então na primeira
     passagem não se sabe se a pessoa é administradora. `vestirDeReunioes` sai
     sem fazer nada nesse caso, e é chamada de novo aqui, quando já se sabe. */
  const iniciarComReunioes = LaChat.prototype.iniciar;
  LaChat.prototype.iniciar = async function () {
    const r = await iniciarComReunioes.call(this);
    try { vestirDeReunioes(this); } catch { }
    return r;
  };

  const trocarComReunioes = LaChat.prototype.trocarAba;
  LaChat.prototype.trocarAba = async function (aba) {
    const r = await trocarComReunioes.call(this, aba);
    if (aba === "reunioes") await this.carregarSalas();
    return r;
  };

  LaChat.prototype.carregarSalas = async function () {
    try {
      const { salas } = await this.api("/salas");
      this.estado.salas = salas || [];
      if (this.estado.aba === "reunioes") this.pintarLista();
    } catch (e) {
      this.mostrarFaixa(e.message, true);
    }
  };

  const pintarListaComReunioes = LaChat.prototype.pintarLista;
  LaChat.prototype.pintarLista = function () {
    if (this.estado.aba !== "reunioes" || this.estado.resultado)
      return pintarListaComReunioes.call(this);

    const lista = this.el.lista;
    limpar(lista);
    lista.appendChild(this.formaDeNovaSala());

    const salas = this.estado.salas || [];
    if (!salas.length) {
      lista.appendChild(criar("div", { classe: "carregando",
        texto: "Nenhum link criado ainda." }));
      return;
    }
    for (const s of salas) lista.appendChild(this.linhaDeSala(s));
  };

  /* ------------------------------------------------------------------------
     CRIAR

     A duração é uma LISTA, e não um campo livre. O servidor aceita de 5
     minutos a 8 horas e recusa o resto; um campo aberto convida a pessoa a
     descobrir a recusa depois de digitar. As opções são as reuniões que
     existem de verdade.
     ------------------------------------------------------------------------ */
  const DURACOES = [
    [15, "15 minutos"], [30, "30 minutos"], [60, "1 hora"],
    [90, "1h30"], [120, "2 horas"], [240, "4 horas"],
  ];

  LaChat.prototype.formaDeNovaSala = function () {
    const titulo = criar("input", { type: "text", maxlength: "80",
      placeholder: "Assunto da reunião (opcional)" });

    const duracao = criar("select", { "aria-label": "Duração da reunião" });
    for (const [min, rotulo] of DURACOES) {
      const o = criar("option", { texto: rotulo });
      o.value = String(min);
      if (min === 60) o.selected = true;
      duracao.appendChild(o);
    }

    const botao = criar("button", { type: "button", texto: "Criar link de reunião" });
    botao.onclick = async () => {
      botao.disabled = true;
      try {
        await this.api("/salas", { metodo: "POST", corpo: {
          titulo: titulo.value.trim(),
          duracaoMin: Number(duracao.value),
        } });
        titulo.value = "";
        await this.carregarSalas();
      } catch (e) {
        this.mostrarFaixa(e.message, true);
      } finally {
        botao.disabled = false;
      }
    };

    return criar("div", { classe: "sala-nova" }, [titulo, duracao, botao]);
  };

  /* ------------------------------------------------------------------------
     UMA LINHA DA LISTA
     ------------------------------------------------------------------------ */
  LaChat.prototype.linhaDeSala = function (s) {
    const viva = s.estado === "ativa";
    /* TRÊS ESTADOS, e não dois. A versão anterior perguntava só "está viva?",
       e tratava tudo que não estava como "pode abrir" — então uma sala
       ENCERRADA (por tempo) ou REVOGADA continuava exibindo "Abrir sala".
       O botão levaria a uma recusa do servidor, que é o pior tipo de botão:
       o que promete e o sistema desmente. */
    /* `ativa` diz que a sala foi ABERTA, não que há reunião acontecendo.
       Quando o anfitrião sai e era o último, a chamada encerra e a sala
       continua ativa — e a versão anterior oferecia "Entrar" para uma chamada
       morta, que respondia "Esta chamada já terminou". O dono ficava trancado
       do lado de fora da própria reunião, com o link já distribuído. */
    const podeAbrir = s.estado === "aberta" || (s.estado === "ativa" && !s.chamadaViva);
    const morta = s.estado === "encerrada" || s.estado === "revogada";

    /* O link num <code>, e não num <input>: ele não é editável, e um campo
       editável convida a alterar o que só funciona intacto. Copiar tem
       botão. */
    const campo = criar("code", { texto: s.link });

    const copiar = criar("button", { type: "button", texto: "Copiar link" });
    copiar.onclick = async () => {
      const antes = copiar.textContent;
      try {
        await navigator.clipboard.writeText(s.link);
        copiar.textContent = "Copiado!";
      } catch {
        /* Sem permissão de área de transferência — o que acontece fora de
           HTTPS. Selecionar o texto é o plano B, e é melhor que um erro:
           a pessoa ainda consegue copiar com o teclado. */
        try {
          const faixa = document.createRange();
          faixa.selectNodeContents(campo);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(faixa);
          copiar.textContent = "Selecionado — copie";
        } catch { copiar.textContent = "Copie o link acima"; }
      }
      setTimeout(() => { copiar.textContent = antes; }, 2000);
    };

    /* Numa sala morta não sobra ação nenhuma — nem copiar. Um link encerrado
       copiado é um link encerrado ENVIADO, e quem recebe bate numa porta que o
       anfitrião acha que abriu. A linha vira registro do que houve. */
    const acoes = morta ? [] : [copiar];

    /* ABRIR é o que transforma o link num convite utilizável: até o anfitrião
       abrir, quem tem o link fica na tela de espera. É deliberado — um link
       que deixa entrar sozinho é uma sala onde estranhos se encontram sem
       ninguém da casa. */
    if (podeAbrir) {
      const abrir = criar("button", { classe: "forte", type: "button",
        texto: s.estado === "ativa" ? "Reabrir sala" : "Abrir sala" });
      abrir.onclick = async () => {
        abrir.disabled = true;
        try {
          const r = await this.api("/salas/" + s.id + "/abrir", { metodo: "POST" });
          this.sala = { id: s.id, titulo: s.titulo, link: s.link, encerraEm: r.encerraEm || null };
          await this.montarChamada(r.chamada || r);
          this.carregarSalas();
        } catch (e) {
          this.mostrarFaixa(e.message, true);
          abrir.disabled = false;
        }
      };
      acoes.push(abrir);
    } else if (viva && s.chamadaViva) {
      const voltar = criar("button", { classe: "forte", type: "button", texto: "Entrar" });
      voltar.onclick = async () => {
        try {
          const r = await this.api("/chamadas/" + s.chamadaId + "/entrar", { metodo: "POST" });
          this.sala = { id: s.id, titulo: s.titulo, link: s.link, encerraEm: s.encerraEm || null };
          await this.montarChamada(r);
        } catch (e) { this.mostrarFaixa(e.message, true); }
      };
      acoes.push(voltar);
    }

    /* Revogar o que já acabou não faz nada, e oferecer a ação sugere que
       ainda há algo para desfazer. */
    const revogar = morta ? null : criar("button", { classe: "risco", type: "button", texto: "Revogar" });
    if (revogar) revogar.onclick = async () => {
      /* Revogar derruba quem estiver dentro. A confirmação não é burocracia:
         é a única coisa entre um clique errado e uma reunião interrompida
         com gente falando. */
      if (!confirm("Revogar este link? Quem estiver na reunião será desconectado.")) return;
      try {
        await this.api("/salas/" + s.id, { metodo: "DELETE" });
        await this.carregarSalas();
      } catch (e) { this.mostrarFaixa(e.message, true); }
    };
    if (revogar) acoes.push(revogar);

    const linha = criar("div", { classe: "sala-linha", role: "listitem" }, [
      criar("div", { classe: "topo" }, [
        criar("b", { texto: s.titulo || "Reunião" }),
        criar("span", {
          classe: "selo" + (viva ? " viva" : ""),
          texto: viva ? "em andamento" : (s.estado === "aberta" ? "aguardando" : s.estado),
        }),
      ]),
      criar("div", { classe: "link" }, [campo]),
      criar("div", { classe: "acoes" }, acoes),
    ]);

    /* Quem está dentro só é buscado para as salas VIVAS. Pedir participantes
       de dez links parados seriam dez requisições para mostrar dez zeros. */
    if (viva) {
      const quem = criar("div", { classe: "quem", texto: "Carregando participantes…" });
      linha.appendChild(quem);
      this.pintarParticipantesDaSala(s, quem);
    }

    return linha;
  };

  LaChat.prototype.pintarParticipantesDaSala = async function (s, alvo) {
    let lista;
    try {
      ({ convidados: lista } = await this.api("/salas/" + s.id + "/participantes"));
    } catch {
      alvo.textContent = "";
      return;
    }

    limpar(alvo);
    const dentro = (lista || []).filter((c) => !c.saiuEm && !c.expulso);
    if (!dentro.length) {
      alvo.textContent = "Ninguém entrou ainda.";
      return;
    }

    for (const c of dentro) {
      const tirar = criar("button", { type: "button", texto: "remover",
        title: "Remover da reunião" });
      tirar.onclick = async () => {
        tirar.disabled = true;
        try {
          await this.api("/salas/" + s.id + "/remover/" + c.usuarioId, { metodo: "POST" });
          await this.carregarSalas();
        } catch (e) {
          this.mostrarFaixa(e.message, true);
          tirar.disabled = false;
        }
      };
      /* O nome do convidado entra por textContent, como todo texto de fora.
         Ele foi digitado por um estranho, sem conta e sem vínculo — é o
         texto menos confiável que este sistema exibe. */
      alvo.appendChild(criar("div", {}, [
        criar("span", { texto: c.nome || "Convidado" }),
        tirar,
      ]));
    }
  };


  /* ==========================================================================
     10. A REUNIÃO EM JANELA PRÓPRIA

     O anfitrião conduz a reunião numa gaveta de 380 px, ao lado da lista de
     conversas. Para conduzir de verdade — ver rosto, notar quem quer falar —
     isso é pouco. Ele precisa da reunião grande, e de preferência num monitor
     enquanto trabalha no outro.

     ---------------------------------------------------------------------------
     POR QUE NÃO `window.open`

     O caminho óbvio seria abrir uma página nova com a reunião. Ele está errado
     por um motivo que não aparece até a terceira pessoa entrar: na malha
     WebRTC cada participante é identificado pelo ID DO USUÁRIO. A mesma pessoa
     em duas janelas vira dois pares com o mesmo id — os outros passam a
     receber duas ofertas de "Ana" e a negociar com um par que é o próprio.

     Contornar exigiria DESMONTAR a chamada aqui e remontar lá, e essa entrega
     tem um buraco: se o bloqueador de pop-up recusar a janela depois de já
     termos saído, o anfitrião perde a reunião que ele estava conduzindo.

     ---------------------------------------------------------------------------
     O QUE FAZEMOS

     `documentPictureInPicture` dá uma janela DE VERDADE — redimensionável,
     acima das outras, arrastável para o segundo monitor — e permite MUDAR OS
     NÓS DO DOM de lugar. O painel da reunião muda de janela levando consigo os
     mesmos `<video>`, as mesmas `RTCPeerConnection` e o mesmo socket.

     Nada é remontado, nada é renegociado, ninguém entra duas vezes. A reunião
     não fica sabendo que mudou de janela.

     Fora do Chrome e do Edge a API não existe. Lá o botão NÃO APARECE — em vez
     de aparecer e fazer outra coisa. Tela cheia continua para todos, e é o que
     resolve "quero ver maior" em qualquer navegador.
     ========================================================================== */

  const TEM_JANELA = typeof window !== "undefined" && !!window.documentPictureInPicture;

  /* O painel da reunião tem cores próprias e não depende dos tokens do tema
     (ver o CSS lá em cima: #0d1117, #21262d…). É o que torna a mudança de
     janela barata: basta levar as folhas de estilo, sem reconstruir a cascata
     de variáveis do hospedeiro. */
  LaChat.prototype.botoesDeVista = function () {
    const v = this.video;
    const caixa = criar("div", { classe: "vista" });

    if (v?.janela) {
      caixa.appendChild(criar("button", {
        type: "button", texto: "↙ Voltar para a aba",
        title: "Trazer a reunião de volta para esta aba",
        onclick: () => this.fecharJanelaDaReuniao(),
      }));
      return caixa;
    }

    /* O LINK, DENTRO DA REUNIÃO.

       Ele vive na aba "Reuniões", e a reunião cobre a tela inteira — então,
       no momento em que o anfitrião mais precisa dele (alguém pede o convite
       no meio da conversa), era preciso sair da reunião para buscá-lo.

       Só aparece quando esta chamada É de uma sala por link: numa chamada
       interna não há link nenhum a compartilhar. */
    if (this.sala?.link) {
      const copiar = criar("button", {
        type: "button", texto: "🔗 Link",
        "aria-label": "Copiar o link do convite",
        title: "Copiar o link do convite",
        onclick: async () => {
          const antes = copiar.textContent;
          try {
            await navigator.clipboard.writeText(this.sala.link);
            copiar.textContent = "Copiado!";
          } catch {
            /* Sem área de transferência (acontece fora de HTTPS): mostrar o
               endereço é melhor que uma falha silenciosa — dá para ler e
               digitar, ou copiar à mão. */
            this.avisoDeVideo(this.sala.link);
            setTimeout(() => this.avisoDeVideo(""), 15000);
            copiar.textContent = "Veja acima";
          }
          setTimeout(() => { copiar.textContent = antes; }, 2500);
        },
      });
      caixa.appendChild(copiar);
    }

    if (TEM_JANELA) {
      caixa.appendChild(criar("button", {
        type: "button", texto: "⧉",
        "aria-label": "Abrir a reunião em outra janela",
        title: "Abrir em outra janela",
        onclick: () => this.abrirReuniaoEmJanela(),
      }));
    }

    caixa.appendChild(criar("button", {
      type: "button", texto: "⛶",
      "aria-label": "Tela cheia",
      title: "Tela cheia",
      onclick: () => this.telaCheiaDaReuniao(),
    }));

    return caixa;
  };

  /* ------------------------------------------------------------------------
     TELA CHEIA — funciona em todo navegador, inclusive celular.
     ------------------------------------------------------------------------ */
  LaChat.prototype.telaCheiaDaReuniao = function () {
    const alvo = this.el.chamada;
    if (!alvo) return;
    const doc = alvo.ownerDocument;

    if (doc.fullscreenElement) {
      doc.exitFullscreen?.();
      return;
    }
    /* A promessa é rejeitada quando o navegador recusa (política de permissão
       num iframe, por exemplo). Um aviso é melhor que um botão que não faz
       nada e não explica. */
    alvo.requestFullscreen?.().catch(() => {
      this.avisoDeVideo("Este navegador não deixou abrir em tela cheia.");
      setTimeout(() => this.avisoDeVideo(""), 4000);
    });
  };

  /* ------------------------------------------------------------------------
     ABRIR EM JANELA
     ------------------------------------------------------------------------ */
  /* ------------------------------------------------------------------------
     A REUNIÃO ACONTECE, MESMO QUE SEM RELAY

     Chamado quando uma conexão FALHA de verdade. Se estávamos em `relay` —
     o que só acontece em reunião por link —, refaz a malha em conexão direta
     e diz o que mudou.

     Uma reunião que não acontece protege o endereço IP de ninguém: as pessoas
     desligam e usam outro aplicativo, onde o IP também aparece. Descer com
     aviso é mais honesto que falhar em silêncio.
     ------------------------------------------------------------------------ */
  /* ------------------------------------------------------------------------
     O QUE ESTÁ ACONTECENDO, PASSADOS 20 SEGUNDOS

     Escrito para ser lido por quem está no celular, sem console e sem paciência:
     primeiro a conclusão, depois o detalhe técnico entre parênteses para quem
     for repassar a quem cuida do servidor.
     ------------------------------------------------------------------------ */
  LaChat.prototype.diagnosticarDemora = function () {
    const v = this.video;
    if (!v?.chamada || !v.malha) return;

    const travados = [...v.participantes.values()].filter((p) =>
      p.estado === "dentro" && p.id !== this.estado.eu?.id &&
      !["connected", "completed"].includes(v.malha.estadoDe(p.id) || ""));

    if (!travados.length) return;   // conectou: nada a dizer

    const erros = v.errosIce || [];
    /* A conclusão vem do PADRÃO dos erros, não do último deles. */
    const tudoExpirou = erros.length > 0 && erros.every((e) => /timed out|time out/i.test(e.texto || ""));
    const recusou = erros.some((e) => e.codigo === 401 || e.codigo === 403);

    let frase;
    if (recusou) {
      frase = "O servidor de relay recusou a credencial. Avise quem cuida do servidor.";
    } else if (tudoExpirou) {
      frase = "Sua rede não está alcançando o servidor de vídeo. "
        + "Tente por outra rede (Wi-Fi em vez de dados móveis, ou o contrário).";
    } else if (!erros.length) {
      frase = "A conexão de vídeo não fechou. Pode ser bloqueio da sua rede.";
    } else {
      frase = "A conexão de vídeo não fechou.";
    }

    /* ==================================================================
       O DETALHE TÉCNICO NÃO VAI PARA A TELA.

       Endereços de servidor e mensagens do navegador — "Address not
       associated with the desired network interface" — não dizem nada a quem
       está numa reunião, e ocupam a faixa inteira com um texto que assusta.

       A pessoa precisa saber DUAS coisas: que não conectou, e o que ela pode
       fazer. O resto é para quem vai consertar, e continua guardado em
       `video.errosIce` — sem ocupar espaço na cara de ninguém.
       ================================================================== */
    this.avisoDeVideo(frase);

    /* Pergunta de novo mais adiante: redes ruins às vezes fecham em 40 s, e
       nesse caso o aviso precisa sair da tela. */
    clearTimeout(v.paciencia);
    v.paciencia = setTimeout(() => {
      const aindaTravado = [...v.participantes.values()].some((p) =>
        p.estado === "dentro" && p.id !== this.estado.eu?.id &&
        !["connected", "completed"].includes(v.malha?.estadoDe(p.id) || ""));
      if (!aindaTravado) this.avisoDeVideo("");
      else this.diagnosticarDemora();
    }, 25000);
  };

  LaChat.prototype.recuarDoRelay = function (erro) {
    const v = this.video;
    if (!v?.malha) return;

    if (v.recuou || v.malha.politicaAtual() !== "relay") {
      this.avisoDeVideo(erro?.message || "A conexão falhou.");
      clearTimeout(this._avisoIce);
      this._avisoIce = setTimeout(() => this.avisoDeVideo(""), 25000);
      return;
    }

    v.recuou = true;
    this.avisoDeVideo("O servidor de relay não respondeu. Conectando direto — "
      + "nesta reunião os participantes podem ver o endereço IP uns dos outros.");
    clearTimeout(this._avisoIce);
    this._avisoIce = setTimeout(() => this.avisoDeVideo(""), 30000);

    const ids = v.malha.refazerCom("all");
    if (v.local) v.malha.definirLocal(v.local);

    /* Quem RE-OFERECE é quem recuou. O outro lado recebe a oferta nova e
       responde; não há como combinar isso por fora, e os dois recuando ao
       mesmo tempo é resolvido pela mesma regra de educado da negociação. */
    for (const id of ids) v.malha.convidar(id);
    this.pintarChamada();
  };

  LaChat.prototype.abrirReuniaoEmJanela = async function () {
    const v = this.video;
    if (!v?.chamada || !this.el.chamada) return;
    if (v.janela) { try { v.janela.focus(); } catch { } return; }
    if (!TEM_JANELA) return this.telaCheiaDaReuniao();

    let janela;
    try {
      /* O tamanho parte do que a reunião ocupa agora, com um piso: uma janela
         do tamanho da gaveta não resolveria o problema que ela existe para
         resolver. */
      const r = this.el.chamada.getBoundingClientRect();
      janela = await window.documentPictureInPicture.requestWindow({
        width: Math.max(720, Math.round(r.width)),
        height: Math.max(480, Math.round(r.height)),
      });
    } catch {
      /* Recusa do navegador (sem gesto do usuário, política do sistema). Não
         mexemos em NADA antes deste ponto — a reunião continua inteira aqui. */
      this.avisoDeVideo("Não foi possível abrir outra janela.");
      setTimeout(() => this.avisoDeVideo(""), 4000);
      return;
    }

    v.janela = janela;

    /* ------------------------------------------------------------------
       O PALCO

       Um elemento com Shadow Root PRÓPRIO na janela nova. Isso resolve, de
       graça, o problema que faria este recurso custar uma tarde: as regras
       do painel são escritas com `:host` e com classes curtas (`.grade`,
       `.quadro`), e fora de um shadow root elas não casariam nada ou
       casariam demais. Dentro de um shadow root novo, `:host` passa a ser o
       palco e todo o CSS vale sem uma linha reescrita.
       ------------------------------------------------------------------ */
    const doc = janela.document;
    doc.documentElement.lang = "pt-BR";
    doc.title = v.chamada?.titulo || this.sala?.titulo || "Reunião";

    const base = doc.createElement("style");
    base.textContent =
      "html,body{margin:0;height:100%;background:#0d1117;overflow:hidden}";
    doc.head.appendChild(base);

    const palco = doc.createElement("div");
    palco.style.cssText = "display:block;position:relative;height:100%";
    const raiz = palco.attachShadow({ mode: "open" });

    for (const folha of this.raiz.querySelectorAll("style"))
      raiz.appendChild(doc.importNode(folha, true));

    const ajuste = doc.createElement("style");
    ajuste.textContent = ":host{display:block;position:relative;height:100%}";
    raiz.appendChild(ajuste);

    /* A MUDANÇA. Um `appendChild` num documento diferente move o nó e mantém
       tudo que ele carrega: os `<video>` seguem tocando as mesmas streams,
       porque o objeto de mídia mora no elemento e não no documento. */
    raiz.appendChild(this.el.chamada);
    doc.body.appendChild(palco);

    this.mostrarReuniaoNoutraJanela(true);
    this.pintarChamada();

    /* Fechar a janela — pelo X, por fechar a aba de origem, por qualquer
       caminho — devolve a reunião para cá. Nunca a perde. */
    janela.addEventListener("pagehide", () => this.recolherReuniao(), { once: true });
  };

  /* Traz de volta por vontade nossa (botão). O `close()` dispara o `pagehide`,
     que chama `recolherReuniao` — o caminho de volta é UM só, e é por isso
     que fechar pelo X e fechar pelo botão não podem divergir. */
  LaChat.prototype.fecharJanelaDaReuniao = function () {
    const j = this.video?.janela;
    if (!j) return;
    try { j.close(); } catch { this.recolherReuniao(); }
  };

  LaChat.prototype.recolherReuniao = function () {
    const v = this.video;
    if (!v) return;
    v.janela = null;

    /* O painel volta para dentro do componente. Se a chamada já tiver acabado
       enquanto estava fora, `this.el.chamada` ainda é o mesmo nó — devolvê-lo
       escondido é o certo, e é o que `desmontarChamada` deixou preparado. */
    if (this.el.chamada && this.el.painel && this.el.chamada.parentNode !== this.el.painel)
      this.el.painel.appendChild(this.el.chamada);

    this.mostrarReuniaoNoutraJanela(false);
    if (v.chamada) this.pintarChamada();
  };

  /* O aviso que ocupa o lugar da reunião na aba de origem. */
  LaChat.prototype.mostrarReuniaoNoutraJanela = function (fora) {
    if (!this.el.painel) return;

    if (!this.el.chamadaFora) {
      const voltar = criar("button", {
        type: "button", texto: "Trazer de volta",
        onclick: () => this.fecharJanelaDaReuniao(),
      });
      this.el.chamadaFora = criar("div", { classe: "chamada-fora", hidden: "" }, [
        criar("div", {}, [
          criar("b", { texto: "A reunião está em outra janela" }),
          criar("p", { texto: "Ela continua acontecendo. Procure a janela flutuante, ou traga de volta para cá." }),
          voltar,
        ]),
      ]);
      this.el.painel.appendChild(this.el.chamadaFora);
    }

    this.el.chamadaFora.hidden = !fora;
  };

  /* ------------------------------------------------------------------------
     O QUE ACABA JUNTO COM A REUNIÃO

     UM invólucro só, e de propósito. Antes eram dois — um para esquecer a
     sala, outro para fechar a janela — espalhados por seções diferentes do
     arquivo. Funcionava, e era exatamente o tipo de coisa que faz a próxima
     pessoa procurar no lugar errado: quem lesse o primeiro concluiria que já
     tinha visto tudo que acontece ao desmontar.

     A JANELA. Sem fechá-la sobraria uma janela flutuante com uma reunião
     encerrada dentro, e o anfitrião a fecharia achando que estava desligando
     alguma coisa.

     A SALA. Sem esquecê-la, o anfitrião que termina uma reunião por link e
     liga para um colega em seguida veria, na chamada nova, o título e a
     contagem regressiva da reunião ANTERIOR — um relógio zerado avisando que
     uma reunião já encerrada está para acabar.
     ------------------------------------------------------------------------ */
  const desmontarOriginalDoModulo = LaChat.prototype.desmontarChamada;
  LaChat.prototype.desmontarChamada = function (motivo) {
    const j = this.video?.janela;
    desmontarOriginalDoModulo.call(this, motivo);
    if (j) { try { j.close(); } catch { } this.recolherReuniao(); }
    this.sala = null;
  };

})();
