/* ==========================================================================
   indice-cego.js — buscar dentro de mensagens que o servidor cifrou

   O PROBLEMA QUE ELE RESOLVE

   O corpo da mensagem é cifrado em repouso (AES-256-GCM, ver cripto.js). Isso
   é o que faz um `pg_dump` vazado sair inerte. Mas cifrar mata o `LIKE`:
   procurar "orçamento" num texto cifrado não acha nada, porque cada mensagem
   virou bytes diferentes — inclusive duas mensagens idênticas, já que o IV é
   aleatório.

   As saídas erradas, e por que são erradas:

   · DECIFRAR TUDO E FILTRAR EM JAVASCRIPT. Funciona com mil mensagens e morre
     com um milhão — e um chat corporativo chega a um milhão. Além disso puxa
     o histórico inteiro para a memória do processo a cada busca, o que é uma
     negação de serviço que o próprio usuário dispara sem querer.

   · NÃO CIFRAR O CORPO. Devolve a busca e entrega o histórico a quem ler o
     banco. Era o que se queria evitar.

   A SAÍDA: ÍNDICE CEGO

   Não se busca no texto — busca-se num índice de palavras EMBARALHADAS:

       "Orçamento aprovado!"
              ↓  normalizar
       ["orcamento", "aprovado"]
              ↓  HMAC-SHA256 com CHAVE_BUSCA, truncado em 8 bytes
       ["9f3a1c...", "22be04..."]        ← é isto que vai para o banco

   Procurar "orçamento" gera o MESMO valor e casa por igualdade — com índice,
   rápido, e sem o banco nunca ter guardado a palavra.

   POR QUE UMA CHAVE SEPARADA DA CHAVE DOS DADOS
   Se fossem a mesma, um vazamento entregaria as duas capacidades de uma vez.
   Separadas, quem obtiver a chave de busca consegue no máximo TESTAR se uma
   palavra que ele já suspeita aparece — e continua sem ler mensagem nenhuma.

   O QUE ISTO VAZA — dito na cara, porque índice cego não é mágica

   1. FREQUÊNCIA. Quem tiver o banco vê que certo token aparece 4.000 vezes.
      Sem a chave ele não sabe qual palavra é, mas sabe a forma da distribuição
      e, com um dicionário do idioma, pode arriscar palpites estatísticos.
   2. PRESENÇA. Quem tiver a chave de busca pode perguntar "a palavra X existe
      na conversa Y?" sem ler a conversa.
   3. TAMANHO. O número de tokens de uma mensagem sugere o comprimento dela.

   Nada disso entrega conteúdo, e todos exigem acesso ao banco — que é
   justamente o cenário em que, sem cifragem, o atacante já teria TUDO. A troca
   é boa, mas tem de estar escrita.

   AS LIMITAÇÕES, para não prometerem o que não existe

   · Só casa PALAVRA INTEIRA. Não há busca por prefixo ("orça") nem por trecho
     ("çamen"). Prefixo exigiria indexar todos os prefixos de toda palavra —
     o índice ficaria maior que o histórico e o vazamento de frequência ficaria
     muito pior.
   · O truque do truncamento em 8 bytes admite COLISÃO. Por isso quem chama
     REPETE a conferência decifrando as poucas linhas candidatas
     (`confirmar()`), e colisão vira trabalho a mais — nunca resultado errado.
   ========================================================================== */
"use strict";

const crypto = require("node:crypto");

/* Mínimo de 3 letras. Token de 1–2 caracteres ("de", "o", "aí") casa com quase
   tudo: encheria o índice, não filtraria nada e ainda pioraria a análise de
   frequência ao dar ao atacante os tokens mais previsíveis do idioma. */
const MINIMO = 3;

/* Teto de tokens distintos por mensagem. Uma mensagem de 4.000 caracteres tem
   umas 600 palavras; 120 distintas cobre o caso real com folga. O teto existe
   porque sem ele uma mensagem gerada por robô, cheia de palavras únicas, viraria
   milhares de linhas no índice — encher o banco pelo caminho da busca é um
   abuso barato e silencioso. */
const TETO_POR_MENSAGEM = 120;

/* Palavras que não filtram nada em português. Não são "proibidas de buscar":
   uma busca por `de` simplesmente não usa o índice e cai no caminho normal de
   filtro por conversa e período. */
