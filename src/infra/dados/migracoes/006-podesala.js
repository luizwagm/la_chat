/* ==========================================================================
   006-podesala — quem pode criar reunião por link

   ---------------------------------------------------------------------------
   POR QUE UMA CAPACIDADE, E NÃO UM PAPEL NOVO

   O chat conhece dois papéis: `membro` e `admin`. Isso é deliberado, e está
   escrito em `seguranca/passe.js`: um papel LIVRE vindo do hospedeiro viraria
   escalonamento de privilégio no dia em que o site do cliente tivesse um bug.
   Por isso o que não é "admin" vira "membro" na fronteira.

   Mas os clientes têm mais de dois perfis. No BemEstar são três — administração,
   profissional de saúde e recepção — e o pedido é que os dois primeiros possam
   criar link de reunião, e a recepção não.

   A saída NÃO é alargar o papel. É o hospedeiro declarar uma CAPACIDADE:

       papel       "quem essa pessoa é no chat"        — fechado, dois valores
       pode_sala   "esta pessoa pode criar reunião?"   — sim ou não

   A diferença é o alcance do estrago. Um papel livre daria ao hospedeiro o
   poder de inventar privilégios que o chat não previu. Uma capacidade nomeada
   delega exatamente UMA decisão — a que o cliente quis mesmo delegar —, e o
   pior que um site com defeito consegue é deixar alguém criar um link.

   ---------------------------------------------------------------------------
   POR QUE FICA NO USUÁRIO, E NÃO NA SESSÃO

   A sessão é reconstruída a cada requisição a partir de um JOIN com `usuarios`;
   ela não guarda campos próprios. Guardar aqui é o que faz a capacidade
   sobreviver ao pedido seguinte — e é onde `papel` já mora, pela mesma razão.

   Ela é reescrita a cada login e a cada sincronização de elenco: quem deixa de
   ser profissional no cadastro do cliente deixa de poder criar link no próximo
   acesso, sem ninguém precisar lembrar de mexer aqui.
   ========================================================================== */
"use strict";

const versao = "006-podesala";

const sql = `
/* 0 = não pode. O padrão fechado é o que importa: numa base existente,
   ninguém ganha a capacidade por acidente — ela chega quando o hospedeiro
   passar a declará-la. */
ALTER TABLE usuarios ADD COLUMN pode_sala INTEGER NOT NULL DEFAULT 0;
`;

module.exports = { versao, sql };
