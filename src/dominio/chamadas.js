/* ==========================================================================
   dominio/chamadas.js — as regras da reunião, sem rede e sem banco

   Aqui mora o que é VERDADE sobre uma chamada independentemente de haver
   WebRTC, WebSocket ou SQLite do outro lado. É o que a suíte de unidade
   exercita sem subir nada.

   ---------------------------------------------------------------------------
   O TETO DE PARTICIPANTES NÃO É UM NÚMERO ARBITRÁRIO

   A topologia é MALHA: cada pessoa envia o próprio vídeo para cada uma das
   outras. Com N pessoas, cada uma SOBE (N-1) fluxos:

       2 pessoas  ->  1 subida   ~1,5 Mbps    tranquilo
       4 pessoas  ->  3 subidas  ~4,5 Mbps    ok
       6 pessoas  ->  5 subidas  ~7,5 Mbps    dói em 4G e ADSL
       8 pessoas  ->  7 subidas  ~10,5 Mbps   quebra

   O teto existe para a reunião FALHAR NA PORTA em vez de degradar no meio.
   Uma sétima pessoa entrando não deixa a chamada "um pouco pior": ela derruba
   o áudio de todo mundo, e ninguém entende por quê.

   Quando este teto virar limitação real, a saída é o SFU — e a decisão está
   registrada em docs/VIDEO.md. Não se aumenta este número para ganhar tempo.
   ========================================================================== */
"use strict";

/* Seis é o teto de operação; acima disso a malha não é honesta.
   Configurável para baixo (uma instalação com internet ruim pode querer 4),
   nunca para cima sem trocar de topologia. */
const TETO_MALHA = 6;

/* Quanto tempo o telefone toca antes de desistir. 45 s é o que o celular faz —
   tempo de sair da sala e atender, curto o bastante para não ficar tocando
   para uma pessoa que saiu para almoçar. */
const TOCANDO_MS = 45_000;

/* Uma chamada onde ninguém entrou nunca vira reunião. Depois deste prazo ela
   é encerrada pela faxina, mesmo que o servidor tenha reiniciado no meio e
   ninguém tenha mandado "encerrar". */
const ABANDONO_MS = 5 * 60_000;

const ESTADOS = Object.freeze(["tocando", "ativa", "encerrada"]);
const ESTADOS_PARTICIPANTE = Object.freeze(
  ["convidado", "tocando", "dentro", "saiu", "recusou", "perdeu"]);

/* ==========================================================================
   A MÁQUINA DE ESTADOS, escrita como tabela

   Escrita assim, e não como uma sequência de `if`, porque a pergunta que se
   faz na revisão é "de `dentro` dá para ir aonde?" — e uma tabela responde
   isso olhando; `if` espalhado exige ler o arquivo inteiro e torcer.
   ========================================================================== */
const TRANSICOES = Object.freeze({
  convidado: ["tocando", "dentro", "recusou", "perdeu"],
  tocando: ["dentro", "recusou", "perdeu"],
  /* De `dentro` só se sai. Reentrar é uma transição de `saiu` para `dentro`,
     e ela existe: a pessoa cai a rede, volta, e a reunião continua. */
  dentro: ["saiu"],
  saiu: ["dentro"],
  recusou: ["dentro"],
  perdeu: ["dentro"],
});

const podeIrPara = (de, para) =>
  ESTADOS_PARTICIPANTE.includes(para) && !!TRANSICOES[de]?.includes(para);

/* Estados que ocupam vaga na malha. `tocando` NÃO ocupa: contar quem ainda não
   atendeu faria uma reunião de três pessoas recusar a quarta porque duas
   convidadas nunca atenderam. */
const OCUPA_VAGA = Object.freeze(["dentro"]);
const ehParticipanteVivo = (estado) => OCUPA_VAGA.includes(estado);

/* ==========================================================================
   CABE MAIS UM?
   ========================================================================== */
function cabe(participantesDentro, teto = TETO_MALHA) {
  const n = Number(participantesDentro) || 0;
  return {
    ok: n < teto,
    vagas: Math.max(0, teto - n),
    motivo: n < teto ? "" :
      `Esta reunião já está com ${teto} pessoas, que é o limite para manter a qualidade do áudio e do vídeo.`,
  };
}

/* ==========================================================================
   QUEM DEVE TOCAR

   Numa conversa direta, toca para o outro. Num grupo, toca para todos os
   membros MENOS quem iniciou — e menos quem já está dentro, que é o caso de
   alguém iniciar uma chamada numa conversa onde outra já rolava.

   A pessoa que iniciou nunca recebe toque da própria chamada: parece óbvio, e
   é o tipo de coisa que, esquecida, faz o telefone do autor tocar na mão dele.
   ========================================================================== */
function quemToca(membrosIds, iniciadorId, jaDentroIds = []) {
  const dentro = new Set(jaDentroIds);
  return [...new Set(membrosIds || [])]
    .filter((id) => id !== iniciadorId && !dentro.has(id));
}

