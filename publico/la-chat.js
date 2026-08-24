/* ==========================================================================
   la-chat.js — o cliente

   Um Custom Element com Shadow DOM. Sem framework, sem build, sem
   dependência: o navegador recebe este arquivo e funciona.

       <la-chat modo="drawer"></la-chat>

   ---------------------------------------------------------------------------
   POR QUE SHADOW DOM (§36, §50)

   Este componente é injetado na página de OUTRO site — um que eu não controlo
   e não posso quebrar. Sem Shadow DOM:

     · o `.btn` do site do cliente repinta o botão de enviar;
     · o `input { font-family: ... }` do formulário de orçamento vaza para o
       campo de mensagem;
     · e o CSS do chat vaza de volta, quebrando o site do cliente.

   O Shadow DOM é o ÚNICO isolamento real de CSS que existe sem passo de
   build. As variáveis CSS atravessam a barreira de propósito — é por elas que
   o hospedeiro personaliza (`la-chat { --chat-primaria: #1e275f }`) sem tocar
   no código do módulo.

   ---------------------------------------------------------------------------
   A REGRA QUE NÃO SE QUEBRA: NENHUM innerHTML COM CONTEÚDO DE USUÁRIO

   O HTML da estrutura é escrito por nós e é constante. Tudo que veio de uma
   pessoa — mensagem, nome, cargo, nome de arquivo — entra por `textContent`
   ou por `createElement`. Não existe caminho neste arquivo em que texto de
   usuário vire HTML.

   Isso torna XSS estruturalmente impossível no cliente, em vez de "improvável
   se o sanitizador estiver em dia". Ver `src/dominio/texto.js`, que explica
   por que essa é a escolha e não a sanitização.
   ========================================================================== */
