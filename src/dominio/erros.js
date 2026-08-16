/* ==========================================================================
   dominio/erros.js (§57)

   Existe para separar duas coisas que costumam virar uma só:

     · a mensagem que a PESSOA lê  — curta, em português, sem culpa e sem
       jargão. "Você não participa desta conversa."
     · o detalhe TÉCNICO           — vai só para o log. Nome de tabela,
       consulta, id interno, pilha.

   Quando as duas se misturam, acontecem os dois defeitos ao mesmo tempo:
   o usuário vê `SQLITE_CONSTRAINT: UNIQUE constraint failed` e não entende
   nada, e o atacante vê o nome das tabelas e o caminho do arquivo no servidor.

   `ErroDoChat` é o que a aplicação lança de propósito: ele tem uma mensagem
   segura e um código HTTP. Qualquer OUTRO erro que chegar à camada HTTP é
   tratado como 500 com texto genérico — porque um erro não previsto é,
   por definição, um erro cujo texto ninguém revisou.
   ========================================================================== */
"use strict";

class ErroDoChat extends Error {
  constructor(mensagem, { status = 400, codigo = "erro", detalhe = "" } = {}) {
    super(mensagem);
    this.name = "ErroDoChat";
    this.status = status;
    this.codigo = codigo;
    /* O detalhe NUNCA vai na resposta. Ele existe para o log. */
    this.detalhe = detalhe;
    this.seguroParaUsuario = true;
  }
}

/* Atalhos para os casos que se repetem. Cada um com o status certo, porque
   status errado tem consequência real: um 200 com `{erro}` faz o cliente
   tratar falha como sucesso, e um 500 onde cabia 403 esconde da auditoria uma
   tentativa de acesso indevido. */
const erros = {
  naoAutenticado: (m = "Sua sessão expirou. Recarregue a página para entrar de novo.") =>
    new ErroDoChat(m, { status: 401, codigo: "sem_sessao" }),

  /* 404, e NÃO 403, para recurso de outra pessoa.

     Responder 403 ("existe, mas você não pode") confirma a existência do id —
     e com isso um atacante mapeia quais conversas existem só variando a URL.
     404 devolve a mesma resposta para "não existe" e "não é seu", e o mapa
     deixa de ser construível. */
  naoEncontrado: (m = "Não encontramos o que você pediu.") =>
    new ErroDoChat(m, { status: 404, codigo: "nao_encontrado" }),

  semPermissao: (m = "Você não tem permissão para isso.") =>
    new ErroDoChat(m, { status: 403, codigo: "sem_permissao" }),

  invalido: (m, detalhe = "") =>
    new ErroDoChat(m, { status: 400, codigo: "invalido", detalhe }),

  demais: (esperar, m) =>
    new ErroDoChat(m || `Você está indo rápido demais. Tente de novo em ${esperar}s.`,
      { status: 429, codigo: "limite", detalhe: `esperar=${esperar}` }),

  grandeDemais: (m = "O arquivo é grande demais.") =>
    new ErroDoChat(m, { status: 413, codigo: "grande_demais" }),

  indisponivel: (m = "O chat está indisponível no momento. Tente de novo em instantes.") =>
    new ErroDoChat(m, { status: 503, codigo: "indisponivel" }),
};

module.exports = { ErroDoChat, erros };
