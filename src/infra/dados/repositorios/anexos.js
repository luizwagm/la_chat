/* ==========================================================================
   repositorios/anexos.js

   O registro do anexo e o ARQUIVO são coisas separadas: aqui só mora o
   registro. Quem grava bytes é `infra/storage`.

   A separação importa porque a autorização mora aqui: para baixar um arquivo é
   preciso descobrir a QUAL CONVERSA ele pertence e se quem pede é membro dela.
   Se o caminho no disco fosse a única informação, a autorização teria de ser
   deduzida do nome do arquivo — e é exatamente assim que se constrói um IDOR.
   ========================================================================== */
"use strict";

const { ulid, ehUlid } = require("../../../dominio/ids.js");
const { agora } = require("../banco.js");
const cripto = require("../../seguranca/cripto.js");

function criar(Q) {
  return {
    async criar({ conversaId, mensagemId, enviadoPor, nome, tipoMime, tamanho,
                  caminho, hash, largura = null, altura = null, miniatura = "" }) {
      const id = ulid();
      await Q.run(
        `INSERT INTO anexos (id, mensagem_id, conversa_id, enviado_por, nome, tipo_mime,
                             tamanho, caminho, hash, largura, altura, miniatura, criado_em)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, mensagemId, conversaId, enviadoPor,
        /* O NOME ORIGINAL VAI CIFRADO. Nome de arquivo é conteúdo:
           "rescisao-joao-silva.pdf" conta a história inteira sem ninguém abrir
           nada. Cifrar o corpo e deixar o nome em claro seria trancar a porta
           e deixar o assunto escrito na janela. */
        cripto.cifrar(nome), tipoMime, tamanho, caminho, hash, largura, altura, miniatura, agora());
      return id;
    },

    /* ======================================================================
       A CONSULTA DO DOWNLOAD — onde o IDOR é fechado

       Devolve o anexo APENAS se quem pede for membro vivo da conversa dele.
       A conferência está no SQL, junto do dado, e não num `if` depois: um
       `if` esquecido em uma das rotas de download bastaria para vazar tudo, e
       rotas de download se multiplicam (arquivo, miniatura, prévia).
       ====================================================================== */
    async paraDownload(anexoId, usuarioId, contextoId) {
      if (!ehUlid(anexoId)) return null;
      const a = await Q.get(
        `SELECT a.*, c.contexto_id
           FROM anexos a
           JOIN conversas c ON c.id = a.conversa_id
           JOIN conversa_membros m ON m.conversa_id = a.conversa_id AND m.usuario_id = ?
          WHERE a.id = ?
            AND m.saiu_em IS NULL
            AND c.contexto_id = ?
            AND c.apagada_em IS NULL`,
        usuarioId, anexoId, contextoId);
      if (!a) return null;
      return {
        id: a.id,
        conversaId: a.conversa_id,
        mensagemId: a.mensagem_id,
        nome: cripto.decifrar(a.nome),
        tipo: a.tipo_mime,
        tamanho: Number(a.tamanho),
        caminho: a.caminho,
        hash: a.hash,
        miniatura: a.miniatura,
      };
    },

    /* ======================================================================
       OS ANEXOS QUE PODEM ENTRAR NESTA MENSAGEM

       Chamado ANTES de gravar a mensagem. Devolve só o que passa nas quatro
       condições — e é a lista devolvida, nunca a que o cliente mandou, que
       decide o que a mensagem carrega.

       A quarta condição (`conversa_id = ?`) fechou uma falha real: sem ela,
       dava para enviar um arquivo na conversa A e colá-lo numa mensagem da
       conversa B. O conteúdo não vazava — o download confere a conversa DO
       ANEXO —, mas a mensagem em B exibia um anexo que os membros de B
       recebiam 404 ao tentar baixar. Anexo fantasma na conversa errada.

       Devolve também o `tipo_mime` real, porque é ele — e não o que o cliente
       afirma — que decide se a mensagem é "imagem" ou "arquivo".
       ====================================================================== */
    async paraAnexar(ids, enviadoPor, conversaId) {
      const limpos = (ids || []).filter(ehUlid).slice(0, 10);
      if (!limpos.length) return [];
      const marcas = limpos.map(() => "?").join(",");
      return Q.all(
        `SELECT id, tipo_mime, tamanho FROM anexos
          WHERE id IN (${marcas})
            AND enviado_por = ?
            AND conversa_id = ?
            AND mensagem_id IS NULL`,
        ...limpos, enviadoPor, conversaId);
    },

    /* Anexo recém-enviado ainda não tem mensagem: o navegador envia o arquivo,
       recebe o id e só então manda a mensagem que o carrega. Amarrar os dois
       depois evita mensagem órfã aparecendo sem o anexo que a explica.

       As mesmas condições de `paraAnexar` são repetidas aqui de propósito: o
       UPDATE é o que arbitra a corrida entre dois envios simultâneos do mesmo
       anexo, e uma trava que só existisse na leitura teria uma janela. */
    async amarrarNaMensagem(anexoId, mensagemId, enviadoPor, conversaId) {
      const r = await Q.run(
        `UPDATE anexos SET mensagem_id = ?
          WHERE id = ? AND enviado_por = ? AND conversa_id = ? AND mensagem_id IS NULL`,
        mensagemId, anexoId, enviadoPor, conversaId);
      return r.linhas > 0;
    },

    /* Anexos que ficaram sem mensagem — a pessoa enviou o arquivo e desistiu de
       mandar. Sem esta faxina o disco cresce com lixo que ninguém vê. */
    async orfaos(idadeMs) {
      return Q.all(
        "SELECT id, caminho, miniatura FROM anexos WHERE mensagem_id IS NULL AND criado_em < ?",
        agora() - idadeMs);
    },

    async remover(id) {
      await Q.run("DELETE FROM anexos WHERE id = ?", id);
    },
  };
}

module.exports = { criar };
