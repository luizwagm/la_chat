/* ==========================================================================
   limites.js — freio de uso normal (§32, §33)

   NÃO CONFUNDIR COM `limitador.js`. São dois problemas diferentes, e tratá-los
   com o mesmo mecanismo faz um dos dois ficar errado:

     `limitador.js`  → ATAQUE DE SENHA. Guarda em disco (tem de sobreviver a
                       reinício), pune com espera crescente, tem balde por
                       conta além do balde por IP. Poucos eventos, caros.

     `limites.js`    → USO ABUSIVO por quem JÁ está autenticado. Muitos
                       eventos, baratos: cada mensagem, cada busca, cada
                       tecla de "digitando". Vive só na memória — perder a
                       contagem num reinício custa nada, e gravar em disco 30
                       vezes por minuto por pessoa custaria muito.

   ---------------------------------------------------------------------------
   JANELA DESLIZANTE, E NÃO JANELA FIXA

   Janela fixa ("30 por minuto, zerando no minuto cheio") tem um furo conhecido:
   30 mensagens às 10:00:59 e mais 30 às 10:01:00 são 60 em um segundo, e o
   limite "de 30 por minuto" foi respeitado ao pé da letra. Com janela
   deslizante, o que conta é sempre "os últimos 60 segundos a partir de agora",
   e o furo não existe.

   O custo é guardar os instantes em vez de um contador. Para 30 eventos por
   pessoa é irrelevante, e o teto de itens por balde impede que fique caro.
   ========================================================================== */
"use strict";

function criarLimites() {
  /* chave ("msg:<usuario>") -> array de instantes, do mais antigo ao mais novo */
  const baldes = new Map();

  /* Faxina periódica. Sem ela, o mapa guarda uma entrada por pessoa que já
     usou o chat alguma vez — num serviço de meses, é um vazamento lento que
     ninguém liga ao chat. */
  const faxina = setInterval(() => {
    const t = Date.now();
    for (const [k, marcas] of baldes) {
      /* Uma hora sem uso: some. É maior que qualquer janela configurada. */
      if (!marcas.length || t - marcas[marcas.length - 1] > 3600e3) baldes.delete(k);
    }
  }, 5 * 60e3);
  faxina.unref();

  return {
    /* Devolve `{ ok }` ou `{ ok: false, esperar }` em SEGUNDOS.

       `esperar` é calculado a partir do evento MAIS ANTIGO da janela: é
       exatamente quando abre a próxima vaga. Devolver um valor genérico
       ("tente em 60s") faria a tela mentir e a pessoa esperar mais que o
       necessário. */
    conferir(chave, { maximo, janelaMs }) {
      const t = Date.now();
      let marcas = baldes.get(chave);
      if (!marcas) { marcas = []; baldes.set(chave, marcas); }

      /* Descarta o que saiu da janela. Como o array está em ordem, basta
         cortar o começo — não é preciso varrer tudo. */
      const corte = t - janelaMs;
      let i = 0;
      while (i < marcas.length && marcas[i] <= corte) i++;
      if (i) marcas.splice(0, i);

      if (marcas.length >= maximo) {
        const esperar = Math.max(1, Math.ceil((marcas[0] + janelaMs - t) / 1000));
        return { ok: false, esperar, usado: marcas.length, maximo };
      }

      marcas.push(t);
      return { ok: true, usado: marcas.length, maximo };
    },

    /* Consulta sem CONSUMIR. Usado onde a resposta precisa ser conferida duas
       vezes (antes de gastar trabalho e de novo antes de gravar) sem que a
       primeira conferência queime a vaga. */
    espiar(chave, { maximo, janelaMs }) {
      const marcas = baldes.get(chave) || [];
      const corte = Date.now() - janelaMs;
      const vivos = marcas.filter((m) => m > corte).length;
      return { ok: vivos < maximo, usado: vivos, maximo };
    },

    limpar(chave) { baldes.delete(chave); },
    zerar() { baldes.clear(); },
    tamanho: () => baldes.size,
    encerrar() { clearInterval(faxina); },
  };
}

module.exports = { criarLimites };