/* ==========================================================================
   O DESFECHO — o que a linha do histórico vai dizer

   Uma chamada que termina sem ninguém ter entrado não é "chamada de 0 segundo":
   é uma chamada PERDIDA, e é assim que ela tem de aparecer na conversa. A
   diferença importa para quem abre o chat depois e quer saber se precisa
   retornar.
   ========================================================================== */
function desfecho({ atendida, participantes, encerradaPor }) {
  if (!atendida) {
    const alguemRecusou = (participantes || []).some((p) => p.estado === "recusou");
    return alguemRecusou ? "recusada" : "ninguem_atendeu";
  }
  if (encerradaPor === "sozinho") return "sozinho";
  return "normal";
}

/* Duração legível para a linha do histórico. Segundos só até um minuto —
   "1min 3s" numa reunião de meia hora é ruído. */
function duracaoLegivel(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto ? `${h}h ${resto}min` : `${h}h`;
}

/* ==========================================================================
   O CORPO DA MENSAGEM DE SISTEMA

   Quando a chamada acaba, uma mensagem entra na conversa. Ela usa a coluna
   `tipo = 'sistema'`, que já existia no esquema, e o corpo é um JSON curto —
   não uma frase pronta.

   Por que JSON e não texto: a frase depende de QUEM está lendo ("você perdeu"
   x "não atenderam") e do idioma da tela. Gravar a frase montada congelaria as
   duas coisas no banco, cifradas, para sempre.
   ========================================================================== */
function corpoDoEvento({ chamadaId, motivo, duracaoMs, participantes }) {
  return JSON.stringify({
    ev: "chamada",
    id: chamadaId,
    motivo,
    dur: Math.max(0, Math.round((Number(duracaoMs) || 0) / 1000)),
    n: Number(participantes) || 0,
  });
}

/* Lê de volta. Devolve `null` para qualquer coisa que não seja um evento de
   chamada — inclusive texto normal, que é o caso comum de quem chama isto. */
function lerEvento(corpo) {
  if (typeof corpo !== "string" || corpo.length > 500 || corpo[0] !== "{") return null;
  try {
    const v = JSON.parse(corpo);
    return v && v.ev === "chamada" ? v : null;
  } catch { return null; }
}

/* ==========================================================================
   O SINAL DO WebRTC — validação de FORMA, antes de repassar

   O servidor NÃO interpreta SDP nem candidato ICE: ele repassa. Mas repassar
   qualquer coisa que chegue é virar um canal de mensagem arbitrária entre
   participantes, fora de todas as regras do chat — sem limite de tamanho, sem
   auditoria, sem tipo.

   Então: tipo de uma lista fechada, tamanho com teto, e nada além disso.
   O SDP de uma chamada com vídeo fica em 4–8 KB; 64 KB é folga larga e ainda
   impede alguém de empurrar um megabyte por sinal.
   ========================================================================== */
const TIPOS_SINAL = Object.freeze(["oferta", "resposta", "candidato", "renegociar"]);

/* ==========================================================================
   32 KB, E ELE PRECISA FICAR BEM ABAIXO DO TETO DO QUADRO WebSocket (64 KB).

   Os dois eram 64 KB, e o teste mostrou o que isso significava na prática: um
   sinal grande demais estourava o `maxPayload` do `ws` ANTES de chegar aqui, e
   a biblioteca fecha a conexão quando isso acontece. Resultado — em vez de uma
   recusa educada, a pessoa perdia o socket inteiro: caía da reunião, do chat,
   de tudo, e o cliente reconectava do zero.

   Uma trava não pode ser mais destrutiva que o abuso que ela impede. Com 32 KB
   o sinal fora de tamanho é recusado por esta função, com mensagem, e a
   conexão continua de pé.

   O SDP de uma chamada com vídeo e compartilhamento de tela fica em 4–8 KB;
   32 KB é folga de quatro vezes.
   ========================================================================== */
const TETO_SINAL = 32 * 1024;

function validarSinal(sinal) {
  if (!sinal || typeof sinal !== "object")
    return { ok: false, erro: "sinal inválido" };
  if (!TIPOS_SINAL.includes(sinal.tipo))
    return { ok: false, erro: "tipo de sinal desconhecido" };
  if (typeof sinal.para !== "string" || !sinal.para)
    return { ok: false, erro: "sinal sem destinatário" };

  const tamanho = JSON.stringify(sinal.dados ?? null).length;
  if (tamanho > TETO_SINAL)
    return { ok: false, erro: "sinal grande demais" };

  return { ok: true };
}

module.exports = {
  TETO_MALHA, TOCANDO_MS, ABANDONO_MS,
  ESTADOS, ESTADOS_PARTICIPANTE, TRANSICOES, TIPOS_SINAL, TETO_SINAL,
  podeIrPara, ehParticipanteVivo, cabe, quemToca,
  desfecho, duracaoLegivel, corpoDoEvento, lerEvento, validarSinal,
};
