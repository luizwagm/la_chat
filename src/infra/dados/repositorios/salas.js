/* ==========================================================================
   repositorios/salas.js — a sala por link

   ---------------------------------------------------------------------------
   POR QUE CADA SALA TEM UMA CONVERSA

   A autorização de chamada deste sistema é uma frase só: **quem entra é membro
   da conversa**. Ela vive dentro do SQL, tem suíte de segurança em cima e é
   usada por todas as rotas de reunião.

   A sala anônima poderia ter inventado uma autorização própria — e aí seriam
   DUAS respostas para "quem pode entrar nesta chamada", que é exatamente como
   nasce a porta que aceita quem a outra recusa.

   Em vez disso, a sala cria uma conversa e põe nela o anfitrião; cada convidado
   que entra vira membro. `exigirMembro` continua sendo a única porta, sem uma
   linha de exceção.

   O que separa o convidado do funcionário NÃO é a conversa: é a SESSÃO. Ver
   seguranca/convidado.js — ela autoriza uma sala e nada mais.
   ========================================================================== */
"use strict";

const { ulid, ehUlid } = require("../../../dominio/ids.js");
const { agora } = require("../banco.js");
const cripto = require("../../seguranca/cripto.js");
const dom = require("../../../dominio/salas.js");

function criar(Q) {
  const repo = {
    /* ======================================================================
       CRIAR

       O código é gerado aqui e devolvido UMA vez para quem chamou montar o
       link. No banco ficam duas formas dele:

         · o HASH, que é por onde se acha a sala. Igual ao token de sessão: o
           banco guarda algo que serve para conferir, não para entrar.
         · o CIFRADO, para o anfitrião reabrir o link depois sem que um dump
           vazado entregue sala nenhuma.

       A colisão de código é tratada pelo índice único, e não por uma consulta
       antes: entre o SELECT e o INSERT cabe outra requisição. Com 58^11 ela
       nunca vai acontecer — e é justamente por isso que o tratamento tem de
       ser automático, porque ninguém testaria esse caminho à mão.
       ====================================================================== */
    async criar({ contextoId, criadaPor, conversaId, titulo, duracaoMin,
                  validadeH, exigeAnfitriao = true, maxConvidados = 5 }) {
      const t = agora();

      for (let tentativa = 0; tentativa < 5; tentativa++) {
        const codigo = dom.gerarCodigo();
        const id = ulid();
        try {
          await Q.run(
            `INSERT INTO salas (id, contexto_id, codigo_hash, codigo_cifrado, criada_por,
                                titulo, duracao_min, expira_em, exige_anfitriao,
                                max_convidados, estado, conversa_id, criada_em)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberta', ?, ?)`,
            id, contextoId, dom.hashDoCodigo(codigo), cripto.cifrar(codigo), criadaPor,
            cripto.cifrar(String(titulo || "")), duracaoMin,
            t + validadeH * 3600e3, exigeAnfitriao ? 1 : 0, maxConvidados, conversaId, t);

          return { sala: await repo.porIdCru(id), codigo };
        } catch (e) {
          /* Só a colisão de código justifica tentar de novo. Qualquer outro
             erro (coluna faltando, banco fora) tem de subir na hora — repetir
             cinco vezes um erro real só atrasa o diagnóstico. */
          if (!/UNIQUE|duplicate/i.test(String(e.message))) throw e;
        }
      }
      throw new Error("não consegui gerar um código de sala livre");
    },

    /* ======================================================================
       ACHAR PELO CÓDIGO — o caminho de toda visita ao link

       A conferência de FORMA vem antes da consulta: um código fora do formato
       nunca deveria custar uma ida ao banco, nem virar chave de limitador.
       ====================================================================== */
    async porCodigo(codigo) {
      if (!dom.ehCodigo(codigo)) return null;
      return Q.get("SELECT * FROM salas WHERE codigo_hash = ?", dom.hashDoCodigo(codigo));
    },

    async porIdCru(id) {
      return Q.get("SELECT * FROM salas WHERE id = ?", id);
    },

    async porId(contextoId, id) {
      if (!ehUlid(id)) return null;
      return Q.get("SELECT * FROM salas WHERE id = ? AND contexto_id = ?", id, contextoId);
    },

    /* As salas de quem as criou. O código sai DECIFRADO aqui — é o dono
       pedindo o próprio link de volta, autenticado, na própria sessão. */
    async doUsuario(contextoId, usuarioId, { limite = 50 } = {}) {
      const linhas = await Q.all(
        `SELECT * FROM salas
          WHERE contexto_id = ? AND criada_por = ? AND estado <> 'revogada'
          ORDER BY criada_em DESC LIMIT ?`,
        contextoId, usuarioId, Math.min(200, limite));
      return linhas.map((s) => ({ ...s, codigo: cripto.decifrar(s.codigo_cifrado) }));
    },

    codigoDe: (sala) => (sala ? cripto.decifrar(sala.codigo_cifrado) : ""),
    tituloDe: (sala) => (sala ? cripto.decifrar(sala.titulo) : ""),

    /* ======================================================================
       ABRIR — o anfitrião entrou, o relógio começa

       `encerra_em` é gravado AQUI, e não calculado a cada leitura: o fim da
       reunião não pode depender de quem está perguntando nem de quantas vezes
       alguém recarregou a página. Uma vez decidido, é o mesmo instante para
       todo mundo.
       ====================================================================== */
    /* ====================================================================
       ABRIR — e REABRIR, que é o caso que faltava

       `estado IN ('aberta','ativa')`, e não só 'aberta'. A versão anterior
       recusava em silêncio a reabertura de uma sala VIVA: a aplicação criava
       uma chamada nova, este UPDATE não casava nenhuma linha, e a sala ficava
       apontando para a chamada MORTA.

       O estrago era invisível e permanente: o anfitrião entrava numa chamada
       que a sala não conhecia, e todo convidado que chegasse pelo link era
       posto na chamada velha — vendo "aguarde o anfitrião" para sempre, com o
       anfitrião a postos do outro lado.

       O PRAZO NÃO SE MEXE. Os dois `COALESCE` são o que garante isso: uma vez
       marcada a hora de acabar, reabrir quantas vezes for não a adia em um
       segundo. É o que faz "a reunião dura 30 minutos" ser uma afirmação sobre
       o tempo, e não sobre o número de aberturas.
       ==================================================================== */
    async abrir(salaId, chamadaId, duracaoMin) {
      const t = agora();
      const r = await Q.run(
        `UPDATE salas
            SET estado = 'ativa', chamada_id = ?,
                iniciada_em = COALESCE(iniciada_em, ?),
                encerra_em = COALESCE(encerra_em, ?)
          WHERE id = ? AND estado IN ('aberta','ativa')`,
        chamadaId, t, t + duracaoMin * 60_000, salaId);
      return r.linhas > 0;
    },

    /* ====================================================================
       PRORROGAR — soma sobre o prazo ATUAL, dentro do banco

       `encerra_em = encerra_em + ?`, e não um valor calculado fora e gravado
       por cima. Dois cliques quase simultâneos no botão de acrescentar
       somariam os dois; com o valor calculado antes, o segundo escreveria por
       cima do primeiro e um dos acréscimos sumiria sem ninguém notar.

       `estado = 'ativa'` no WHERE: sala que já acabou não se estica.
       ==================================================================== */
    async prorrogar(salaId, minutos) {
      const r = await Q.run(
        `UPDATE salas SET encerra_em = encerra_em + ?
          WHERE id = ? AND estado = 'ativa' AND encerra_em IS NOT NULL`,
        Math.round(minutos) * 60_000, salaId);
      return r.linhas > 0;
    },

    async encerrar(salaId, estado = "encerrada") {
      const r = await Q.run(
        `UPDATE salas SET estado = ?, encerrada_em = ?
          WHERE id = ? AND estado IN ('aberta','ativa')`,
        estado, agora(), salaId);
      if (r.linhas) {
        /* Convidado não fica membro da conversa depois que a sala morre. Sem
           isto, quem entrou uma vez por um link continuaria na lista de membros
           para sempre — e receberia o que fosse dito ali depois. */
        await Q.run(
          `UPDATE conversa_membros SET saiu_em = ?
            WHERE conversa_id = (SELECT conversa_id FROM salas WHERE id = ?)
              AND usuario_id IN (SELECT usuario_id FROM sala_convidados WHERE sala_id = ?)`,
          agora(), salaId, salaId);
        await Q.run(
          "UPDATE sala_convidados SET saiu_em = COALESCE(saiu_em, ?) WHERE sala_id = ?",
          agora(), salaId);
      }
      return r.linhas > 0;
    },

    /* ======================================================================
       CONVIDADOS
       ====================================================================== */
    /* ====================================================================
       O CONVIDADO NASCE ESPERANDO

       O link dá acesso à FILA, não à reunião. Quem abre a porta é o anfitrião,
       e a decisão dele é sobre um nome concreto — não sobre "alguém tem o
       endereço".

       `entrou_em` é gravado agora, e não na aprovação: é o instante em que a
       pessoa PEDIU, e é dele que sai "esperando há dois minutos" na tela de
       quem decide.
       ==================================================================== */
    async registrarConvidado({ salaId, usuarioId, nome, ipHash, agente, estado = "esperando" }) {
      const id = ulid();
      await Q.run(
        `INSERT INTO sala_convidados (id, sala_id, usuario_id, nome, ip_hash, agente, entrou_em, estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, salaId, usuarioId, cripto.cifrar(String(nome || "")), ipHash,
        /* O agente é texto do cliente e pode vir com megabytes. Guardar sem
           teto é deixar o tamanho da tabela na mão de quem visita o link. */
        String(agente || "").slice(0, 200), agora(), estado);
      return id;
    },

    /* ====================================================================
       A DECISÃO DO ANFITRIÃO

       `WHERE estado = 'esperando'` não é enfeite: dois cliques no mesmo pedido
       — ou um "aceitar" logo depois de um "negar" — não podem reabrir uma
       decisão já tomada. Quem chega depois recebe `false` e a tela se acerta.
       ==================================================================== */
    async decidirConvidado(salaId, usuarioId, aceito) {
      const r = await Q.run(
        `UPDATE sala_convidados SET estado = ?, decidido_em = ?
          WHERE sala_id = ? AND usuario_id = ? AND estado = 'esperando'`,
        aceito ? "dentro" : "negado", agora(), salaId, usuarioId);
      return r.linhas > 0;
    },

    async estadoDoConvidado(salaId, usuarioId) {
      const r = await Q.get(
        "SELECT estado, expulso FROM sala_convidados WHERE sala_id = ? AND usuario_id = ?",
        salaId, usuarioId);
      if (!r) return null;
      return r.expulso ? "removido" : String(r.estado || "dentro");
    },

    /* Quantos esperam. Contagem, e não `pendentes().length`: quem chama isto é
       a porta, a cada pedido, e decifrar trinta nomes para chegar a um número
       é trabalho que o atacante escolheria de graça. */
    async quantosEsperando(salaId) {
      const r = await Q.get(
        "SELECT COUNT(*) AS n FROM sala_convidados WHERE sala_id = ? AND estado = 'esperando'",
        salaId);
      return Number(r?.n || 0);
    },

    /* A fila. Nome decifrado, porque é o que o anfitrião precisa ler para
       decidir — é exatamente para isso que ele foi pedido. */
    async pendentes(salaId) {
      const linhas = await Q.all(
        `SELECT id, usuario_id, nome, entrou_em FROM sala_convidados
          WHERE sala_id = ? AND estado = 'esperando' AND expulso = 0
          ORDER BY entrou_em`, salaId);
      return linhas.map((c) => ({
        id: c.id,
        usuarioId: c.usuario_id,
        nome: cripto.decifrar(c.nome),
        pediuEm: Number(c.entrou_em),
      }));
    },

    async convidados(salaId) {
      const linhas = await Q.all(
        `SELECT c.*, u.nome AS nome_usuario
           FROM sala_convidados c
           JOIN usuarios u ON u.id = c.usuario_id
          WHERE c.sala_id = ? ORDER BY c.entrou_em`, salaId);
      return linhas.map((c) => ({
        id: c.id,
        usuarioId: c.usuario_id,
        nome: cripto.decifrar(c.nome),
        entrouEm: Number(c.entrou_em),
        saiuEm: c.saiu_em ? Number(c.saiu_em) : null,
        expulso: !!c.expulso,
        estado: String(c.estado || "dentro"),
      }));
    },

    async quantosDentro(salaId) {
      const r = await Q.get(
        `SELECT COUNT(*) AS n FROM sala_convidados c
          /* estado = dentro: quem está na FILA não ocupa vaga. Contá-lo
           faria três pessoas esperando lotarem uma sala vazia — e o anfitrião
           não teria como aprovar nenhuma delas. */
        WHERE c.sala_id = ? AND c.saiu_em IS NULL AND c.expulso = 0
          AND c.estado = 'dentro'`, salaId);
      return Number(r?.n || 0);
    },

    async expulsar(salaId, usuarioId) {
      const r = await Q.run(
        `UPDATE sala_convidados SET expulso = 1, saiu_em = COALESCE(saiu_em, ?)
          WHERE sala_id = ? AND usuario_id = ?`, agora(), salaId, usuarioId);
      return r.linhas > 0;
    },

    /* Quem já foi expulso não volta pelo mesmo link. Sem esta conferência,
       "remover da reunião" seria um convite a recarregar a página. */
    async foiExpulso(salaId, usuarioId) {
      const r = await Q.get(
        "SELECT expulso FROM sala_convidados WHERE sala_id = ? AND usuario_id = ?",
        salaId, usuarioId);
      return !!r?.expulso;
    },

    /* ======================================================================
       FAXINA

       Salas que passaram do prazo, e reuniões que passaram da hora. Sem isto,
       uma sala anônima ficaria de pé indefinidamente — que é o oposto de tudo
       que este recurso precisa ser.
       ====================================================================== */
    /* ====================================================================
       ESTA CONVERSA É DE UMA SALA POR LINK?

       Pergunta feita uma vez por chamada, para decidir a política de
       transporte da mídia. Vale para a sala em QUALQUER estado, inclusive
       encerrada: o que importa é a natureza da conversa — nasceu para receber
       gente de fora —, e não o momento em que se pergunta.
       ==================================================================== */
    async ehDeSala(conversaId) {
      if (!conversaId) return false;
      const r = await Q.get("SELECT 1 AS s FROM salas WHERE conversa_id = ? LIMIT 1", conversaId);
      return !!r;
    },

    async vencidas() {
      const t = agora();
      return Q.all(
        `SELECT * FROM salas
          WHERE estado IN ('aberta','ativa')
            AND ( expira_em <= ? OR (encerra_em IS NOT NULL AND encerra_em <= ?) )`,
        t, t);
    },

    /* As que estão a ponto de acabar, para o aviso dos últimos minutos sair do
       servidor — e não do relógio do navegador, que a pessoa pode adiantar. */
    async paraAvisar(janelaMs) {
      const t = agora();
      return Q.all(
        `SELECT * FROM salas
          WHERE estado = 'ativa' AND encerra_em IS NOT NULL
            AND encerra_em > ? AND encerra_em <= ?`,
        t, t + janelaMs);
    },
  };

  return repo;
}

module.exports = { criar };