(function () {
  "use strict";

  if (customElements.get("la-chat")) return;   // já carregado

  /* ==========================================================================
     1. DESIGN SYSTEM (§50)

     Poucos tokens, todos com nome do que SÃO e não de como parecem. Claro e
     escuro pelo mesmo conjunto: o tema troca os valores, nunca as regras.
     ========================================================================== */
  const CSS = `
:host {
  /* --- cor: o hospedeiro sobrescreve estas quatro e o chat inteiro segue --- */
  --chat-primaria: #2c5cff;
  --chat-primaria-texto: #ffffff;
  --chat-raio: 12px;
  --chat-fonte: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

  /* --- superfícies --- */
  --fundo: #ffffff;
  --fundo-2: #f6f7f9;
  --fundo-3: #eceef2;
  --linha: #dfe3ea;
  --tinta: #1a1d23;
  --tinta-2: #5b6474;
  --tinta-3: #8b94a3;

  --bolha-minha: var(--chat-primaria);
  --bolha-minha-texto: var(--chat-primaria-texto);
  --bolha-dele: #eef0f4;
  --bolha-dele-texto: #1a1d23;

  --online: #16a34a;
  --ocupado: #dc2626;
  --ausente: #d97706;
  --offline: #9aa2b1;
  --perigo: #b91c1c;
  --perigo-fundo: #fdecec;

  --sombra: 0 10px 40px rgba(15, 20, 35, .18);
  --sombra-2: 0 1px 3px rgba(15, 20, 35, .10);

  --espaco: 12px;
  --barra: 300px;

  font-family: var(--chat-fonte);
  font-size: 14px;
  line-height: 1.5;
  color: var(--tinta);
}

/* O tema escuro segue o sistema, e o atributo vence o sistema — é o que
   permite ao hospedeiro forçar um tema sem brigar com o navegador. */
@media (prefers-color-scheme: dark) {
  :host(:not([tema="claro"])) {
    --fundo: #14171c; --fundo-2: #1a1e25; --fundo-3: #232830;
    --linha: #2d3440; --tinta: #e8eaee; --tinta-2: #a3abba; --tinta-3: #737c8c;
    --bolha-dele: #232830; --bolha-dele-texto: #e8eaee;
    --sombra: 0 10px 40px rgba(0, 0, 0, .55);
    --perigo-fundo: #3a1c1c;
  }
}
:host([tema="escuro"]) {
  --fundo: #14171c; --fundo-2: #1a1e25; --fundo-3: #232830;
  --linha: #2d3440; --tinta: #e8eaee; --tinta-2: #a3abba; --tinta-3: #737c8c;
  --bolha-dele: #232830; --bolha-dele-texto: #e8eaee;
  --sombra: 0 10px 40px rgba(0, 0, 0, .55);
  --perigo-fundo: #3a1c1c;
}

*, *::before, *::after { box-sizing: border-box; }

/* ==========================================================================
   OS TRÊS MODOS (§3) — um atributo, não três construções
   ========================================================================== */
.moldura { display: none; }
:host([aberto]) .moldura { display: flex; }

/* modal — sobre a aplicação */
:host([modo="modal"]) .moldura {
  position: fixed; inset: 0; z-index: 2147483000;
  background: rgba(12, 16, 24, .45);
  align-items: center; justify-content: center; padding: 4vh 4vw;
}
:host([modo="modal"]) .painel {
  width: min(1100px, 100%); height: min(760px, 100%);
  border-radius: var(--chat-raio); box-shadow: var(--sombra); overflow: hidden;
}

/* drawer — painel lateral */
:host([modo="drawer"]) .moldura {
  position: fixed; inset: 0; z-index: 2147483000;
  background: rgba(12, 16, 24, .35); justify-content: flex-end;
}
:host([modo="drawer"]) .painel {
  width: min(760px, 100%); height: 100%; box-shadow: var(--sombra);
  animation: entrar .18s ease-out;
}
@keyframes entrar { from { transform: translateX(24px); opacity: .6 } to { transform: none; opacity: 1 } }

/* fullpage — ocupa o que o hospedeiro der */
:host([modo="fullpage"]) .moldura { position: relative; width: 100%; height: 100%; }
:host([modo="fullpage"]) .painel { width: 100%; height: 100%; }

/* Quem prefere menos movimento não recebe movimento. */
@media (prefers-reduced-motion: reduce) {
  .painel { animation: none !important; }
  * { transition: none !important; }
}

/* position:relative para as camadas que se sobrepõem AO PAINEL (perfil,
   reunião, toque) se posicionarem contra ele, e não contra a janela inteira.
   Sem isto, no modo drawer a sobreposição escurecia a tela toda em vez do
   painel — e a reunião cobria o site do hospedeiro por baixo. */
.painel { position: relative; display: flex; background: var(--fundo); color: var(--tinta); overflow: hidden; }

/* ==========================================================================
   BARRA LATERAL
   ========================================================================== */
.barra {
  width: var(--barra); flex: 0 0 var(--barra); display: flex; flex-direction: column;
  background: var(--fundo-2); border-right: 1px solid var(--linha); min-height: 0;
}
.barra-topo { padding: var(--espaco); border-bottom: 1px solid var(--linha); }
.marca { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.marca strong { font-size: 15px; letter-spacing: -.01em; }
.marca .pt { width: 8px; height: 8px; border-radius: 50%; background: var(--offline); flex: none; }
.marca .pt.ok { background: var(--online); }

.busca { position: relative; }
.busca input {
  width: 100%; padding: 9px 12px; border: 1px solid var(--linha); border-radius: 9px;
  background: var(--fundo); color: var(--tinta); font: inherit;
}
.busca input:focus-visible { outline: 2px solid var(--chat-primaria); outline-offset: 1px; }

.abas { display: flex; gap: 4px; padding: 8px var(--espaco) 0; }
.aba {
  flex: 1; padding: 7px 6px; border: 0; background: transparent; color: var(--tinta-2);
  font: inherit; font-size: 13px; border-radius: 8px; cursor: pointer;
}
.aba[aria-selected="true"] { background: var(--fundo-3); color: var(--tinta); font-weight: 600; }
.aba:focus-visible { outline: 2px solid var(--chat-primaria); outline-offset: 1px; }

.lista { flex: 1; overflow-y: auto; padding: 8px; min-height: 0; }

.item {
  display: flex; gap: 10px; align-items: center; width: 100%; text-align: left;
  padding: 9px 10px; border: 0; border-radius: 10px; background: transparent;
  color: inherit; font: inherit; cursor: pointer;
}
.item:hover { background: var(--fundo-3); }
.item[aria-current="true"] { background: var(--fundo-3); }
.item:focus-visible { outline: 2px solid var(--chat-primaria); outline-offset: -2px; }
.item .txt { flex: 1; min-width: 0; }
.item .nome { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.item .nome b { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item .hora { font-size: 11px; color: var(--tinta-3); flex: none; }
.item .previa { font-size: 12.5px; color: var(--tinta-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item.nao-lida .previa { color: var(--tinta); font-weight: 600; }

/* ==========================================================================
   A LINHA DA CONVERSA — envelope, e não só o botão

   O item era um <button>. Pôr os três pontinhos DENTRO dele seria botão
   dentro de botão: HTML inválido, e o teclado deixa de alcançar o de dentro.
   Então a linha virou um envelope com dois controles irmãos.
   ========================================================================== */
.linha { position: relative; display: flex; align-items: stretch; }
.linha > .item { flex: 1; min-width: 0; }

.tres {
  flex: none; width: 30px; border: 0; background: transparent; cursor: pointer;
  color: var(--tinta-3); font-size: 16px; line-height: 1; padding: 0;
  opacity: 0; transition: opacity .12s ease;
}
/* Aparece ao passar o mouse — e SEMPRE onde não há mouse, porque num celular
   um controle que só existe no hover não existe. */
.linha:hover .tres, .tres:focus-visible, .tres[aria-expanded="true"] { opacity: 1; }
@media (hover: none) { .tres { opacity: .7; } }
.tres:hover { color: var(--tinta); }
.tres:focus-visible { outline: 2px solid var(--chat-primaria); outline-offset: -2px; }

.menu {
  position: absolute; right: 6px; top: 100%; z-index: 40;
  min-width: 160px; padding: 4px;
  background: var(--fundo); border: 1px solid var(--linha);
  border-radius: 10px; box-shadow: var(--sombra);
  display: flex; flex-direction: column;
}
.menu[hidden] { display: none; }
.menu button {
  text-align: left; border: 0; background: transparent; cursor: pointer;
  font: inherit; font-size: 13px; color: var(--tinta);
  padding: 8px 10px; border-radius: 7px;
}
.menu button:hover { background: var(--fundo-3); }
.menu button:focus-visible { outline: 2px solid var(--chat-primaria); outline-offset: -2px; }
.menu button.risco { color: var(--perigo); }

.arquivadas {
  width: 100%; text-align: left; border: 0; cursor: pointer;
  background: transparent; color: var(--tinta-2); font: inherit; font-size: 12.5px;
  padding: 9px var(--espaco); border-top: 1px solid var(--linha);
}
.arquivadas:hover { background: var(--fundo-3); color: var(--tinta); }
.linha.arquivada .item .nome b { color: var(--tinta-2); font-weight: 500; }

.selo {
  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px;
  background: var(--chat-primaria); color: var(--chat-primaria-texto);
  font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: none;
}
.selo.mudo { background: var(--tinta-3); }

/* avatar */
.av { position: relative; width: 38px; height: 38px; flex: none; }
.av img, .av .ini {
  width: 100%; height: 100%; border-radius: 50%; object-fit: cover;
  background: var(--fundo-3); color: var(--tinta-2);
  display: grid; place-items: center; font-size: 13px; font-weight: 700;
}
.av .st {
  position: absolute; right: -1px; bottom: -1px; width: 11px; height: 11px;
  border-radius: 50%; border: 2px solid var(--fundo-2); background: var(--offline);
}
.av .st.online { background: var(--online); }
.av .st.ocupado { background: var(--ocupado); }
.av .st.ausente { background: var(--ausente); }
.cab .av .st { border-color: var(--fundo); }

.barra-baixo {
  padding: 10px var(--espaco); border-top: 1px solid var(--linha);
  display: flex; align-items: center; gap: 10px;
}
.barra-baixo .txt { flex: 1; min-width: 0; }
.barra-baixo b { display: block; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.barra-baixo select {
  font: inherit; font-size: 12px; border: 1px solid var(--linha); border-radius: 7px;
  background: var(--fundo); color: var(--tinta-2); padding: 3px 6px;
}

/* ==========================================================================
   ÁREA PRINCIPAL
   ========================================================================== */
.principal { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }

.cab {
  display: flex; align-items: center; gap: 10px; padding: 10px var(--espaco);
  border-bottom: 1px solid var(--linha); background: var(--fundo); min-height: 58px;
}
.cab .txt { flex: 1; min-width: 0; }
.cab b { display: block; font-size: 15px; }
.cab small { color: var(--tinta-2); font-size: 12px; }

/* Visível em TODO tamanho de tela. Antes ele só aparecia até 720px, e no
   computador não havia como fechar a conversa sem fechar o chat inteiro. */
.voltar { display: grid; }

.icone {
  width: 34px; height: 34px; border: 0; border-radius: 8px; background: transparent;
  color: var(--tinta-2); cursor: pointer; display: grid; place-items: center; flex: none;
  font-size: 17px; line-height: 1;
}
.icone:hover { background: var(--fundo-3); color: var(--tinta); }
.icone:focus-visible { outline: 2px solid var(--chat-primaria); outline-offset: 1px; }

.corpo { flex: 1; overflow-y: auto; padding: var(--espaco); min-height: 0; }

.vazio {
  height: 100%; display: grid; place-content: center; justify-items: center;
  gap: 8px; color: var(--tinta-2); text-align: center; padding: 24px;
}
.vazio .grande { font-size: 34px; opacity: .5; }
.vazio .dica { font-size: 12.5px; color: var(--tinta-3); }

/* mensagens */
.msg { display: flex; gap: 8px; margin: 2px 0; align-items: flex-end; }
.msg.minha { flex-direction: row-reverse; }
.msg .av { width: 28px; height: 28px; visibility: hidden; }
.msg.primeira .av { visibility: visible; }

.bolha {
  max-width: min(560px, 76%); padding: 8px 11px; border-radius: 14px;
  background: var(--bolha-dele); color: var(--bolha-dele-texto);
  word-wrap: break-word; overflow-wrap: anywhere; position: relative;
}
.msg.minha .bolha { background: var(--bolha-minha); color: var(--bolha-minha-texto); }
.msg.primeira .bolha { border-top-left-radius: 5px; }
.msg.minha.primeira .bolha { border-top-left-radius: 14px; border-top-right-radius: 5px; }

.bolha .autor { font-size: 12px; font-weight: 700; margin-bottom: 2px; opacity: .85; }
.bolha .rodape {
  display: flex; align-items: center; gap: 4px; justify-content: flex-end;
  font-size: 10.5px; opacity: .72; margin-top: 3px;
}
.bolha .conteudo p { margin: 0 0 6px; }
.bolha .conteudo p:last-child { margin-bottom: 0; }
.bolha .conteudo ul, .bolha .conteudo ol { margin: 4px 0; padding-left: 20px; }
.bolha .conteudo code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em;
  background: rgba(127, 127, 127, .18); padding: 1px 4px; border-radius: 4px;
}
.bolha .conteudo pre {
  margin: 4px 0; padding: 8px 10px; border-radius: 8px; overflow-x: auto;
  background: rgba(127, 127, 127, .16);
}
.bolha .conteudo pre code { background: none; padding: 0; }
.bolha .conteudo blockquote {
  margin: 4px 0; padding-left: 9px; border-left: 3px solid currentColor; opacity: .85;
}
.bolha .conteudo a { color: inherit; text-underline-offset: 2px; }
.bolha.apagada .conteudo { font-style: italic; opacity: .6; }

.anexo {
  display: flex; align-items: center; gap: 8px; margin-top: 5px; padding: 7px 9px;
  border-radius: 9px; background: rgba(127, 127, 127, .16); color: inherit;
  text-decoration: none; max-width: 300px;
}
.anexo:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
.anexo .nome { flex: 1; min-width: 0; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.anexo .tam { font-size: 11px; opacity: .7; flex: none; }

/* A imagem na bolha. O max-height evita que uma foto em pé de 4000px empurre
   a conversa inteira para fora da tela.
   (Sem crase neste comentário: ele vive dentro de um template literal, e uma
   crase aqui fecharia a string de CSS no meio.) */
.anexo-img { display: block; margin-top: 5px; border-radius: 10px; overflow: hidden; line-height: 0; }
.anexo-img img {
  display: block; max-width: 100%; width: auto; height: auto;
  max-height: 320px; object-fit: cover; background: rgba(127, 127, 127, .14);
}
.anexo-img:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

.dia { text-align: center; margin: 14px 0 8px; }
.dia span {
  font-size: 11.5px; color: var(--tinta-2); background: var(--fundo-3);
  padding: 3px 10px; border-radius: 10px;
}

/* estados (§52) */
.faixa {
  padding: 7px var(--espaco); font-size: 12.5px; text-align: center;
  background: var(--fundo-3); color: var(--tinta-2); border-bottom: 1px solid var(--linha);
}
.faixa.ruim { background: var(--perigo-fundo); color: var(--perigo); }
.digitando { padding: 2px var(--espaco) 6px; font-size: 12px; color: var(--tinta-2); height: 22px; }

.carregando { display: grid; place-items: center; padding: 20px; color: var(--tinta-3); font-size: 13px; }

/* redator */
.redator { border-top: 1px solid var(--linha); padding: 9px var(--espaco); background: var(--fundo); }
.redator .caixa { display: flex; align-items: flex-end; gap: 6px; }
.redator textarea {
  flex: 1; resize: none; border: 1px solid var(--linha); border-radius: 11px;
  padding: 9px 12px; font: inherit; background: var(--fundo-2); color: var(--tinta);
  max-height: 160px; min-height: 40px;
}
.redator textarea:focus-visible { outline: 2px solid var(--chat-primaria); outline-offset: -1px; }
.enviar {
  width: 40px; height: 40px; border: 0; border-radius: 50%; flex: none; cursor: pointer;
  background: var(--chat-primaria); color: var(--chat-primaria-texto); font-size: 16px;
}
.enviar:disabled { opacity: .45; cursor: default; }
.enviar:focus-visible { outline: 2px solid var(--tinta); outline-offset: 2px; }

.pendentes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 7px; }
.pendente {
  display: flex; align-items: center; gap: 6px; font-size: 12px;
  background: var(--fundo-3); border-radius: 8px; padding: 4px 8px;
}
.pendente button { border: 0; background: none; cursor: pointer; color: var(--tinta-2); font-size: 14px; }

/* modal de perfil (§7) */
.sobreposicao {
  position: absolute; inset: 0; background: rgba(12, 16, 24, .5);
  display: grid; place-items: center; padding: 20px; z-index: 5;
}
.cartao {
  background: var(--fundo); border-radius: var(--chat-raio); padding: 22px;
  width: min(340px, 100%); text-align: center; box-shadow: var(--sombra);
}
.cartao .av { width: 76px; height: 76px; margin: 0 auto 12px; }
.cartao h3 { margin: 0 0 2px; font-size: 17px; }
.cartao .cargo { color: var(--tinta-2); font-size: 13px; margin-bottom: 10px; }
.cartao dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; text-align: left;
  font-size: 13px; margin: 12px 0; }
.cartao dt { color: var(--tinta-2); }
.cartao dd { margin: 0; }
.botao {
  width: 100%; padding: 10px; border: 0; border-radius: 9px; cursor: pointer;
  background: var(--chat-primaria); color: var(--chat-primaria-texto); font: inherit; font-weight: 600;
}
.botao.fraco { background: var(--fundo-3); color: var(--tinta); }
.botao:focus-visible { outline: 2px solid var(--tinta); outline-offset: 2px; }

/* Só para leitor de tela — usado nos avisos ao vivo. */
.sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ==========================================================================
   CELULAR (§28) — a barra vira a tela inteira, e a conversa entra por cima
   ========================================================================== */
@media (max-width: 720px) {
  :host([modo="modal"]) .moldura { padding: 0; }
  :host([modo="modal"]) .painel, :host([modo="drawer"]) .painel {
    width: 100%; height: 100%; border-radius: 0;
  }
  .barra { width: 100%; flex: 1 1 auto; border-right: 0; }
  .painel[data-vendo="conversa"] .barra { display: none; }
  .painel:not([data-vendo="conversa"]) .principal { display: none; }
  .voltar { display: grid; }
  .bolha { max-width: 84%; }
}
`;

  /* ==========================================================================
     2. UTILIDADES
     ========================================================================== */

  const criar = (tag, props = {}, filhos = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "texto") el.textContent = v;                 // NUNCA innerHTML
      else if (k === "classe") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
    }
    for (const f of [].concat(filhos)) if (f) el.appendChild(f);
    return el;
  };

  const limpar = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

  const iniciais = (nome) => String(nome || "?").trim().split(/\s+/).slice(0, 2)
    .map((p) => p[0] || "").join("").toUpperCase() || "?";

  function hora(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function dia(ms) {
    const d = new Date(ms), h = new Date();
    const mesmo = (a, b) => a.toDateString() === b.toDateString();
    if (mesmo(d, h)) return "Hoje";
    const ontem = new Date(h); ontem.setDate(h.getDate() - 1);
    if (mesmo(d, ontem)) return "Ontem";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: d.getFullYear() !== h.getFullYear() ? "numeric" : undefined });
  }

  function horaCurta(ms) {
    if (!ms) return "";
    const d = new Date(ms), h = new Date();
    if (d.toDateString() === h.toDateString()) return hora(ms);
    const dif = (h - d) / 86400e3;
    if (dif < 7) return d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }

  const tamanhoLegivel = (b) => {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
    return (b / 1024 / 1024).toFixed(1) + " MB";
  };

  /* ULID simplificado para o `idCliente`. Não precisa da força criptográfica
     do servidor: serve para o servidor reconhecer um reenvio como sendo a
     mesma mensagem. Precisa apenas ser único nesta aba. */
  function idLocal() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  /* ==========================================================================
     3. O ANALISADOR DE MARCAÇÃO — espelho de src/dominio/texto.js

     NOTA IMPORTANTE: há duas implementações da mesma marcação, uma aqui e
     outra no servidor. Isso normalmente seria um defeito à espera. Aqui é
     aceitável, e a razão precisa ficar escrita:

       a divergência entre as duas é ESTÉTICA, nunca de segurança.

     Nenhuma das duas gera HTML a partir do texto do usuário. Se esta aqui
     interpretar um asterisco diferente da do servidor, alguém vê um itálico a
     mais. Não há caminho em que a diferença vire execução de código.

     A do servidor existe para prévia, notificação e busca; esta existe para a
     tela. Uni-las exigiria um passo de build, que é justamente o que este
     projeto evita para poder ser instalado copiando um arquivo.
     ========================================================================== */
  const MARCAS = [
    { tipo: "code", re: /`([^`\n]+)`/ },
    { tipo: "strong", re: /\*\*([^*\n]+)\*\*/ },
    { tipo: "s", re: /~~([^~\n]+)~~/ },
    { tipo: "em", re: /\*([^*\n]+)\*/ },
    /* Borda de palavra dos dois lados — senão `nome_do_campo` e `window.__x`
       viram sublinhado no meio do identificador. Espelha src/dominio/texto.js. */
    { tipo: "u", re: /(?<![\w])_([^_\n]+)_(?![\w])/ },
  ];
  const RE_URL = /https?:\/\/[^\s<>"']+/;

  function urlSegura(u) {
    const l = String(u || "").replace(/[\s\u0000-\u001F]/g, "");
    return /^https?:\/\//i.test(l) && l.length <= 2000 ? l : "";
  }

  /* Devolve NÓS, não texto. É esta função que torna o XSS impossível. */
  function partesDaLinha(linha, destino) {
    let resto = linha, guarda = 0;
    while (resto && guarda++ < 500) {
      let melhor = null;
      for (const m of MARCAS) {
        const a = m.re.exec(resto);
        if (a && (!melhor || a.index < melhor.a.index)) melhor = { m, a };
      }
      const link = RE_URL.exec(resto);
      if (link && (!melhor || link.index < melhor.a.index)) {
        if (link.index) destino.appendChild(document.createTextNode(resto.slice(0, link.index)));
        const href = urlSegura(link[0]);
        if (href) {
          destino.appendChild(criar("a", {
            href, target: "_blank",
            /* `noopener` impede a página aberta de mexer na nossa por
               `window.opener`; `noreferrer` impede vazar a URL do chat. */
            rel: "noopener noreferrer nofollow", texto: link[0],
          }));
        } else {
          destino.appendChild(document.createTextNode(link[0]));
        }
        resto = resto.slice(link.index + link[0].length);
        continue;
      }
      if (!melhor) break;
      if (melhor.a.index) destino.appendChild(document.createTextNode(resto.slice(0, melhor.a.index)));
      destino.appendChild(criar(melhor.m.tipo, { texto: melhor.a[1] }));
      resto = resto.slice(melhor.a.index + melhor.a[0].length);
    }
    if (resto) destino.appendChild(document.createTextNode(resto));
  }

  function renderizarTexto(texto) {
    const raiz = criar("div", { classe: "conteudo" });
    const linhas = String(texto || "").split("\n");
    let i = 0;

    while (i < linhas.length) {
      const l = linhas[i];

      if (/^\s*```/.test(l)) {
        const corpo = [];
        i++;
        while (i < linhas.length && !/^\s*```/.test(linhas[i])) corpo.push(linhas[i++]);
        i++;
        raiz.appendChild(criar("pre", {}, [criar("code", { texto: corpo.join("\n") })]));
        continue;
      }

      if (/^\s*>\s?/.test(l)) {
        const bq = criar("blockquote");
        partesDaLinha(l.replace(/^\s*>\s?/, ""), bq);
        raiz.appendChild(bq);
        i++;
        continue;
      }

      const marcador = /^\s*([-*]|\d{1,3}[.)])\s+/.exec(l);
      if (marcador) {
        const ordenada = /\d/.test(marcador[1]);
        const lista = criar(ordenada ? "ol" : "ul");
        while (i < linhas.length) {
          const m = /^\s*([-*]|\d{1,3}[.)])\s+(.*)$/.exec(linhas[i]);
          if (!m || (/\d/.test(m[1]) !== ordenada)) break;
          const li = criar("li");
          partesDaLinha(m[2], li);
          lista.appendChild(li);
          i++;
        }
        raiz.appendChild(lista);
        continue;
      }

      if (!l.trim()) { i++; continue; }

      const p = criar("p");
      let primeira = true;
      while (i < linhas.length && linhas[i].trim()
             && !/^\s*```/.test(linhas[i]) && !/^\s*>\s?/.test(linhas[i])
             && !/^\s*([-*]|\d{1,3}[.)])\s+/.test(linhas[i])) {
        if (!primeira) p.appendChild(criar("br"));
        partesDaLinha(linhas[i], p);
        primeira = false;
        i++;
      }
      raiz.appendChild(p);
    }

    if (!raiz.childNodes.length) raiz.appendChild(criar("p", { texto: "" }));
    return raiz;
  }

  /* ==========================================================================
     4. SOM (§14)

     O NAVEGADOR BLOQUEIA ÁUDIO ANTES DA PRIMEIRA INTERAÇÃO — e isso é correto.
     O briefing manda não tentar contornar: nada de áudio antes de a pessoa
     clicar em algo, e se o navegador recusar, o aviso visual continua. O som é
     reforço, nunca o único sinal.

     ---------------------------------------------------------------------------
     O TOQUE É UM ARQUIVO, E O BIPE GERADO VIROU A RESERVA

     Até a 0.5.x o som era sintetizado com um oscilador — dois tons curtos, em
     volume de escritório. O cliente ouviu e pediu outro: mandou o toque dele e
     disse que precisa ser ALTO, porque a recepção da clínica é barulhenta e o
     aviso passava despercebido.

     Então o arquivo entra, e o oscilador FICA — como caminho de volta. Ele
     cobre três casos reais em que o MP3 não chega:

       · o hospedeiro tem CSP com `media-src` fechado (o /restrito do BemEstar
         tem CSP; foi o motivo de eu ter evitado arquivo na primeira versão);
       · a rede caiu entre a página carregar e a mensagem chegar;
       · o serviço do chat foi atualizado sem o `aviso.mp3` na pasta.

     Em nenhum desses o aviso pode emudecer sem ninguém saber. O bipe é pior,
     mas é um som — e um som ruim avisa; silêncio, não.

     O arquivo é carregado UMA vez, na liberação do áudio (que já acontece na
     primeira interação com a página), e fica decodificado na memória. Assim a
     mensagem que chega não espera download nenhum para soar.
     ========================================================================== */
  const som = {
    ctx: null,
    liberado: false,
    buffer: null,        // o toque decodificado, pronto para tocar
    baixando: false,
    url: null,           // definida pelo componente: <base>/aviso.mp3

    liberar() {
      /* Chamado na primeira interação com a PÁGINA — que é a interação do
         usuário que o navegador exige. Já foi "primeiro clique dentro do
         chat", e o efeito era perverso: quem nunca abria a gaveta nunca
         liberava o áudio, e é justamente essa pessoa que depende do som para
         saber que chegou mensagem. */
      if (this.liberado) return;
      try {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return;
        this.ctx = new C();
        if (this.ctx.state === "suspended") this.ctx.resume();
        this.liberado = true;
        this.carregar();
      } catch { /* sem áudio: o aviso visual basta */ }
    },

    carregar() {
      if (this.buffer || this.baixando || !this.ctx || !this.url) return;
      this.baixando = true;
      fetch(this.url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
        .then((b) => this.ctx.decodeAudioData(b))
        .then((buf) => { this.buffer = buf; })
        .catch(() => { /* fica no bipe; nada quebra e nada é dito à toa */ })
        .then(() => { this.baixando = false; });
    },

    tocar() {
      if (!this.liberado || !this.ctx) return;
      /* O contexto suspende sozinho em aba de segundo plano em alguns
         navegadores. Sem religar, a mensagem que chega com a aba escondida —
         exatamente quando o som mais importa — não soa. */
      if (this.ctx.state === "suspended") { try { this.ctx.resume(); } catch { } }
      try {
        if (this.buffer) return this.tocarArquivo();
        this.tocarBipe();
        this.carregar();     /* tenta de novo para a próxima mensagem */
      } catch { }
    },

    tocarArquivo() {
      const fonte = this.ctx.createBufferSource();
      const vol = this.ctx.createGain();
      fonte.buffer = this.buffer;
      /* ALTO, como foi pedido — e o ganho passa de 1 de propósito: o arquivo
         do cliente tem pico em 0,43 da escala, então 1,0 sairia em menos da
         metade do que o alto-falante consegue. 2,2 aproxima o pico do teto sem
         estourar (0,43 × 2,2 = 0,94). Acima disso a onda ceifa e o toque
         chia — mais volume que o material permite não existe. */
      vol.gain.value = 2.2;
      fonte.connect(vol); vol.connect(this.ctx.destination);
      fonte.start();
    },

    tocarBipe() {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const vol = this.ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.setValueAtTime(880, t + 0.08);
      /* A reserva também subiu de volume: ela existe justamente para os casos
         em que o toque do cliente não chegou, e um aviso inaudível ali seria
         o mesmo que não avisar. */
      vol.gain.setValueAtTime(0.0001, t);
      vol.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
      vol.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(vol); vol.connect(this.ctx.destination);
      osc.start(t); osc.stop(t + 0.32);
    },
  };

  /* ==========================================================================
     5. O COMPONENTE
     ========================================================================== */
  class LaChat extends HTMLElement {
    static get observedAttributes() { return ["modo", "aberto", "tema"]; }

    constructor() {
      super();
      this.raiz = this.attachShadow({ mode: "open" });

      this.estado = {
        eu: null,
        conversas: [],
        atual: null,          // { id, tipo, titulo, outro }
        mensagens: [],
        cursor: null,
        temMais: false,
        marcas: { lidaAte: 0, entregueAte: 0 },
        pessoas: [],
        aba: "conversas",
        digitando: new Map(), // conversaId -> Map(usuarioId -> {nome, ate})
        pendentes: [],        // anexos enviados e ainda não mandados
        conexao: "iniciando", // iniciando | ligado | reconectando | caido
        carregando: false,
        busca: "",
      };

      this.ws = null;
      this.tentativas = 0;
      this.temporizadores = [];
      this.montado = false;
    }

    /* --------------------------------------------------------------------
       Configuração vem por atributo, com padrões que funcionam no caso comum.
       -------------------------------------------------------------------- */
    get base() { return (this.getAttribute("base") || "/chat").replace(/\/+$/, ""); }
    /* O padrão do passe ACOMPANHA a base. Já foi `/chat/passe` fixo, e o efeito
       de mover o chat para `/restrito/chat` era este: o componente carregava,
       pedia o passe no endereço antigo, tomava 404, nunca criava sessão — e a
       aba "Pessoas" dizia apenas "Ninguém por aqui ainda.", que parece um
       sistema vazio, não uma falha. Quem serve o passe em outro lugar continua
       podendo dizer, com `passe-url`. */
    get urlDoPasse() { return this.getAttribute("passe-url") || this.base + "/passe"; }
    get modo() { return this.getAttribute("modo") || "modal"; }

    /* ====================================================================
       LIGADO MESMO FECHADO — e por que isso teve de mudar

       Antes, o chat só conectava ao ser ABERTO e desconectava ao ser fechado.
       Economizava um socket e custava a função inteira de notificação: com a
       gaveta fechada não chegava mensagem nenhuma, então o selo do botão nunca
       aparecia, o título da aba nunca mudava e o som nunca tocava. Quem estava
       trabalhando na agenda não tinha como saber que alguém falou com ele —
       e é exatamente aí que o aviso serve para alguma coisa.

       Agora conecta ao carregar e permanece conectado; fechar só esconde a
       tela. Um socket por aba aberta do sistema é o custo normal de um chat.

       `manual` preserva o comportamento antigo para quem quiser controlar.
       ==================================================================== */
    connectedCallback() {
      if (!this.hasAttribute("modo")) this.setAttribute("modo", "modal");
      if (!this.montado) { this.montar(); this.montado = true; }
      if (this.modo === "fullpage") this.setAttribute("aberto", "");
      if (this.hasAttribute("aberto") || !this.hasAttribute("manual")) this.iniciar();
    }

    disconnectedCallback() {
      this.desligar();
      for (const t of this.temporizadores) clearInterval(t);
      this.temporizadores = [];
    }

    attributeChangedCallback(nome, antes, agora) {
      if (nome === "aberto" && agora !== null && this.montado) this.iniciar();
      /* Fechar NÃO desliga mais o socket — é o que faz o aviso existir com a
         gaveta fechada. Quem desliga é `disconnectedCallback`, quando o
         elemento sai da página de verdade. */
    }

    abrir() { this.setAttribute("aberto", ""); }
    fechar() { if (this.modo !== "fullpage") this.removeAttribute("aberto"); }

    /* ====================================================================
       ESTRUTURA — escrita por nós, constante, sem conteúdo de usuário.
       É o único innerHTML do arquivo, e ele não recebe nada de fora.
       ==================================================================== */
    montar() {
      /* O toque mora junto com o serviço do chat, e a base já sabe onde ele
         está. Definir aqui — e não no módulo `som` — é o que permite ao
         hospedeiro mover o chat de prefixo (`/chat` → `/restrito/chat`) sem
         que o som fique apontando para o endereço antigo. Foi exatamente esse
         o defeito que o passe teve quando o chat mudou de lugar. */
      som.url = this.base + "/aviso.mp3";

      const estilo = document.createElement("style");
      estilo.textContent = CSS;

      const moldura = criar("div", { classe: "moldura" });
      moldura.addEventListener("click", (e) => { if (e.target === moldura) this.fechar(); });
      moldura.addEventListener("pointerdown", () => som.liberar(), { once: true });

      const painel = criar("div", { classe: "painel", role: "dialog", "aria-label": "Chat corporativo" });
      painel.dataset.vendo = "lista";

      /* --- barra lateral --- */
      const barra = criar("aside", { classe: "barra" });

      const marca = criar("div", { classe: "marca" }, [
        criar("span", { classe: "pt", id: "pt-conexao", title: "conexão" }),
        criar("strong", { texto: this.getAttribute("nome") || "Conversas" }),
      ]);

      const campoBusca = criar("input", {
        type: "search", placeholder: "Buscar pessoas e mensagens…",
        "aria-label": "Buscar pessoas e mensagens",
      });
      /* Debounce de 250 ms (§16): sem ele, cada tecla vira uma consulta ao
         banco, e digitar "orçamento" custa nove buscas. */
      let tBusca = null;
      campoBusca.addEventListener("input", () => {
        clearTimeout(tBusca);
        tBusca = setTimeout(() => this.buscar(campoBusca.value), 250);
      });

      /* Cada aba carrega o PRÓPRIO nome em `data-aba`. A versão anterior
         descobria a aba selecionada comparando os quatro primeiros
         caracteres do texto do botão — o que funcionava com duas abas e por
         acaso: bastava uma terceira começando pelas mesmas letras, ou a
         tradução de um rótulo, para a aba certa deixar de acender. */
      const fazerAba = (chave, rotulo) => {
        const b = criar("button", {
          classe: "aba", role: "tab", texto: rotulo,
          "aria-selected": String(chave === "conversas"),
          onclick: () => this.trocarAba(chave),
        });
        b.dataset.aba = chave;
        return b;
      };

      const abas = criar("div", { classe: "abas", role: "tablist" }, [
        fazerAba("conversas", "Conversas"),
        fazerAba("pessoas", "Pessoas"),
      ]);

      const lista = criar("div", { classe: "lista", role: "list", "aria-label": "Conversas" });

      const rodapeBarra = criar("div", { classe: "barra-baixo" });

      barra.append(criar("div", { classe: "barra-topo" }, [marca, criar("div", { classe: "busca" }, [campoBusca])]),
        abas, lista, rodapeBarra);

      /* --- principal --- */
      const principal = criar("section", { classe: "principal" });
      const cab = criar("header", { classe: "cab" });
      const faixa = criar("div", { classe: "faixa", hidden: "" , role: "status" });
      const corpo = criar("div", { classe: "corpo", role: "log", "aria-label": "Mensagens", tabindex: "0" });
      const digitando = criar("div", { classe: "digitando", "aria-live": "polite" });
      const redator = criar("div", { classe: "redator", hidden: "" });

      /* Rolagem para carregar histórico antigo (§26). O limiar é 120 px do
         topo: esperar chegar a 0 faz a pessoa bater no fim e a carga parecer
         travamento. */
      corpo.addEventListener("scroll", () => {
        if (corpo.scrollTop < 120 && this.estado.temMais && !this.estado.carregando) this.carregarMais();
      });

      principal.append(cab, faixa, corpo, digitando, redator);
      painel.append(barra, principal);
      moldura.append(painel);

      /* Aviso para leitor de tela (§29): mensagem nova é anunciada aqui, e não
         pela lista inteira — `aria-live` numa lista que muda toda hora faria o
         leitor reler tudo a cada mensagem. */
      const avisoSr = criar("div", { classe: "sr", "aria-live": "polite", "aria-atomic": "true" });

      this.raiz.append(estilo, moldura, avisoSr);

      this.el = { moldura, painel, barra, lista, cab, faixa, corpo, digitando, redator,
                  rodapeBarra, campoBusca, abas, avisoSr, pontoConexao: marca.querySelector("#pt-conexao") };

      this.montarRedator();

      /* ESC em HIERARQUIA: fecha primeiro o que está por cima.
         Conversa aberta → fecha a conversa. Nenhuma aberta → fecha o painel.
         No fullpage o painel não fecha (não há o que fechar, e fechar seria
         esvaziar a tela do hospedeiro) — mas a conversa continua fechando. */
      this.raiz.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (this.estado.atual) { e.stopPropagation(); return this.fecharConversa(); }
        if (this.modo !== "fullpage") { e.stopPropagation(); this.fechar(); }
      });

      /* Expira o "está digitando" que ficou preso — quem fecha a aba no meio
         de uma frase não manda o aviso de parada. */
      this.temporizadores.push(setInterval(() => this.pintarDigitando(), 1500));
    }

    montarRedator() {
      const pendentes = criar("div", { classe: "pendentes" });

      const area = criar("textarea", {
        rows: "1", placeholder: "Escreva uma mensagem…", "aria-label": "Escreva uma mensagem",
        maxlength: "4000",
      });

      /* Enter envia; Shift+Enter quebra linha. É a convenção que a pessoa já
         tem no dedo — inverter isso é a reclamação número um de chat novo. */
      area.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.enviar(); }
      });
      area.addEventListener("input", () => {
        area.style.height = "auto";
        area.style.height = Math.min(160, area.scrollHeight) + "px";
        botao.disabled = !area.value.trim() && !this.estado.pendentes.length;
        this.avisarDigitando();
      });

      const arquivo = criar("input", { type: "file", hidden: "", multiple: "" });
      arquivo.addEventListener("change", () => { this.anexar(arquivo.files); arquivo.value = ""; });

      const botao = criar("button", { classe: "enviar", texto: "➤", "aria-label": "Enviar mensagem", disabled: "" });
      botao.addEventListener("click", () => this.enviar());

      const caixa = criar("div", { classe: "caixa" }, [
        criar("button", { classe: "icone", texto: "📎", "aria-label": "Anexar arquivo",
          onclick: () => arquivo.click() }),
        area, botao,
      ]);

      this.el.redator.append(pendentes, caixa, arquivo);
      this.el.area = area;
      this.el.botaoEnviar = botao;
      this.el.pendentes = pendentes;
    }

    /* ====================================================================
       6. REDE
       ==================================================================== */

    /* O token CSRF é lido do cookie que o servidor plantou. Ele NÃO é
       HttpOnly de propósito — ver seguranca/sessao.js. */
    /* ====================================================================
       O NOME DO COOKIE DEPENDE DE QUEM É

       Funcionário tem `cid` e `cid_csrf`. Convidado de sala tem `cvd` e
       `cvd_csrf` — uma sessão separada, de propósito (ver
       seguranca/convidado.js).

       O padrão era sempre `cid`. No modo sala isso fazia `csrf()` devolver
       string VAZIA, porque o cookie procurado não existe para um convidado.
       O `POST /bilhete` era recusado por CSRF, o convidado NUNCA abria o
       WebSocket — e sem socket não há troca de sinais WebRTC.

       O sintoma era o pior possível de diagnosticar: a reunião abre, as
       pessoas aparecem com nome na tela, e todos os retratos ficam
       eternamente em "conectando…". Parece problema de rede, de TURN, de
       firewall — e a chamada interna funciona, porque ali o cookie é `cid`.
       "O chat funciona, só o link não."

       A suíte não pegou porque o cliente de teste monta o cabeçalho CSRF
       sozinho, lendo o cookie certo. Ela provava o SERVIDOR e emulava um
       cliente correto — exatamente o que o cliente de verdade não era.
       ==================================================================== */
    get nomeDoCookie() {
      return this.getAttribute("cookie") || (this.modo === "sala" ? "cvd" : "cid");
    }

    csrf() {
      const m = new RegExp("(?:^|;\\s*)" + this.nomeDoCookie + "_csrf=([^;]*)")
        .exec(document.cookie);
      return m ? decodeURIComponent(m[1]) : "";
    }

    async api(caminho, opcoes = {}) {
      const r = await fetch(this.base + caminho, {
        method: opcoes.metodo || "GET",
        /* `include` é obrigatório para o cookie viajar quando o chat está em
           subdomínio próprio. Sem isto, o arranjo B simplesmente não autentica. */
        credentials: "include",
        headers: {
          ...(opcoes.corpo ? { "Content-Type": "application/json" } : {}),
          ...(["GET", "HEAD"].includes(opcoes.metodo || "GET") ? {} : { "X-Chat-Csrf": this.csrf() }),
          /* COM QUAL IDENTIDADE ESTE PEDIDO FALA.

             Os dois cookies convivem no mesmo navegador, e é o caso normal:
             um funcionário logado recebe um link de reunião e o abre ali
             mesmo. Sem esta linha, o servidor escolhe a sessão de
             funcionário, confere o CSRF do CONVIDADO contra ela, e recusa
             tudo com 403 — o convidado nunca tira bilhete, nunca abre o
             socket, e a reunião fica eternamente em "conectando…". */
          ...(this.modo === "sala" ? { "X-Chat-Como": "convidado" } : {}),
          ...(opcoes.cabecalhos || {}),
        },
        body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : opcoes.bruto,
      });

      let dados = null;
      try { dados = await r.json(); } catch { }

      if (!r.ok) {
        const e = new Error(dados?.erro || "Não foi possível concluir.");
        e.status = r.status;
        e.codigo = dados?.codigo;
        throw e;
      }
      return dados;
    }

    /* ====================================================================
       7. CICLO DE VIDA
       ==================================================================== */
    async iniciar() {
      if (this.iniciando) return;

      /* ================================================================
         MODO SALA — a reunião por link.

         Aqui NÃO há passe a pedir nem `/eu` a consultar: a identidade do
         convidado nasceu no `POST /call/<codigo>/entrar` e a página é quem
         a entrega, por `entrarNaSala()`. Sem esta saída, abrir a sala
         dispararia uma busca de passe que o hospedeiro não serve, e o
         convidado veria "O site não confirmou quem é você." — uma frase
         verdadeira para o funcionário e sem sentido nenhum para ele.
         ================================================================ */
      if (this.modo === "sala") return;

      /* Já conectado: abrir a gaveta não refaz sessão nem socket. Só atualiza
         o que envelhece enquanto ela está fechada. Sem esta saída, cada
         abertura emitia um passe novo e derrubava a conexão viva. */
      if (this.estado.eu) {
        this.carregarConversas();
        if (this.estado.aba === "pessoas") this.carregarPessoas();
        this.ligar();
        return;
      }

      this.iniciando = true;
      this.mostrarFaixa("Conectando…");

      try {
        /* 1. o passe vem do HOSPEDEIRO, que sabe quem está logado. */
        const rp = await fetch(this.urlDoPasse, { credentials: "include" });
        if (!rp.ok) throw new Error("O site não confirmou quem é você.");
        const { passe } = await rp.json();
        if (!passe) throw new Error("O site não confirmou quem é você.");

        /* 2. o passe vira sessão do chat. */
        await this.api("/entrar", { metodo: "POST", corpo: { passe } });

        /* 3. quem sou eu + conversas */
        const eu = await this.api("/eu");
        this.estado.eu = eu.usuario;
        this.estado.preferencias = eu.preferencias;
        this.estado.limites = eu.limites;
        this.estado.statusManual = eu.statusManual || "online";

        await this.carregarConversas();
        this.pintarRodapeBarra();

        /* O estado inicial é "nenhuma conversa selecionada" (§4). Sem estas
           duas linhas a área principal abria em branco, o que parece defeito. */
        if (!this.estado.atual) { this.pintarCabecalho(); this.pintarVazio(); }

        this.esconderFaixa();
        this.ligarRelogioDoElenco();
        this.ligar();
      } catch (e) {
        this.mostrarFaixa(e.message || "Não foi possível abrir o chat.", true);
      } finally {
        this.iniciando = false;
      }
    }

    /* ====================================================================
       8. WEBSOCKET — com bilhete, reconexão e retomada
       ==================================================================== */
    async ligar() {
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

      let bilhete;
      try {
        ({ bilhete } = await this.api("/bilhete", { metodo: "POST" }));
      } catch {
        return this.reagendarLigacao();
      }

      /* O endereço do socket é derivado do da API — http vira ws, https vira
         wss. Derivar em vez de configurar evita a instalação em que a API está
         em https e o socket ficou em ws:// (que o navegador recusa em página
         segura, com um erro que não diz isso). */
      const url = new URL(this.base + "/ws", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("t", bilhete);

      let ws;
      try { ws = new WebSocket(url.toString()); } catch { return this.reagendarLigacao(); }
      this.ws = ws;

      ws.onopen = () => {
        this.tentativas = 0;
        this.estado.conexao = "ligado";
        this.pintarConexao();
        this.esconderFaixa();
        /* RETOMADA: pergunta o que se perdeu enquanto esteve fora. É o que
           faz o §25 funcionar sem duplicar nem perder. */
        if (this.estado.atual) this.sincronizar();
      };

      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        this.receber(m);
      };

      ws.onclose = () => {
        if (this.ws === ws) { this.ws = null; this.reagendarLigacao(); }
      };

      /* `onerror` não recebe motivo por decisão do padrão (evitar vazar
         informação de rede para a página). Não há o que registrar aqui além
         do que o `onclose` já trata. */
      ws.onerror = () => { };
    }

    /* RECUO EXPONENCIAL COM RUÍDO.

       O ruído não é enfeite: sem ele, um restart do servidor faz TODAS as abas
       de TODA a empresa reconectarem no mesmo milissegundo, repetidamente. O
       servidor mal sobe e leva uma rajada — e cai de novo. O ruído espalha as
       tentativas no tempo. */
    reagendarLigacao() {
      this.estado.conexao = this.tentativas > 2 ? "caido" : "reconectando";
      this.pintarConexao();
      if (this.tentativas === 1) this.mostrarFaixa("Reconectando…");

      const base = Math.min(30_000, 1000 * 2 ** Math.min(this.tentativas, 5));
      const espera = base * (0.7 + Math.random() * 0.6);
      this.tentativas++;
      clearTimeout(this.tReconexao);
      this.tReconexao = setTimeout(() => { if (this.hasAttribute("aberto")) this.ligar(); }, espera);
    }

    desligar() {
      clearTimeout(this.tReconexao);
      if (this.ws) { try { this.ws.close(1000, "saindo"); } catch { } this.ws = null; }
    }

    enviarPeloSocket(obj) {
      if (this.ws?.readyState === 1) { try { this.ws.send(JSON.stringify(obj)); return true; } catch { } }
      return false;
    }

    /* ====================================================================
       9. EVENTOS QUE CHEGAM
       ==================================================================== */
    receber(m) {
      switch (m.t) {
        case "pronto": break;

        case "msg": {
          const daAtual = this.estado.atual && m.c === this.estado.atual.id;
          if (daAtual) {
            this.acrescentarMensagem(m.m);
            /* Só marca como lida se a pessoa está de fato vendo. Marcar com a
               aba em segundo plano faria a mensagem "nascer lida" sem
               ninguém ter lido. */
            if (!document.hidden && this.hasAttribute("aberto")) this.marcarLida(m.m.seq);
          }
          this.avisarChegada(m);
          this.carregarConversas();
          break;
        }

        case "apagada":
          if (this.estado.atual && m.c === this.estado.atual.id) {
            const alvo = this.estado.mensagens.find((x) => x.id === m.id);
            if (alvo) { alvo.apagada = true; alvo.corpo = ""; this.pintarMensagens(); }
          }
          break;

        case "editada":
          if (this.estado.atual && m.c === this.estado.atual.id) {
            const i = this.estado.mensagens.findIndex((x) => x.id === m.m.id);
            if (i >= 0) { this.estado.mensagens[i] = m.m; this.pintarMensagens(); }
          }
          break;

        case "lida":
          if (this.estado.atual && m.c === this.estado.atual.id) {
            this.estado.marcas.lidaAte = Math.max(this.estado.marcas.lidaAte, m.seq);
            this.pintarMensagens();
          }
          break;

        case "digit": {
          if (!this.estado.digitando.has(m.c)) this.estado.digitando.set(m.c, new Map());
          this.estado.digitando.get(m.c).set(m.u, { nome: m.n, ate: Date.now() + 6000 });
          this.pintarDigitando();
          break;
        }

        case "status":
          for (const c of this.estado.conversas) {
            if (c.outro?.id === m.u) c.outro.status = m.s;
            for (const p of c.membros || []) if (p.id === m.u) p.status = m.s;
          }
          for (const p of this.estado.pessoas) if (p.id === m.u) p.status = m.s;
          this.pintarLista();
          if (this.estado.atual?.outro?.id === m.u) {
            this.estado.atual.outro.status = m.s;
            this.pintarCabecalho();
          }
          break;

        case "conversa":
          this.carregarConversas();
          break;

        /* A conversa saiu para todo mundo. Some da tela AGORA — continuar
           escrevendo numa conversa que já não existe é perder o que se
           escreveu, sem aviso nenhum. */
        case "conversa.removida":
          this.conversaRemovida(m);
          break;

        /* Alguém entrou, saiu ou mudou de cargo no sistema do hospedeiro. */
        case "elenco":
          this.carregarPessoas();
          break;

        case "sinc": {
          if (m.recarregar) { if (this.estado.atual) this.abrirConversa(this.estado.atual); break; }
          for (const nova of m.mensagens || []) this.acrescentarMensagem(nova, true);
          if (m.marcas) this.estado.marcas = m.marcas;
          this.pintarMensagens();
          break;
        }

        case "erro":
          this.mostrarFaixa(m.m || "Algo não funcionou.", true);
          setTimeout(() => this.esconderFaixa(), 4000);
          break;
      }
    }

    /* A conversa foi removida por um administrador. Some da tela na hora —
       continuar escrevendo numa conversa que já não existe seria perder o
       que se escreveu, sem aviso. */
    conversaRemovida(m) {
      this.tirarConversaDaTela(m.c);
    }

    sincronizar() {
      const ultima = this.estado.mensagens.length
        ? this.estado.mensagens[this.estado.mensagens.length - 1].seq : 0;
      this.enviarPeloSocket({ t: "sinc", c: this.estado.atual.id, desde: ultima });
    }

    /* ====================================================================
       ACRESCENTAR UMA MENSAGEM QUE CHEGOU

       Este método FALTAVA. Ele era chamado em dois lugares — na chegada de
       mensagem e na retomada — e não existia, então `receber()` estourava com
       `this.acrescentarMensagem is not a function` dentro do `onmessage` do
       socket.

       O sintoma foi exatamente o que se viu: a mensagem só aparecia ao fechar
       e reabrir a conversa, porque aí ela vinha pelo caminho do HISTÓRICO
       (HTTP), que funcionava. O tempo real estava morto e não havia erro
       visível na tela — o `onmessage` engolia a exceção.

       ---------------------------------------------------------------------
       AS TRÊS COISAS QUE ELE PRECISA FAZER

       1. NÃO DUPLICAR. A mesma mensagem pode chegar duas vezes por caminhos
          diferentes: pelo evento e, logo depois, por uma retomada. Casar por
          `id` resolve o caso normal; casar também por `idCliente` resolve o
          caso em que a mensagem OTIMISTA (que ainda tem id temporário) já
          está na tela e a versão confirmada chega pelo socket.

       2. INSERIR NA POSIÇÃO CERTA, e não no fim. Numa retomada as mensagens
          chegam em ordem, mas uma mensagem nova pode chegar ENQUANTO a
          retomada acontece — e aí colocar no fim deixaria a conversa fora de
          ordem. A ordem é a de `seq`, que é o que o servidor garante.

       3. NÃO ROUBAR A ROLAGEM de quem está lendo o histórico. Se a pessoa
          rolou para cima, uma mensagem nova não pode puxá-la para baixo.
          `pintarMensagens` já respeita isso: só desce sozinho se já estava
          no fim.
       ==================================================================== */
    acrescentarMensagem(mensagem, emLote = false) {
      if (!mensagem) return false;

      const lista = this.estado.mensagens;

      const jaTem = lista.findIndex((x) =>
        (mensagem.id && x.id === mensagem.id) ||
        (mensagem.idCliente && x.idCliente && x.idCliente === mensagem.idCliente));

      if (jaTem >= 0) {
        /* Já está na tela. Ainda assim SUBSTITUI: a versão que chegou agora
           pode ser a confirmada (com id e seq de verdade) por cima de uma
           otimista, ou uma edição. Ignorar deixaria a bolha presa em
           "enviando" para sempre. */
        lista[jaTem] = { ...lista[jaTem], ...mensagem, estado: "enviada" };
        if (!emLote) this.pintarMensagens();
        return false;
      }

      /* Posição por `seq`. O caminho comum — mensagem mais nova que todas —
         cai no `push` sem percorrer nada. */
      const ultima = lista[lista.length - 1];
      if (!ultima || mensagem.seq >= ultima.seq) {
        lista.push(mensagem);
      } else {
        const i = lista.findIndex((x) => x.seq > mensagem.seq);
        lista.splice(i < 0 ? lista.length : i, 0, mensagem);
      }

      if (!emLote) this.pintarMensagens();
      return true;
    }

    /* ====================================================================
       FECHAR A CONVERSA — sem fechar o chat

       São duas ações diferentes, e antes só havia uma. O "‹" existia, mas o
       CSS o escondia acima de 720 px: no computador não havia como voltar
       para a lista sem fechar o chat inteiro e abrir de novo.

       O ESC agora obedece a uma hierarquia, que é o que a pessoa espera de
       qualquer aplicação: primeiro fecha o que está POR CIMA (a conversa),
       depois o que está por baixo (o painel).
       ==================================================================== */
    fecharConversa() {
      this.estado.atual = null;
      this.estado.mensagens = [];
      this.estado.cursor = null;
      this.estado.temMais = false;
      this.ultimaLidaEnviada = 0;
      this.el.painel.dataset.vendo = "lista";
      this.el.redator.hidden = true;
      this.el.digitando.textContent = "";
      this.pintarCabecalho();
      this.pintarVazio();
      this.pintarLista();
      /* O foco volta para a lista — quem fechou com o teclado não pode ficar
         com o foco num botão que deixou de existir. */
      this.el.lista.querySelector(".item")?.focus();
    }

    /* O estado "nenhuma conversa selecionada" do §4. Antes a área principal
       ficava simplesmente em branco, o que parece defeito. */
    pintarVazio() {
      limpar(this.el.corpo);
      this.el.corpo.appendChild(criar("div", { classe: "vazio" }, [
        criar("div", { classe: "grande", texto: "💬" }),
        criar("div", { texto: "Selecione uma conversa" }),
        criar("div", { classe: "dica", texto: "ou vá em Pessoas para começar uma nova" }),
      ]));
    }

    /* ====================================================================
       10. DADOS
       ==================================================================== */
    async carregarConversas() {
      try {
        const { conversas } = await this.api("/conversas");

        /* ================================================================
           A CONVERSA QUE ESTÁ ABERTA E VISÍVEL NÃO TEM NÃO LIDAS.

           A confirmação de leitura sai pelo socket, sem resposta; a lista vem
           por HTTP. As duas correm juntas, e a lista costuma chegar primeiro.
           Sem esta correção, a barra lateral mostra "1" ao lado de uma
           mensagem que a pessoa está lendo naquele instante — e o número só
           some no carregamento seguinte.

           Não é maquiagem: se o chat está aberto, na frente, e a conversa é a
           que está na tela, a mensagem FOI vista. O servidor chega à mesma
           conclusão um instante depois.
           ================================================================ */
        if (this.estado.atual && !document.hidden && this.hasAttribute("aberto")) {
          const aberta = conversas.find((c) => c.id === this.estado.atual.id);
          if (aberta) aberta.naoLidas = 0;
        }

        this.estado.conversas = conversas;
        if (this.estado.aba === "conversas") this.pintarLista();
        this.emitirNaoLidas();
      } catch { /* a barra continua com o que tinha: melhor que esvaziar */ }
    }

    async trocarAba(aba) {
      this.estado.aba = aba;
      for (const b of this.el.abas.children)
        b.setAttribute("aria-selected", String(b.dataset.aba === aba));
      this.pintarLista();
      /* SEMPRE recarrega ao entrar na aba — não só quando a lista está vazia.
         Com a condição antiga, quem abrisse "Pessoas" uma vez ficava com aquele
         retrato até recarregar a página: funcionário admitido depois não
         aparecia, e demitido continuava lá. */
      if (aba === "pessoas") await this.carregarPessoas();
    }

    /* ====================================================================
       O ELENCO — recarregado por três caminhos, de propósito

         · ao entrar na aba "Pessoas" (o momento em que alguém vai olhar);
         · pelo evento `elenco` do socket, quando o hospedeiro sincroniza;
         · por relógio, enquanto a aba estiver aberta e a janela visível.

       O relógio é a rede de segurança: se o socket cair e reconectar no meio
       de uma mudança, o evento se perde e nada mais avisaria. `document.hidden`
       no meio evita bater no servidor com a aba em segundo plano.
       ==================================================================== */
    async carregarPessoas() {
      try {
        const { pessoas } = await this.api("/pessoas");
        this.estado.pessoas = pessoas;
        if (this.estado.aba === "pessoas") this.pintarLista();
      } catch { /* fica com o que tinha: melhor um retrato velho que uma lista vazia */ }
    }

    ligarRelogioDoElenco() {
      if (this.relogioElenco) return;
      this.relogioElenco = setInterval(() => {
        if (this.estado.aba !== "pessoas" || document.hidden) return;
        if (!this.hasAttribute("aberto")) return;
        this.carregarPessoas();
      }, 30_000);
      this.temporizadores.push(this.relogioElenco);
    }

    async buscar(termo) {
      this.estado.busca = String(termo || "").trim();
      if (this.estado.busca.length < 2) { this.estado.resultado = null; return this.pintarLista(); }
      try {
        this.estado.resultado = await this.api("/busca?q=" + encodeURIComponent(this.estado.busca));
        this.pintarLista();
      } catch (e) {
        this.mostrarFaixa(e.message, true);
      }
    }

    async abrirConversa(conversa) {
      this.estado.atual = conversa;
      this.estado.mensagens = [];
      this.estado.carregando = true;
      this.el.painel.dataset.vendo = "conversa";
      this.el.redator.hidden = false;
      this.pintarCabecalho();
      limpar(this.el.corpo);
      this.el.corpo.appendChild(criar("div", { classe: "carregando", texto: "Carregando…" }));

      try {
        const r = await this.api(`/conversas/${conversa.id}/mensagens`);
        this.estado.mensagens = r.mensagens;
        this.estado.temMais = r.temMais;
        this.estado.cursor = r.proximoCursor;
        this.estado.marcas = r.marcas;
        this.pintarMensagens(true);
        const ultima = r.mensagens[r.mensagens.length - 1];
        if (ultima) this.marcarLida(ultima.seq);
      } catch (e) {
        limpar(this.el.corpo);
        this.el.corpo.appendChild(criar("div", { classe: "vazio" }, [
          criar("div", { classe: "grande", texto: "⚠" }),
          criar("div", { texto: e.message }),
        ]));
      } finally {
        this.estado.carregando = false;
      }
    }

    async carregarMais() {
      if (!this.estado.cursor || this.estado.carregando) return;
      this.estado.carregando = true;
      const alturaAntes = this.el.corpo.scrollHeight;
      try {
        const r = await this.api(
          `/conversas/${this.estado.atual.id}/mensagens?antes=${this.estado.cursor}`);
        this.estado.mensagens = [...r.mensagens, ...this.estado.mensagens];
        this.estado.temMais = r.temMais;
        this.estado.cursor = r.proximoCursor;
        this.pintarMensagens();
        /* Mantém a posição de leitura: sem isso, carregar 50 mensagens acima
           joga a pessoa para outro ponto da conversa e ela perde o lugar. */
        this.el.corpo.scrollTop = this.el.corpo.scrollHeight - alturaAntes;
      } catch { } finally { this.estado.carregando = false; }
    }

    async abrirComPessoa(usuarioId) {
      try {
        const c = await this.api("/conversas/direta", { metodo: "POST", corpo: { usuarioId } });
        await this.carregarConversas();
        const achada = this.estado.conversas.find((x) => x.id === c.id);
        this.abrirConversa(achada || { id: c.id, tipo: "direta", outro: c.outro, membros: [] });
        this.estado.aba = "conversas";
        this.el.campoBusca.value = "";
        this.estado.resultado = null;
        this.trocarAba("conversas");
      } catch (e) { this.mostrarFaixa(e.message, true); }
    }

    /* ====================================================================
       11. ENVIAR — com estado otimista (§13, §52)
       ==================================================================== */
    async enviar() {
      const texto = this.el.area.value.trim();
      const anexos = this.estado.pendentes.slice();
      if (!texto && !anexos.length) return;
      if (!this.estado.atual) return;

      const idCliente = idLocal();

      /* A mensagem aparece IMEDIATAMENTE, marcada como "enviando". É o que faz
         o chat parecer instantâneo mesmo numa rede ruim. Se falhar, ela vira
         "erro" com opção de tentar de novo — nunca some sem explicação, que é
         o pior desfecho possível para quem escreveu. */
      const otimista = {
        id: "tmp-" + idCliente,
        idCliente,
        conversaId: this.estado.atual.id,
        autorId: this.estado.eu.id,
        seq: Number.MAX_SAFE_INTEGER,
        tipo: anexos.length ? "arquivo" : "texto",
        corpo: texto,
        criadaEm: Date.now(),
        anexos: anexos.map((a) => ({ id: a.id, nome: a.nome, tamanho: a.tamanho, tipo: a.tipo })),
        estado: "enviando",
      };
      this.estado.mensagens.push(otimista);
      this.el.area.value = "";
      this.el.area.style.height = "auto";
      this.estado.pendentes = [];
      this.pintarPendentes();
      this.el.botaoEnviar.disabled = true;
      this.pintarMensagens(true);

      try {
        const r = await this.api(`/conversas/${this.estado.atual.id}/mensagens`, {
          metodo: "POST",
          corpo: { texto, idCliente, anexos: anexos.map((a) => ({ id: a.id, ehImagem: a.ehImagem })) },
        });
        const i = this.estado.mensagens.findIndex((m) => m.idCliente === idCliente);
        if (i >= 0) this.estado.mensagens[i] = { ...r.mensagem, estado: "enviada" };
        this.pintarMensagens(true);
        this.carregarConversas();
      } catch (e) {
        const alvo = this.estado.mensagens.find((m) => m.idCliente === idCliente);
        if (alvo) { alvo.estado = "erro"; alvo.erro = e.message; }
        this.pintarMensagens();
      }
    }

    /* "Está digitando" com throttle de 3 s (§53). O cliente honesto manda um
       aviso a cada 3 segundos enquanto escreve; sem throttle, seria um por
       tecla — e num grupo de 30 pessoas isso é uma tempestade de eventos. */
    avisarDigitando() {
      if (!this.estado.atual) return;
      const agora = Date.now();
      if (this.ultimoDigitando && agora - this.ultimoDigitando < 3000) return;
      this.ultimoDigitando = agora;
      this.enviarPeloSocket({ t: "digit", c: this.estado.atual.id });
    }

    marcarLida(seq) {
      if (!this.estado.atual || !seq) return;
      if (this.ultimaLidaEnviada >= seq) return;
      this.ultimaLidaEnviada = seq;
      if (!this.enviarPeloSocket({ t: "lida", c: this.estado.atual.id, seq })) {
        /* Socket caído: vai por HTTP. Confirmação de leitura perdida faz a
           conversa reaparecer como não lida no próximo carregamento. */
        this.api(`/conversas/${this.estado.atual.id}/lida`, { metodo: "POST", corpo: { seq } })
          .catch(() => { });
      }
      const c = this.estado.conversas.find((x) => x.id === this.estado.atual.id);
      if (c) { c.naoLidas = 0; this.pintarLista(); this.emitirNaoLidas(); }
    }

    /* ====================================================================
       12. ANEXOS
       ==================================================================== */
    async anexar(arquivos) {
      if (!this.estado.atual) return;
      for (const f of arquivos) {
        const teto = this.estado.limites?.tamanhoArquivo || 10 * 1024 * 1024;
        if (f.size > teto) {
          this.mostrarFaixa(`"${f.name}" passa de ${tamanhoLegivel(teto)}.`, true);
          continue;
        }
        const marca = { id: null, nome: f.name, tamanho: f.size, tipo: f.type, enviando: true };
        this.estado.pendentes.push(marca);
        this.pintarPendentes();

        try {
          const r = await this.api(`/arquivos?conversa=${this.estado.atual.id}`, {
            metodo: "POST",
            bruto: f,
            cabecalhos: {
              "Content-Type": f.type || "application/octet-stream",
              /* O nome vai em base64: cabeçalho HTTP não aceita acento nem
                 quebra de linha, e um nome com `\r\n` permitiria injetar
                 cabeçalhos. */
              "X-Arquivo-Nome": btoa(unescape(encodeURIComponent(f.name))),
            },
          });
          Object.assign(marca, r, { enviando: false });
        } catch (e) {
          this.estado.pendentes = this.estado.pendentes.filter((p) => p !== marca);
          this.mostrarFaixa(e.message, true);
        }
        this.pintarPendentes();
      }
      this.el.botaoEnviar.disabled = !this.el.area.value.trim() && !this.estado.pendentes.length;
    }

    /* ====================================================================
       13. NOTIFICAÇÕES (§14)
       ==================================================================== */
    avisarChegada(m) {
      const conversa = this.estado.conversas.find((c) => c.id === m.c);
      if (conversa?.silenciada) return;

      /* Nada de aviso para o que a pessoa está olhando agora. */
      const vendoAgora = this.estado.atual?.id === m.c && !document.hidden && this.hasAttribute("aberto");
      if (vendoAgora) return;

      if (this.estado.preferencias?.som !== false) som.tocar();
      this.el.avisoSr.textContent = "Nova mensagem";

      if (this.estado.preferencias?.notificacoes === false) return;
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      if (!document.hidden) return;   // aba visível: o aviso na tela basta

      try {
        const texto = String(m.m?.corpo || "").slice(0, 120) || "Enviou um arquivo";
        const n = new Notification(conversa?.outro?.nome || conversa?.titulo || "Nova mensagem", {
          body: texto,
          /* `tag` por conversa: mensagens seguidas SUBSTITUEM o aviso em vez
             de empilhar dez notificações da mesma pessoa. */
          tag: "la-chat-" + m.c,
          silent: true,   // o som é nosso, e respeita a preferência
        });
        n.onclick = () => { window.focus(); this.abrir(); n.close(); };
      } catch { }
    }

    /* O hospedeiro (ou o atalho de instalação) chama isto na primeira
       interação com a PÁGINA. Ver a nota em `som`: só clicar dentro do chat
       não bastava — quem nunca abriu a gaveta ficava sem aviso sonoro. */
    liberarSom() { som.liberar(); }

    async pedirPermissaoDeAviso() {
      if (!("Notification" in window) || Notification.permission !== "default") return;
      try { await Notification.requestPermission(); } catch { }
    }

    /* Deixa o hospedeiro saber quantas não lidas existem, para pintar o
       próprio botão de chat. É o único acoplamento de saída do componente, e
       é um evento — o site escuta se quiser. */
    emitirNaoLidas() {
      const total = this.estado.conversas.reduce((a, c) => a + (c.naoLidas || 0), 0);
      this.dispatchEvent(new CustomEvent("la-chat-nao-lidas", {
        detail: { total }, bubbles: true, composed: true,
      }));
    }

    /* ====================================================================
       14. PINTURA
       ==================================================================== */
    pintarConexao() {
      const p = this.el.pontoConexao;
      p.classList.toggle("ok", this.estado.conexao === "ligado");
      p.title = { ligado: "conectado", reconectando: "reconectando…", caido: "sem conexão" }[this.estado.conexao] || "";
    }

    mostrarFaixa(texto, ruim = false) {
      this.el.faixa.textContent = texto;
      this.el.faixa.classList.toggle("ruim", ruim);
      this.el.faixa.hidden = false;
    }
    esconderFaixa() { this.el.faixa.hidden = true; }

    avatar(pessoa, status) {
      const av = criar("div", { classe: "av" });
      if (pessoa?.avatar) {
        const img = criar("img", { src: pessoa.avatar, alt: "" });
        /* Foto que não carrega vira iniciais em vez de ícone quebrado. */
        img.addEventListener("error", () => {
          img.replaceWith(criar("div", { classe: "ini", texto: iniciais(pessoa.nome) }));
        });
        av.appendChild(img);
      } else {
        av.appendChild(criar("div", { classe: "ini", texto: iniciais(pessoa?.nome) }));
      }
      if (status) av.appendChild(criar("span", { classe: "st " + status, "aria-label": status }));
      return av;
    }

    pintarLista() {
      const lista = this.el.lista;
      limpar(lista);

      /* Resultado de busca tem precedência sobre a aba. */
      if (this.estado.resultado) return this.pintarBusca(lista);

      if (this.estado.aba === "pessoas") {
        for (const p of this.estado.pessoas) lista.appendChild(this.linhaPessoa(p));
        if (!this.estado.pessoas.length)
          lista.appendChild(criar("div", { classe: "carregando", texto: "Ninguém por aqui ainda." }));
        return;
      }

      if (!this.estado.conversas.length) {
        lista.appendChild(criar("div", { classe: "carregando",
          texto: "Nenhuma conversa. Vá em Pessoas para começar." }));
        return;
      }

      /* ==================================================================
         AS ARQUIVADAS FICAM ESCONDIDAS, MAS ALCANÇÁVEIS

         Escondê-las de vez tornaria "desarquivar" impossível de achar: a
         pessoa precisaria da conversa na lista para abrir o menu que a
         traria de volta à lista.

         Então elas somem da lista principal e ficam atrás de uma linha no
         fim, que diz quantas são.
         ================================================================== */
      const ativas = this.estado.conversas.filter((c) => !c.arquivada);
      const arquivadas = this.estado.conversas.filter((c) => c.arquivada);

      for (const c of ativas) lista.appendChild(this.linhaConversa(c));

      if (!ativas.length && arquivadas.length)
        lista.appendChild(criar("div", { classe: "carregando",
          texto: "Tudo arquivado por aqui." }));

      if (arquivadas.length) {
        lista.appendChild(criar("button", {
          classe: "arquivadas", type: "button",
          "aria-expanded": String(!!this.estado.verArquivadas),
          texto: (this.estado.verArquivadas ? "▾ " : "▸ ")
            + "Arquivadas (" + arquivadas.length + ")",
          onclick: () => { this.estado.verArquivadas = !this.estado.verArquivadas; this.pintarLista(); },
        }));
        if (this.estado.verArquivadas)
          for (const c of arquivadas) lista.appendChild(this.linhaConversa(c));
      }
    }

    linhaConversa(c) {
      const nome = c.tipo === "grupo" ? (c.titulo || "Grupo") : (c.outro?.nome || "Conversa");
      const naoLidas = c.naoLidas || 0;

      const item = criar("button", {
        classe: "item" + (naoLidas ? " nao-lida" : ""),
        role: "listitem",
        "aria-current": String(this.estado.atual?.id === c.id),
        "aria-label": `${nome}${naoLidas ? `, ${naoLidas} não lidas` : ""}`,
        onclick: () => this.abrirConversa(c),
      });

      item.appendChild(this.avatar(
        c.tipo === "grupo" ? { nome } : c.outro,
        c.tipo === "grupo" ? null : (c.outro?.status || "offline")));

      const previa = this.textoDaPrevia(c);
      const txt = criar("div", { classe: "txt" }, [
        criar("div", { classe: "nome" }, [
          criar("b", { texto: nome }),
          criar("span", { classe: "hora", texto: horaCurta(c.ultimaMensagemEm) }),
        ]),
        criar("div", { classe: "previa", texto: previa || "Sem mensagens ainda" }),
      ]);
      item.appendChild(txt);

      if (naoLidas)
        item.appendChild(criar("span", {
          classe: "selo" + (c.silenciada ? " mudo" : ""),
          texto: naoLidas > 99 ? "99+" : String(naoLidas),
        }));

      /* ================================================================
         OS TRÊS PONTINHOS

         Irmão do item, nunca filho: botão dentro de botão é HTML inválido, e
         o navegador resolve isso tirando o de dentro do alcance do teclado.
         ================================================================ */
      const tres = criar("button", {
        classe: "tres", type: "button", texto: "⋮",
        "aria-label": "Opções de " + nome,
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        onclick: (e) => { e.stopPropagation(); this.abrirMenuDaConversa(c, e.currentTarget); },
      });

      const linha = criar("div", {
        classe: "linha" + (c.arquivada ? " arquivada" : ""),
      }, [item, tres]);
      linha.dataset.conversa = c.id;
      return linha;
    }

    /* ======================================================================
       O MENU DA CONVERSA

       Duas ações que parecem a mesma e não são:

         ARQUIVAR  some da MINHA lista. Qualquer membro pode, e os colegas não
                   são afetados. A mensagem seguinte a traz de volta —
                   arquivar é "não quero ver agora", não "não quero mais
                   falar". Para isso existe silenciar, que é outra coisa.

         REMOVER   some para TODO MUNDO, e só administrador. É a única ação do
                   chat que age sobre o histórico dos outros — por isso pede
                   confirmação e fica na auditoria.
       ====================================================================== */
    abrirMenuDaConversa(c, botao) {
      this.fecharMenu();

      const menu = criar("div", { classe: "menu", role: "menu" });
      const opcao = (texto, classe, aoClicar) => criar("button", {
        classe, type: "button", role: "menuitem", texto,
        onclick: (e) => { e.stopPropagation(); this.fecharMenu(); aoClicar(); },
      });

      menu.appendChild(opcao(
        c.arquivada ? "Desarquivar" : "Arquivar", "",
        () => this.arquivarConversa(c, !c.arquivada)));

      /* Só o administrador vê a remoção. O servidor recusa de qualquer forma;
         aqui é sobre não oferecer o que a pessoa não pode fazer. */
      if (this.estado.eu?.papel === "admin")
        menu.appendChild(opcao("Remover conversa", "risco", () => this.removerConversa(c)));

      botao.parentNode.appendChild(menu);
      botao.setAttribute("aria-expanded", "true");
      this._menuAberto = { menu, botao };

      /* Fechar por clique fora e por ESC. `capture` porque o clique de outro
         botão para na própria linha antes de subir. */
      this._fechaMenu = (e) => { if (!menu.contains(e.target) && e.target !== botao) this.fecharMenu(); };
      this._escMenu = (e) => { if (e.key === "Escape") { this.fecharMenu(); botao.focus(); } };
      setTimeout(() => {
        this.raiz.addEventListener("click", this._fechaMenu, true);
        this.raiz.addEventListener("keydown", this._escMenu);
      }, 0);

      menu.querySelector("button")?.focus();
    }

    fecharMenu() {
      if (this._fechaMenu) this.raiz.removeEventListener("click", this._fechaMenu, true);
      if (this._escMenu) this.raiz.removeEventListener("keydown", this._escMenu);
      this._fechaMenu = this._escMenu = null;
      if (!this._menuAberto) return;
      const { menu, botao } = this._menuAberto;
      try { menu.remove(); } catch { }
      botao.setAttribute("aria-expanded", "false");
      this._menuAberto = null;
    }

    async arquivarConversa(c, arquivar) {
      try {
        await this.api("/conversas/" + c.id + "/arquivar",
          { metodo: "POST", corpo: { arquivar } });
        c.arquivada = arquivar;
        /* Arquivar a conversa ABERTA fecha a conversa: deixá-la na tela
           depois de tirá-la da lista é dizer duas coisas contrárias. */
        if (arquivar && this.estado.atual?.id === c.id) this.fecharConversa();
        this.pintarLista();
      } catch (e) {
        this.mostrarFaixa(e.message, true);
      }
    }

    async removerConversa(c) {
      const nome = c.tipo === "grupo" ? (c.titulo || "o grupo") : (c.outro?.nome || "a conversa");
      /* A confirmação diz o que ACONTECE, e para quem — "tem certeza?" não
         informa nada a quem já clicou. */
      if (!confirm("Remover " + nome + " para TODOS os participantes?\n\n"
        + "As mensagens deixam de aparecer para todo mundo. Só um administrador "
        + "pode fazer isto, e a ação fica registrada.")) return;
      try {
        await this.api("/conversas/" + c.id, { metodo: "DELETE" });
        this.tirarConversaDaTela(c.id);
      } catch (e) {
        this.mostrarFaixa(e.message, true);
      }
    }

    /* Some da tela — usado pelo próprio administrador e por quem recebeu o
       aviso pelo socket. Um caminho só, para os dois não divergirem. */
    tirarConversaDaTela(conversaId) {
      this.estado.conversas = this.estado.conversas.filter((x) => x.id !== conversaId);
      if (this.estado.atual?.id === conversaId) {
        this.fecharConversa();
        this.mostrarFaixa("Esta conversa foi removida.", false);
        setTimeout(() => this.esconderFaixa(), 5000);
      }
      this.pintarLista();
    }

    /* ======================================================================
       O TEXTO DA LINHA NA BARRA LATERAL

       É um método próprio, e não uma expressão dentro de `linhaConversa`, para
       poder ser ESTENDIDO. Mensagem de sistema (uma chamada encerrada, por
       exemplo) tem corpo em JSON — e a frase depende de quem lê. Quem sabe
       montá-la é o módulo que criou o evento, não este arquivo.

       Sem o ponto de extensão, a barra lateral mostrava o JSON cru:
           {"ev":"chamada","id":"01M0JY1…
       ====================================================================== */
    textoDaPrevia(c) {
      const p = c.previa;
      if (!p) return "";
      if (p.apagada) return "mensagem apagada";

      if (p.evento) {
        const frase = this.fraseDoEvento?.(p.evento, c);
        /* Sem quem saiba traduzir aquele evento, a linha fica VAZIA — nunca
           com o JSON. Um campo em branco é discreto; o JSON é um defeito
           visível para o cliente. */
        return frase || "";
      }
      return p.texto || "";
    }

    linhaPessoa(p) {
      const item = criar("button", {
        classe: "item", role: "listitem",
        "aria-label": `${p.nome}, ${p.status || "offline"}`,
        onclick: () => this.abrirComPessoa(p.id),
      });
      item.appendChild(this.avatar(p, p.status || "offline"));
      item.appendChild(criar("div", { classe: "txt" }, [
        criar("div", { classe: "nome" }, [criar("b", { texto: p.nome })]),
        criar("div", { classe: "previa", texto: p.cargo || p.departamento || "" }),
      ]));
      return item;
    }

    pintarBusca(lista) {
      const r = this.estado.resultado;

      if (r.pessoas?.length) {
        lista.appendChild(criar("div", { classe: "dia" }, [criar("span", { texto: "Pessoas" })]));
        for (const p of r.pessoas) lista.appendChild(this.linhaPessoa(p));
      }

      if (r.mensagens?.length) {
        lista.appendChild(criar("div", { classe: "dia" }, [criar("span", { texto: "Mensagens" })]));
        for (const m of r.mensagens) {
          const c = this.estado.conversas.find((x) => x.id === m.conversaId);
          lista.appendChild(criar("button", {
            classe: "item",
            onclick: () => { if (c) this.abrirConversa(c); },
          }, [
            criar("div", { classe: "txt" }, [
              criar("div", { classe: "nome" }, [
                criar("b", { texto: c?.outro?.nome || c?.titulo || "Conversa" }),
                criar("span", { classe: "hora", texto: horaCurta(m.criadaEm) }),
              ]),
              criar("div", { classe: "previa", texto: m.corpo }),
            ]),
          ]));
        }
      }

      if (!r.pessoas?.length && !r.mensagens?.length) {
        lista.appendChild(criar("div", { classe: "carregando",
          texto: `Nada encontrado para "${this.estado.busca}".` }));
      }

      /* Diz quais palavras a busca conseguiu usar. Buscar "de" e receber nada
         sem explicação faz a pessoa achar que a busca está quebrada. */
      const uteis = r.palavras || [];
      if (uteis.length && uteis.length < this.estado.busca.split(/\s+/).length) {
        lista.appendChild(criar("div", { classe: "carregando",
          texto: "Procurando por: " + uteis.join(", ") }));
      }
    }

    pintarCabecalho() {
      const cab = this.el.cab;
      limpar(cab);
      const c = this.estado.atual;

      /* Sem conversa aberta o cabeçalho não fica vazio: ele guarda o botão de
         fechar o chat. Antes, quem estava no estado "nenhuma conversa" ficava
         sem nenhuma saída visível no computador. */
      if (!c) {
        cab.appendChild(criar("div", { classe: "txt" }, [
          criar("b", { texto: "Conversas" }),
          criar("small", { texto: `${this.estado.conversas.length} no total` }),
        ]));
        if (this.modo !== "fullpage")
          cab.appendChild(criar("button", {
            classe: "icone", texto: "✕", "aria-label": "Fechar chat", onclick: () => this.fechar(),
          }));
        return;
      }

      cab.appendChild(criar("button", {
        classe: "icone voltar", texto: "‹",
        /* O rótulo muda com o tamanho da tela porque a AÇÃO é a mesma mas o
           significado para quem usa não é: no celular ele volta para a lista
           (que ocupava a tela inteira); no computador ele fecha a conversa,
           com a lista sempre visível ao lado. */
        "aria-label": window.innerWidth <= 720 ? "Voltar para a lista" : "Fechar esta conversa",
        title: "Fechar conversa (Esc)",
        onclick: () => this.fecharConversa(),
      }));

      const nome = c.tipo === "grupo" ? (c.titulo || "Grupo") : (c.outro?.nome || "Conversa");
      const status = c.tipo === "grupo"
        ? `${(c.membros || []).length} participantes`
        : (c.outro?.status === "online" ? "Online"
          : c.outro?.status === "ocupado" ? "Ocupado"
          : c.outro?.status === "ausente" ? "Ausente"
          : c.outro?.vistoEm ? "Visto " + horaCurta(c.outro.vistoEm) : "Offline");

      const av = this.avatar(c.tipo === "grupo" ? { nome } : c.outro,
        c.tipo === "grupo" ? null : (c.outro?.status || "offline"));
      if (c.tipo === "direta" && c.outro) {
        const botao = criar("button", {
          classe: "icone", "aria-label": "Ver perfil de " + nome,
          onclick: () => this.mostrarPerfil(c.outro.id),
        });
        botao.appendChild(av);
        botao.style.width = "auto"; botao.style.height = "auto";
        cab.appendChild(botao);
      } else {
        cab.appendChild(av);
      }

      cab.appendChild(criar("div", { classe: "txt" }, [
        criar("b", { texto: nome }),
        criar("small", { texto: status }),
      ]));

      if (this.modo !== "fullpage")
        cab.appendChild(criar("button", {
          classe: "icone", texto: "✕", "aria-label": "Fechar chat", onclick: () => this.fechar(),
        }));
    }

    pintarMensagens(irAoFim = false) {
      const corpo = this.el.corpo;
      const estavaNoFim = corpo.scrollHeight - corpo.scrollTop - corpo.clientHeight < 80;
      limpar(corpo);

      if (!this.estado.mensagens.length) {
        corpo.appendChild(criar("div", { classe: "vazio" }, [
          criar("div", { classe: "grande", texto: "💬" }),
          criar("div", { texto: "Nenhuma mensagem ainda. Diga olá." }),
        ]));
        return;
      }

      if (this.estado.temMais)
        corpo.appendChild(criar("div", { classe: "carregando", texto: "Carregando mensagens anteriores…" }));

      let ultimoDia = "";
      let ultimoAutor = "";

      for (const m of this.estado.mensagens) {
        const d = dia(m.criadaEm);
        if (d !== ultimoDia) {
          corpo.appendChild(criar("div", { classe: "dia" }, [criar("span", { texto: d })]));
          ultimoDia = d;
          ultimoAutor = "";
        }
        const primeira = m.autorId !== ultimoAutor;
        corpo.appendChild(this.bolha(m, primeira));
        ultimoAutor = m.autorId;
      }

      if (irAoFim || estavaNoFim) corpo.scrollTop = corpo.scrollHeight;
    }

    bolha(m, primeira) {
      const minha = m.autorId === this.estado.eu?.id;
      const autor = this.estado.atual?.membros?.find((x) => x.id === m.autorId);

      const linha = criar("div", {
        classe: "msg" + (minha ? " minha" : "") + (primeira ? " primeira" : ""),
      });

      linha.appendChild(this.avatar(minha ? this.estado.eu : (autor || { nome: "?" })));

      const bolha = criar("div", { classe: "bolha" + (m.apagada ? " apagada" : "") });

      /* Nome do autor só em grupo, e só na primeira da sequência: repetir a
         cada linha polui, e não repetir nunca deixa a conversa ambígua. */
      if (!minha && primeira && this.estado.atual?.tipo === "grupo")
        bolha.appendChild(criar("div", { classe: "autor", texto: autor?.nome || "" }));

      if (m.apagada) {
        bolha.appendChild(criar("div", { classe: "conteudo" }, [
          criar("p", { texto: "Mensagem apagada" }),
        ]));
      } else {
        if (m.corpo) bolha.appendChild(renderizarTexto(m.corpo));
        for (const a of m.anexos || []) bolha.appendChild(this.anexo(a));
      }

      const rodape = criar("div", { classe: "rodape" });
      rodape.appendChild(criar("span", { texto: hora(m.criadaEm) }));
      if (m.editadaEm) rodape.appendChild(criar("span", { texto: "· editada" }));
      if (minha) rodape.appendChild(criar("span", { texto: this.marcaDeEstado(m) }));
      bolha.appendChild(rodape);

      if (m.estado === "erro") {
        bolha.appendChild(criar("button", {
          classe: "botao fraco", texto: "Tentar de novo",
          onclick: () => {
            this.estado.mensagens = this.estado.mensagens.filter((x) => x !== m);
            this.el.area.value = m.corpo;
            this.pintarMensagens();
            this.enviar();
          },
        }));
      }

      /* Apagar a própria mensagem. Aparece no hover e no foco — só no hover
         seria inalcançável por teclado (§29). */
      if (minha && !m.apagada && m.id && !String(m.id).startsWith("tmp-")) {
        linha.appendChild(criar("button", {
          classe: "icone", texto: "⋯", "aria-label": "Apagar mensagem",
          onclick: () => this.apagar(m),
        }));
      }

      linha.appendChild(bolha);
      return linha;
    }

    /* Os estados do §13, na forma que as pessoas já conhecem. */
    marcaDeEstado(m) {
      if (m.estado === "enviando") return "🕐";
      if (m.estado === "erro") return "⚠";
      if (this.estado.marcas.lidaAte >= m.seq) return "✓✓";
      if (this.estado.marcas.entregueAte >= m.seq) return "✓✓";
      return "✓";
    }

    /* ====================================================================
       ANEXO NA BOLHA

       Imagem aparece como IMAGEM. Antes tudo virava um link com um emoji —
       e mandar uma foto num chat para receber "🖼 foto.png" de volta é o
       oposto do que se espera.

       Tanto a prévia quanto o download passam pela rota AUTENTICADA, nunca
       por um caminho de arquivo. É por isso que trocar o id na URL devolve
       404 em vez do anexo de outra conversa.
       ==================================================================== */
    anexo(a) {
      const ehImagem = String(a.tipo || "").startsWith("image/");

      if (ehImagem) {
        /* A imagem é clicável e abre o download (o arquivo original, em tamanho
           cheio). A prévia é só o que a bolha mostra. */
        const link = criar("a", {
          classe: "anexo-img", href: `${this.base}/arquivos/${a.id}`,
          download: a.nome, rel: "noopener", "aria-label": "Baixar " + a.nome,
        });

        const img = criar("img", {
          src: `${this.base}/arquivos/${a.id}/previa`,
          /* O nome do arquivo é a melhor descrição que temos — melhor que
             `alt=""`, que faria o leitor de tela pular a imagem em silêncio. */
          alt: a.nome,
          loading: "lazy", decoding: "async",
        });

        /* As dimensões evitam o pulo de layout enquanto a imagem carrega —
           sem elas a conversa "salta" e quem estava lendo perde a linha. */
        if (a.largura && a.altura) { img.width = a.largura; img.height = a.altura; }

        /* Prévia que não carrega volta a ser um link, em vez de virar um
           ícone quebrado que não diz o que aconteceu. */
        img.addEventListener("error", () => {
          link.replaceWith(this.anexoComoLink(a));
        });

        link.appendChild(img);
        return link;
      }

      return this.anexoComoLink(a);
    }

    anexoComoLink(a) {
      const link = criar("a", {
        classe: "anexo", href: `${this.base}/arquivos/${a.id}`,
        download: a.nome, rel: "noopener",
      });
      link.appendChild(criar("span", { texto: String(a.tipo || "").startsWith("image/") ? "🖼" : "📄" }));
      link.appendChild(criar("span", { classe: "nome", texto: a.nome }));
      link.appendChild(criar("span", { classe: "tam", texto: tamanhoLegivel(a.tamanho) }));
      return link;
    }

    pintarPendentes() {
      limpar(this.el.pendentes);
      for (const p of this.estado.pendentes) {
        this.el.pendentes.appendChild(criar("span", { classe: "pendente" }, [
          criar("span", { texto: p.enviando ? "⏳" : "📎" }),
          criar("span", { texto: p.nome }),
          criar("button", {
            texto: "✕", "aria-label": "Remover " + p.nome,
            onclick: () => {
              this.estado.pendentes = this.estado.pendentes.filter((x) => x !== p);
              this.pintarPendentes();
              this.el.botaoEnviar.disabled = !this.el.area.value.trim() && !this.estado.pendentes.length;
            },
          }),
        ]));
      }
    }

    pintarDigitando() {
      const alvo = this.el.digitando;
      if (!this.estado.atual) { alvo.textContent = ""; return; }
      const mapa = this.estado.digitando.get(this.estado.atual.id);
      if (!mapa) { alvo.textContent = ""; return; }

      const agora = Date.now();
      for (const [k, v] of mapa) if (v.ate < agora) mapa.delete(k);

      const nomes = [...mapa.values()].map((v) => v.nome);
      alvo.textContent = !nomes.length ? ""
        : nomes.length === 1 ? `${nomes[0]} está digitando…`
        : `${nomes.slice(0, 2).join(" e ")} estão digitando…`;
    }

    pintarRodapeBarra() {
      const r = this.el.rodapeBarra;
      limpar(r);
      if (!this.estado.eu) return;

      r.appendChild(this.avatar(this.estado.eu, this.estado.statusManual || "online"));
      r.appendChild(criar("div", { classe: "txt" }, [
        criar("b", { texto: this.estado.eu.nome }),
      ]));

      const sel = criar("select", { "aria-label": "Meu status" });
      for (const [v, t] of [["online", "Online"], ["ocupado", "Ocupado"], ["ausente", "Ausente"], ["offline", "Invisível"]])
        sel.appendChild(criar("option", { value: v, texto: t }));
      sel.value = this.estado.statusManual || "online";
      sel.addEventListener("change", async () => {
        try {
          await this.api("/status", { metodo: "POST", corpo: { status: sel.value } });
          this.estado.statusManual = sel.value;
          this.pintarRodapeBarra();
        } catch (e) { this.mostrarFaixa(e.message, true); }
      });
      r.appendChild(sel);
    }

    /* ====================================================================
       15. PERFIL (§7)
       ==================================================================== */
    async mostrarPerfil(usuarioId) {
      let p;
      try { p = await this.api("/pessoas/" + usuarioId); }
      catch (e) { return this.mostrarFaixa(e.message, true); }

      const fechar = () => sobre.remove();
      const sobre = criar("div", { classe: "sobreposicao", role: "dialog", "aria-modal": "true" });
      sobre.addEventListener("click", (e) => { if (e.target === sobre) fechar(); });

      const cartao = criar("div", { classe: "cartao" });
      cartao.appendChild(this.avatar(p, p.status));
      cartao.appendChild(criar("h3", { texto: p.nomeCompleto || p.nome }));
      if (p.cargo) cartao.appendChild(criar("div", { classe: "cargo", texto: p.cargo }));

      const dl = criar("dl");
      const par = (rotulo, valor) => {
        if (!valor) return;
        dl.appendChild(criar("dt", { texto: rotulo }));
        dl.appendChild(criar("dd", { texto: valor }));
      };
      par("Situação", { online: "Online", ocupado: "Ocupado", ausente: "Ausente", offline: "Offline" }[p.status]);
      par("Departamento", p.departamento);
      if (p.status === "offline" && p.vistoEm) par("Visto", horaCurta(p.vistoEm));
      cartao.appendChild(dl);

      if (p.id !== this.estado.eu?.id) {
        cartao.appendChild(criar("button", {
          classe: "botao", texto: "Enviar mensagem",
          onclick: () => { fechar(); this.abrirComPessoa(p.id); },
        }));
      }
      cartao.appendChild(criar("button", { classe: "botao fraco", texto: "Fechar",
        onclick: fechar, style: "margin-top:8px" }));

      sobre.appendChild(cartao);
      this.el.painel.appendChild(sobre);
      cartao.querySelector("button")?.focus();
    }

    async apagar(m) {
      /* `confirm` é do navegador de propósito: um diálogo próprio dentro do
         Shadow DOM precisaria de gestão de foco e de rota de escape para
         teclado, e o do navegador já tem as duas, testadas. */
      if (!window.confirm("Apagar esta mensagem para todos?")) return;
      try {
        await this.api(`/conversas/${this.estado.atual.id}/mensagens/${m.id}`, { metodo: "DELETE" });
        m.apagada = true; m.corpo = "";
        this.pintarMensagens();
      } catch (e) { this.mostrarFaixa(e.message, true); }
    }
  }

  customElements.define("la-chat", LaChat);

  /* ==========================================================================
     16. ATALHO DE INSTALAÇÃO

     Uma linha no HTML do hospedeiro e o chat existe:

         <script src="https://chat.../chat/cliente.js" defer
                 data-auto data-modo="drawer"></script>

     `data-auto` cria o elemento e um botão flutuante. Quem quiser controle
     total omite o atributo e põe o `<la-chat>` onde quiser.
     ========================================================================== */
  const meu = document.currentScript;
  if (meu?.dataset.auto !== undefined) {
    const pronto = () => {
      const el = document.createElement("la-chat");
      el.setAttribute("modo", meu.dataset.modo || "drawer");
      if (meu.dataset.base) el.setAttribute("base", meu.dataset.base);
      if (meu.dataset.passeUrl) el.setAttribute("passe-url", meu.dataset.passeUrl);
      if (meu.dataset.tema) el.setAttribute("tema", meu.dataset.tema);
      document.body.appendChild(el);

      const botao = document.createElement("button");
      botao.type = "button";
      botao.setAttribute("aria-label", "Abrir chat");
      botao.textContent = "💬";
      botao.style.cssText =
        "position:fixed;right:20px;bottom:20px;z-index:2147482999;width:56px;height:56px;" +
        "border-radius:50%;border:0;cursor:pointer;font-size:24px;color:#fff;" +
        "background:" + (meu.dataset.cor || "#2c5cff") + ";box-shadow:0 6px 20px rgba(0,0,0,.25)";

      const selo = document.createElement("span");
      selo.style.cssText =
        "position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;" +
        "border-radius:10px;background:#dc2626;color:#fff;font-size:11px;font-weight:700;" +
        "display:none;align-items:center;justify-content:center";
      botao.appendChild(selo);

      botao.addEventListener("click", () => { el.abrir(); el.pedirPermissaoDeAviso(); });

      /* ====================================================================
         O TÍTULO DA ABA — "(3) Gestão — BemEstarClinic"

         Vale mais que o selo: a pessoa está com a agenda aberta em outra aba,
         não vê o botão, e a barra de abas do navegador é o único lugar que ela
         olha o tempo todo.

         O título ORIGINAL é lido a cada mudança, não guardado uma vez no
         carregamento: o site troca de tela sem recarregar a página e reescreve
         o `document.title`. Guardar o de partida faria a primeira mensagem
         congelar o título na tela onde a pessoa estava quando abriu o sistema.
         O `(n)` é removido antes de comparar, para não empilhar "(1) (2) (3)".
         ==================================================================== */
      const semContagem = (t) => String(t || "").replace(/^\(\d+\)\s*/, "");
      let contagemNoTitulo = 0;
      const pintarTitulo = (n) => {
        contagemNoTitulo = n;
        const limpo = semContagem(document.title);
        const novo = n ? `(${n > 99 ? "99+" : n}) ${limpo}` : limpo;
        if (document.title !== novo) document.title = novo;
      };
      /* O site reescreve o título ao trocar de tela e apaga a contagem junto.
         Este observador a repõe — sem ele, o aviso some ao navegar e volta só
         na mensagem seguinte. */
      try {
        const alvo = document.querySelector("title");
        if (alvo) new MutationObserver(() => {
          if (contagemNoTitulo && !/^\(\d+\)/.test(document.title)) pintarTitulo(contagemNoTitulo);
        }).observe(alvo, { childList: true });
      } catch { }

      el.addEventListener("la-chat-nao-lidas", (e) => {
        const n = e.detail.total;
        selo.textContent = n > 99 ? "99+" : String(n);
        selo.style.display = n ? "flex" : "none";
        botao.setAttribute("aria-label", n ? `Abrir chat — ${n} não lida(s)` : "Abrir chat");
        pintarTitulo(n);
      });

      document.body.appendChild(botao);

      /* ====================================================================
         LIBERAR O SOM NA PRIMEIRA INTERAÇÃO COM A PÁGINA

         O navegador só permite tocar áudio depois de a pessoa interagir — e
         isso é correto. O erro era ESCUTAR essa interação apenas dentro do
         chat: quem nunca abriu o chat nunca liberava o áudio, e é justamente
         essa pessoa que precisa do aviso sonoro. Um clique em qualquer lugar
         do sistema serve, e é o que este ouvinte aproveita.
         ==================================================================== */
      const liberar = () => el.liberarSom?.();
      for (const evento of ["pointerdown", "keydown", "touchstart"])
        document.addEventListener(evento, liberar, { once: true, capture: true, passive: true });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", pronto);
    else pronto();
  }
})();
