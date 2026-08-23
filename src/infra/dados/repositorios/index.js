/* ==========================================================================
   repositorios/index.js — monta os repositórios sobre uma conexão

   Existe para que a suíte de testes possa montar TUDO contra um banco
   descartável passando um `Q` diferente. Sem este ponto único, testar exigiria
   variável de ambiente global e o teste passaria a depender da ordem em que
   os módulos foram carregados — que é como se ganha um teste que só falha na
   integração contínua.
   ========================================================================== */
"use strict";

const { criarIndice } = require("../../seguranca/indice-cego.js");

function montar(Q, { segredoBusca, registrarIp = true } = {}) {
  const indice = criarIndice(segredoBusca);

  return {
    Q,
    indice,
    usuarios: require("./usuarios.js").criar(Q),
    presenca: require("./presenca.js").criar(Q),
    conversas: require("./conversas.js").criar(Q),
    mensagens: require("./mensagens.js").criar(Q, indice),
    anexos: require("./anexos.js").criar(Q),
    chamadas: require("./chamadas.js").criar(Q),
    salas: require("./salas.js").criar(Q),
    sessoes: require("./sessoes.js").criar(Q),
    auditoria: require("./auditoria.js").criar(Q, { registrarIp }),
  };
}

module.exports = { montar };