const VAZIAS = new Set([
  "que", "com", "para", "por", "dos", "das", "uma", "nao", "sim", "mas", "como",
  "mais", "sobre", "esta", "este", "isso", "isto", "aqui", "ali", "foi", "ser",
  "tem", "ate", "sua", "seu", "meu", "minha", "nos", "eles", "elas", "voce",
  "ola", "oi", "obrigado", "obrigada", "bom", "boa", "dia", "tarde", "noite",
]);

/* ==========================================================================
   NORMALIZAR — o passo que faz "Orçamento", "orcamento" e "ORÇAMENTO" caírem
   no mesmo token.

   NFD separa a letra do acento (`ç` → `c` + cedilha) e a faixa `̀-ͯ`
   (marcas combinantes) remove os acentos. Sem isso, quem digita sem acento —
   que é a maioria em busca — nunca acharia o que foi escrito com acento, e o
   sintoma seria "a busca não funciona às vezes".

   A faixa é escrita ESCAPADA de propósito. Escrita com os caracteres literais
   ela é invisível no editor, sobrevive mal a cópia entre arquivos e a
   conversão de codificação — e quando ela se corrompe nada estoura: a busca
   apenas para de achar palavra acentuada, meses depois, sem sintoma nenhum.
   ========================================================================== */
function normalizar(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    /* Tudo que não é letra ou número vira separador. Isso quebra pontuação,
       emoji e quebra de linha de uma vez — e faz "orçamento!" e "orçamento"
       gerarem o mesmo token. */
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function palavras(texto) {
  const n = normalizar(texto);
  if (!n) return [];
  const vistas = new Set();
  for (const p of n.split(" ")) {
    if (p.length < MINIMO || VAZIAS.has(p)) continue;
    /* Palavra absurdamente longa é lixo (hash colado, base64 dentro do texto):
       truncar em 40 evita gastar índice com isso e mantém o token estável. */
    vistas.add(p.length > 40 ? p.slice(0, 40) : p);
    if (vistas.size >= TETO_POR_MENSAGEM) break;
  }
  return [...vistas];
}

/* ==========================================================================
   O TOKEN

   HMAC, e não hash puro: um SHA-256 de "orcamento" é o mesmo em toda
   instalação do mundo, e uma tabela pré-calculada das 50 mil palavras do
   português quebraria o índice inteiro em segundos. O HMAC prende o valor à
   chave DESTA instalação — sem ela, a tabela não serve para nada.
   ========================================================================== */
function criarIndice(segredo) {
  if (!segredo || String(segredo).length < 16)
    throw new Error("índice cego exige CHAT_SEGREDO_BUSCA com pelo menos 16 caracteres");

  const chave = Buffer.from(String(segredo));

  const token = (palavra) =>
    crypto.createHmac("sha256", chave).update(palavra).digest("hex").slice(0, 16); // 8 bytes

  return {
    /* Tokens para GRAVAR junto de uma mensagem. */
    tokensDe(texto) {
      return palavras(texto).map(token);
    },

    /* Tokens para BUSCAR. É a mesma conta — e tem de continuar sendo, senão a
       busca para de achar o que ela mesma gravou. Existe como função própria
       só para deixar explícito no código de busca o que está acontecendo. */
    tokensDaBusca(consulta) {
      return palavras(consulta).map(token);
    },

    /* Quais palavras da consulta o índice consegue atender. A tela usa isto
       para avisar "procurando por: orçamento" quando o resto foi descartado —
       busca que ignora metade do que a pessoa digitou sem dizer nada é busca
       que devolve resultado errado com cara de certo. */
    palavrasUteis(consulta) {
      return palavras(consulta);
    },

    /* ======================================================================
       A RECONFERÊNCIA.

       O índice devolve CANDIDATAS. Esta função olha o texto já decifrado e
       confirma que a palavra está mesmo lá. É o que transforma a colisão de
       8 bytes em "uma linha a mais para descartar" em vez de "um resultado
       errado na tela".

       Também é o que garante que a busca por várias palavras seja E, e não OU:
       o índice pode trazer quem tem qualquer um dos tokens, e é aqui que fica
       só quem tem todos.
       ====================================================================== */
    confirmar(textoDecifrado, consulta) {
      const alvo = new Set(palavras(textoDecifrado));
      const termos = palavras(consulta);
      if (!termos.length) return false;
      return termos.every((t) => alvo.has(t));
    },
  };
}

module.exports = { criarIndice, normalizar, palavras, MINIMO, TETO_POR_MENSAGEM };
