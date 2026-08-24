/* ==========================================================================
   repositorios/mensagens.js — o coração do sistema

   Três coisas acontecem aqui e em nenhum outro lugar:
     1. o `seq` é atribuído, dentro da transação que grava a mensagem;
     2. o corpo é cifrado e o índice cego é alimentado;
     3. o reenvio é reconhecido em vez de duplicado.
   ========================================================================== */
"use strict";

const { ulid, ehUlid } = require("../../../dominio/ids.js");
const { agora } = require("../banco.js");
const cripto = require("../../seguranca/cripto.js");

function criar(Q, indice) {
  function paraFora(l, opcoes = {}) {
    if (!l) return null;
    const apagada = !!l.apagada_em;
    return {
      id: l.id,
      conversaId: l.conversa_id,
      autorId: l.autor_id,
      seq: Number(l.seq),
      tipo: l.tipo,
      /* Mensagem apagada devolve corpo VAZIO — nunca o texto original.
         Soft delete existe para preservar a auditoria e o `seq` (que não pode
         ter buraco), não para devolver o conteúdo a quem pedir de novo. */
      corpo: apagada ? "" : cripto.decifrar(l.corpo),
      formato: l.formato,
      idCliente: l.id_cliente || "",
      respondeA: l.responde_a || null,
      criadaEm: Number(l.criada_em),
      editadaEm: l.editada_em ? Number(l.editada_em) : null,
      apagada,
      ...(opcoes.anexos ? { anexos: opcoes.anexos } : {}),
    };
  }

  const repo = {
    paraFora,

    /* ======================================================================
       ENVIAR

       O SEQ É ATRIBUÍDO PELO BANCO, DENTRO DA TRANSAÇÃO.

       A forma errada, e por que é errada:

           const c = await ler(conversa);        // ultima_seq = 830
           const seq = c.ultima_seq + 1;         // 831
           await gravar(seq);                    // ...

       Entre a leitura e a gravação cabe outra mensagem. As duas calculam 831,
       as duas gravam 831 — e o índice único (conversa_id, seq) faz uma
       estourar. Se não houvesse o índice, seria pior: duas mensagens com o
       mesmo número, e a retomada "me dê tudo com seq > 830" entregaria só uma
       delas. A outra some para sempre, sem erro nenhum.

       Aqui o UPDATE incrementa e a leitura acontece dentro da MESMA transação,
       que abriu com trava de escrita (BEGIN IMMEDIATE no SQLite, transação
       normal no PostgreSQL, onde o próprio UPDATE trava a linha). Duas
       mensagens simultâneas ficam em fila; nenhuma perde o número.
       ====================================================================== */
    async enviar({ contextoId, conversaId, autorId, corpo, tipo = "texto",
                   formato = "md", idCliente = "", respondeA = null }) {
      /* ------------------------------------------------------------------
         DEDUPLICAÇÃO ANTES DA TRANSAÇÃO.

         O caminho normal do reenvio (reconectou e mandou de novo por
         precaução) é resolvido com uma leitura barata, sem abrir transação
         nem consumir um `seq`. Consumir seq à toa deixaria buracos na
         numeração, e buraco na numeração é como o cliente detecta mensagem
         perdida — não pode ter falso positivo.
         ------------------------------------------------------------------ */
      if (idCliente) {
        const jaExiste = await Q.get(
          "SELECT * FROM mensagens WHERE conversa_id = ? AND autor_id = ? AND id_cliente = ?",
          conversaId, autorId, idCliente);
        if (jaExiste) return { mensagem: paraFora(jaExiste), repetida: true };
      }

      const id = ulid();
      /* ------------------------------------------------------------------
         SEM CHAVE DO CLIENTE, A CHAVE É NOSSA.

         O índice de deduplicação é UNIQUE (conversa, autor, id_cliente), e a
         coluna tem `DEFAULT ''`. Quem não manda a chave grava `''` — e a
         SEGUNDA mensagem dessa pessoa naquela conversa bate no índice e
         devolve 500, sem nada na tela que explique o quê.

         Achado com um cliente próprio (uma suíte falando HTTP direto), não com
         o componente: o componente sempre manda o ULID dele, e por isso o
         defeito ficou invisível desde o começo. Vale para qualquer integração
         que use a API — um robô de avisos, por exemplo.

         Gerar aqui é o certo, e não recusar com 400: sem chave do cliente não
         existe reenvio a deduplicar; cada POST É uma mensagem nova.
         ------------------------------------------------------------------ */
      if (!idCliente) idCliente = id;
      const t = agora();
      const cifrado = cripto.cifrar(corpo || "");
      /* Os tokens saem do texto CLARO, antes de cifrar — é a única hora em que
         o texto claro existe no servidor. */
      const tokens = tipo === "texto" && corpo ? indice.tokensDe(corpo) : [];

      let seq = 0;
      try {
        await Q.transacao(async (T) => {
          await T.run(
            "UPDATE conversas SET ultima_seq = ultima_seq + 1, ultima_mensagem_em = ? WHERE id = ?",
            t, conversaId);

          /* DESARQUIVA PARA TODOS. Dentro da MESMA transação da mensagem: se
             a mensagem entrou, a conversa reapareceu para quem a arquivou.
             Fora dela, um erro no meio deixaria a mensagem existindo numa
             conversa que ninguém vê — perder mensagem é o pior defeito
             possível num chat. */
          await T.run(
            `UPDATE conversa_membros SET arquivada_em = NULL
               WHERE conversa_id = ? AND arquivada_em IS NOT NULL`, conversaId);
          const c = await T.get("SELECT ultima_seq FROM conversas WHERE id = ?", conversaId);
          seq = Number(c.ultima_seq);

          await T.run(
            `INSERT INTO mensagens (id, conversa_id, contexto_id, autor_id, seq, tipo,
                                    corpo, formato, id_cliente, responde_a, criada_em)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, conversaId, contextoId, autorId, seq, tipo,
            cifrado, formato, idCliente, respondeA, t);

          for (const tk of tokens) {
            await T.run(
              "INSERT INTO mensagem_tokens (mensagem_id, conversa_id, token) VALUES (?, ?, ?)",
              id, conversaId, tk);
          }

          /* Quem escreve já leu o que escreveu. Sem esta linha, a própria
             mensagem entraria na conta de não lidas do autor e a conversa
             apareceria em negrito para quem acabou de falar. */
          await T.run(
            `UPDATE conversa_membros
                SET ultima_lida_seq = ?, ultima_entregue_seq = ?
              WHERE conversa_id = ? AND usuario_id = ?`,
            seq, seq, conversaId, autorId);
        });
      } catch (e) {
        /* Perdeu a corrida do id_cliente: os dois cliques chegaram juntos e o
           índice único arbitrou. Devolver a que ficou é o resultado correto. */
        if (idCliente) {
          const gravada = await Q.get(
            "SELECT * FROM mensagens WHERE conversa_id = ? AND autor_id = ? AND id_cliente = ?",
            conversaId, autorId, idCliente);
          if (gravada) return { mensagem: paraFora(gravada), repetida: true };
        }
        throw e;
      }

      return { mensagem: paraFora(await Q.get("SELECT * FROM mensagens WHERE id = ?", id)), repetida: false };
    },

    /* ======================================================================
       HISTÓRICO — paginação por cursor (§26)

       Por que cursor e não OFFSET:

       `OFFSET 5000` faz o banco percorrer e DESCARTAR 5.000 linhas para
       devolver 50. O custo cresce conforme se rola para cima, exatamente ao
       contrário do que se espera. Pior: se chegarem mensagens novas enquanto a
       pessoa rola, o offset desloca e ela vê a mesma mensagem duas vezes —
       ou pula uma.

       Com cursor (`seq < 830`), o banco vai direto ao ponto pelo índice, o
       custo é o mesmo na primeira e na milésima página, e mensagem nova não
       desloca nada.
       ====================================================================== */
    async historico(conversaId, { antesDeSeq = null, limite = 50 } = {}) {
      const n = Math.max(1, Math.min(200, limite));
      const linhas = antesDeSeq
        ? await Q.all(
            `SELECT * FROM mensagens WHERE conversa_id = ? AND seq < ?
              ORDER BY seq DESC LIMIT ?`, conversaId, antesDeSeq, n)
        : await Q.all(
            `SELECT * FROM mensagens WHERE conversa_id = ?
              ORDER BY seq DESC LIMIT ?`, conversaId, n);

      /* Vem do banco do mais novo para o mais velho (é assim que o índice
         entrega barato) e sai daqui na ordem de leitura. Inverter na tela
         seria repetir esta regra em cada cliente. */
      return linhas.reverse().map((l) => paraFora(l));
    },

    /* RETOMADA APÓS RECONEXÃO (§25) — o motivo de o `seq` existir.

       Um teto GENEROSO mas existente: quem ficou uma semana fora não deve
       receber 40.000 mensagens numa tacada, porque isso derruba a aba dele e
       ocupa o servidor. Acima do teto, o cliente é mandado recarregar o
       histórico pelo caminho normal, paginado. */
    async desde(conversaId, seq, limite = 500) {
      const linhas = await Q.all(
        `SELECT * FROM mensagens WHERE conversa_id = ? AND seq > ?
          ORDER BY seq ASC LIMIT ?`, conversaId, seq, Math.min(1000, limite));
      return linhas.map((l) => paraFora(l));
    },

    async porId(conversaId, id) {
      if (!ehUlid(id)) return null;
      return paraFora(await Q.get(
        "SELECT * FROM mensagens WHERE id = ? AND conversa_id = ?", id, conversaId));
    },

    /* ======================================================================
       BUSCA (§16) — sobre conteúdo cifrado, pelo índice cego

       A AUTORIZAÇÃO ESTÁ DENTRO DA CONSULTA, e não depois dela. A subconsulta
       de `conversa_membros` é o que garante que a busca nunca alcança conversa
       de que a pessoa não participa — nem por engano, nem por id adivinhado.
       Filtrar depois seria pedir ao banco os dados alheios e confiar num `if`.

       O HAVING COUNT(DISTINCT token) = n é o que torna a busca um E: quem
       procura "orçamento aprovado" quer as duas palavras, não qualquer uma.

       O resultado ainda passa por `confirmar()` no chamador, decifrando as
       candidatas — é o que transforma a colisão de 8 bytes do índice em
       trabalho descartado, nunca em resultado errado na tela.
       ====================================================================== */
    async buscar(contextoId, usuarioId, consulta, { limite = 30, conversaId = null } = {}) {
      const tokens = indice.tokensDaBusca(consulta);
      if (!tokens.length) return [];

      const marcas = tokens.map(() => "?").join(",");
      const filtroConversa = conversaId ? "AND t.conversa_id = ?" : "";
      const extras = conversaId ? [conversaId] : [];

      const linhas = await Q.all(
        `SELECT m.id, m.conversa_id, m.autor_id, m.seq, m.tipo, m.corpo, m.formato,
                m.criada_em, m.apagada_em
           FROM mensagem_tokens t
           JOIN mensagens m ON m.id = t.mensagem_id
          WHERE t.token IN (${marcas})
            ${filtroConversa}
            AND m.contexto_id = ?
            AND m.apagada_em IS NULL
            AND t.conversa_id IN (
                  SELECT conversa_id FROM conversa_membros
                   WHERE usuario_id = ? AND saiu_em IS NULL)
          GROUP BY m.id, m.conversa_id, m.autor_id, m.seq, m.tipo, m.corpo, m.formato,
                   m.criada_em, m.apagada_em
         HAVING COUNT(DISTINCT t.token) = ?
          ORDER BY m.criada_em DESC
          LIMIT ?`,
        ...tokens, ...extras, contextoId, usuarioId, tokens.length, Math.min(100, limite));

      /* A reconferência. Decifra e confirma que as palavras estão mesmo lá. */
      const confirmadas = [];
      for (const l of linhas) {
        const texto = cripto.decifrar(l.corpo);
        if (indice.confirmar(texto, consulta)) confirmadas.push({ ...paraFora(l), corpo: texto });
      }
      return confirmadas;
    },

    /* ======================================================================
       APAGAR (§55) — sempre suave, nunca DELETE

       O `seq` não pode ter buraco: é ele que diz ao cliente "você perdeu a
       832". Um DELETE criaria um buraco permanente e todo cliente reconectando
       ficaria pedindo eternamente uma mensagem que não existe mais.

       Além disso, apagar de verdade destruiria a auditoria de que a mensagem
       existiu — que é justamente o que se quer registrar quando alguém apaga
       algo. O corpo cifrado é SOBRESCRITO por vazio, então o conteúdo some de
       fato; o que fica é o esqueleto: quem, quando, e que foi apagada.
       ====================================================================== */
    async apagar(conversaId, mensagemId, porQuem) {
      const t = agora();
      const r = await Q.run(
        `UPDATE mensagens
            SET apagada_em = ?, apagada_por = ?, corpo = '', tipo = tipo
          WHERE id = ? AND conversa_id = ? AND apagada_em IS NULL`,
        t, porQuem, mensagemId, conversaId);
      if (r.linhas) {
        /* O índice de busca some junto. Deixá-lo para trás permitiria
           descobrir, pela busca, que uma mensagem apagada continha certa
           palavra — apagar tem de apagar em todos os lugares. */
        await Q.run("DELETE FROM mensagem_tokens WHERE mensagem_id = ?", mensagemId);
      }
      return r.linhas > 0;
    },

    /* ======================================================================
       EDITAR (§56)

       Reindexa: sem isso, a busca continuaria achando a mensagem pelo texto
       ANTIGO — que é conteúdo que a pessoa pediu para não existir mais.
       ====================================================================== */
    async editar(conversaId, mensagemId, autorId, novoCorpo) {
      const t = agora();
      const r = await Q.run(
        `UPDATE mensagens SET corpo = ?, editada_em = ?
          WHERE id = ? AND conversa_id = ? AND autor_id = ? AND apagada_em IS NULL AND tipo = 'texto'`,
        cripto.cifrar(novoCorpo), t, mensagemId, conversaId, autorId);
      if (!r.linhas) return null;

      await Q.run("DELETE FROM mensagem_tokens WHERE mensagem_id = ?", mensagemId);
      for (const tk of indice.tokensDe(novoCorpo)) {
        await Q.run("INSERT INTO mensagem_tokens (mensagem_id, conversa_id, token) VALUES (?, ?, ?)",
          mensagemId, conversaId, tk);
      }
      return repo.porId(conversaId, mensagemId);
    },

    /* Anexos de um lote de mensagens — uma consulta para a tela inteira. */
    async anexosDe(mensagemIds) {
      if (!mensagemIds?.length) return new Map();
      const marcas = mensagemIds.map(() => "?").join(",");
      const linhas = await Q.all(
        `SELECT id, mensagem_id, nome, tipo_mime, tamanho, largura, altura, miniatura
           FROM anexos WHERE mensagem_id IN (${marcas})`, ...mensagemIds);
      const mapa = new Map();
      for (const a of linhas) {
        if (!mapa.has(a.mensagem_id)) mapa.set(a.mensagem_id, []);
        mapa.get(a.mensagem_id).push({
          id: a.id,
          nome: cripto.decifrar(a.nome),
          tipo: a.tipo_mime,
          tamanho: Number(a.tamanho),
          largura: a.largura || null,
          altura: a.altura || null,
          temMiniatura: !!a.miniatura,
        });
      }
      return mapa;
    },
  };

  return repo;
}

module.exports = { criar };
