/* ==========================================================================
   testes/fusao.cjs — juntar duas fichas da mesma pessoa

       node testes/fusao.cjs

   Suíte própria porque a fusão é a única operação do sistema que NÃO TEM
   VOLTA: ela move histórico de conversa entre pessoas. Um erro aqui não dá
   erro na tela — dá conversa de um aparecendo na barra lateral do outro, que
   é exatamente o que um chat corporativo não pode fazer.

   Roda em banco de brinquedo, criado e apagado aqui. Nenhuma linha desta
   suíte chega perto de banco de cliente.
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { criarPlacar } = require("./ajuda.cjs");
const { abrir, agora } = require("../src/infra/dados/banco.js");
const { migrar } = require("../src/infra/dados/migrar.js");
const { ulid } = require("../src/dominio/ids.js");
const { chaveDireta } = require("../src/infra/dados/repositorios/conversas.js");
const { planejar, aplicar, normal } = require("../ferramentas/fundir-pessoas.cjs");

const CTX = "zz-qa-fusao";

async function semear(Q) {
  const t = agora();
  const pessoa = async (externo, identidade, nome) => {
    const id = ulid();
    await Q.run(
      `INSERT INTO usuarios (id, contexto_id, externo_id, identidade, nome, sobrenome, email,
                             avatar, cargo, departamento, papel, situacao,
                             ultimo_acesso, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, '', '', '', '', '', 'membro', 'ativa', ?, ?, ?)`,
      id, CTX, externo, identidade, nome, t, t, t);
    return id;
  };

  const direta = async (a, b) => {
    const id = ulid();
    await Q.run(
      `INSERT INTO conversas (id, contexto_id, tipo, titulo, chave_direta, criada_por,
                              criada_em, ultima_seq, ultima_mensagem_em)
       VALUES (?, ?, 'direta', '', ?, ?, ?, 0, ?)`,
      id, CTX, chaveDireta(CTX, a, b), a, t, t);
    for (const u of [a, b])
      await Q.run(
        `INSERT INTO conversa_membros (conversa_id, usuario_id, papel, entrou_em)
         VALUES (?, ?, 'membro', ?)`, id, u, t);
    return id;
  };

  let relogio = t;
  const dizer = async (conversa, autor, corpo) => {
    const atual = await Q.get("SELECT ultima_seq FROM conversas WHERE id = ?", conversa);
    const seq = Number(atual.ultima_seq) + 1;
    const id = ulid();
    relogio += 1000;
    await Q.run(
      `INSERT INTO mensagens (id, conversa_id, contexto_id, autor_id, seq, tipo, corpo,
                              formato, id_cliente, criada_em)
       VALUES (?, ?, ?, ?, ?, 'texto', ?, 'md', ?, ?)`,
      id, conversa, CTX, autor, seq, corpo, "c" + seq, relogio);
    await Q.run("INSERT INTO mensagem_tokens (mensagem_id, conversa_id, token) VALUES (?, ?, ?)",
      id, conversa, "tk" + seq);
    await Q.run("UPDATE conversas SET ultima_seq = ?, ultima_mensagem_em = ? WHERE id = ?",
      seq, relogio, conversa);
    return id;
  };

  return { pessoa, direta, dizer };
}

async function rodar() {
  const P = criarPlacar("Fusão");
  const arquivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lachat-fusao-")), "t.db");
  const Q = abrir({ motor: "sqlite", arquivo });
  await migrar({ Q, silencioso: true });

  try {
    await Q.run(
      "INSERT INTO contextos (id, nome, ativo, criado_em) VALUES (?, ?, 1, ?)",
      CTX, "QA", agora());
    const { pessoa, direta, dizer } = await semear(Q);

    /* ====================================================================
       O CASO REAL DO BEMESTARCLINIC

       O profissional tinha a conta 81 e conversava com a Ana. A conta foi
       removida, a pessoa reativada, e o cliente criou a conta 171 para ela.
       Resultado: duas fichas, duas conversas com a Ana — uma com o histórico
       e outra com o que foi dito depois.
       ==================================================================== */
    const ana = await pessoa("ana", "prof-1", "ZZ QA Ana");
    const velha = await pessoa("81", "", "ZZ QA Luiz");
    const nova = await pessoa("171", "prof-9", "ZZ QA Luiz");

    const antiga = await direta(ana, velha);
    await dizer(antiga, ana, "bom dia");
    await dizer(antiga, velha, "bom dia, tudo certo");
    await dizer(antiga, ana, "fechado");

    const recente = await direta(ana, nova);
    await dizer(recente, ana, "voltou?");
    await dizer(recente, nova, "voltei");

    /* ==================================================================== */
    P.secao("o plano é lido antes de mexer");

    const de = await Q.get("SELECT * FROM usuarios WHERE id = ?", velha);
    const para = await Q.get("SELECT * FROM usuarios WHERE id = ?", nova);
    const plano = await planejar(Q, de, para);

    P.eq(plano.juntar.filter((j) => j.destino).length, 1,
      "reconhece que a conversa velha tem destino: a conversa nova com a mesma Ana");
    P.eq(plano.mudarChave.length, 0, "e que ela não é caso de só trocar de dono");
    P.eq(plano.autoria, 1, "conta a mensagem que muda de autor");

    /* Planejar não pode escrever nada — é o que o humano roda para decidir. */
    P.eq(Number((await Q.get(
      "SELECT COUNT(*) AS n FROM mensagens WHERE conversa_id = ?", antiga)).n), 3,
      "planejar NÃO mexeu no banco");

    /* ==================================================================== */
    P.secao("a fusão junta o histórico");

    await aplicar(Q, de, para, plano);

    const msgs = await Q.all(
      "SELECT seq, corpo, autor_id FROM mensagens WHERE conversa_id = ? ORDER BY seq", recente);
    P.eq(msgs.length, 5, "as cinco mensagens estão numa conversa só");
    P.eq(msgs.map((m) => m.corpo).join("|"),
      "voltou?|voltei|bom dia|bom dia, tudo certo|fechado",
      "o histórico velho entra DEPOIS do recente, na ordem em que foi dito");
    P.eq(msgs.map((m) => Number(m.seq)).join(","), "1,2,3,4,5",
      "a numeração é contínua — é ela que o cliente usa para paginar e retomar");
    P.ok(!msgs.some((m) => m.autor_id === velha), "nenhuma mensagem ficou com a ficha velha");

    const conv = await Q.get("SELECT ultima_seq FROM conversas WHERE id = ?", recente);
    P.eq(Number(conv.ultima_seq), 5, "a conversa sabe qual é a última seq");

    const tk = await Q.get(
      `SELECT COUNT(*) AS n FROM mensagem_tokens t
        WHERE t.conversa_id = ?`, recente);
    P.eq(Number(tk.n), 5, "o índice de busca acompanhou — senão a busca não acha o que é antigo");

    const sobrou = await Q.get(
      "SELECT COUNT(*) AS n FROM mensagens WHERE conversa_id = ?", antiga);
    P.eq(Number(sobrou.n), 0, "a conversa velha ficou vazia");
    const velhaConv = await Q.get("SELECT apagada_em, chave_direta FROM conversas WHERE id = ?", antiga);
    P.ok(!!velhaConv.apagada_em, "e marcada como apagada");
    P.eq(velhaConv.chave_direta, null,
      "a chave direta foi solta: senão a próxima conversa entre os dois esbarra no índice único");

    const lista = await Q.all(
      `SELECT c.id FROM conversa_membros m JOIN conversas c ON c.id = m.conversa_id
        WHERE m.usuario_id = ? AND c.apagada_em IS NULL`, ana);
    P.eq(lista.length, 1, "a Ana passa a ver UMA conversa, não duas");

    /* ==================================================================== */
    P.secao("a ficha velha não volta sozinha");

    const morta = await Q.get("SELECT * FROM usuarios WHERE id = ?", velha);
    P.eq(morta.situacao, "desativada", "a ficha que saiu é desativada");
    P.eq(morta.identidade, "", "e larga a identidade, que agora é de uma ficha só");
    P.ok(morta.externo_id.startsWith("fundido:"),
      "e larga a conta: o hospedeiro mandando o id 81 de novo não pode ressuscitar a ficha vazia");
    P.ok(morta.externo_id !== "81", "o id antigo está livre e não aponta mais para lugar nenhum");

    const sessoes = await Q.get(
      "SELECT COUNT(*) AS n FROM sessoes WHERE usuario_id = ?", velha);
    P.eq(Number(sessoes.n), 0, "as sessões da ficha velha morreram");

    /* ====================================================================
       AS CERCAS

       O programa recusa o que não pode dar certo. Não é conforto: fundir
       fichas de contextos diferentes mistura DUAS EMPRESAS.
       ==================================================================== */
    P.secao("o que a ferramenta se recusa a fazer");

    P.ok(normal("José") === normal("jose "), "o nome confere sem acento e sem caixa");
    P.ok(normal("Jose") !== normal("Josefa"), "mas não confunde nomes diferentes");

    /* ====================================================================
       GRUPO — as duas fichas dentro do mesmo grupo

       Se a inscrição velha só mudasse de dono, a chave primária
       (conversa, usuário) colidiria e a fusão morreria no meio.
       ==================================================================== */
    P.secao("grupo com as duas fichas dentro");

    const g = ulid();
    const t = agora();
    await Q.run(
      `INSERT INTO conversas (id, contexto_id, tipo, titulo, chave_direta, criada_por,
                              criada_em, ultima_seq, ultima_mensagem_em)
       VALUES (?, ?, 'grupo', 'ZZ QA Time', NULL, ?, ?, 0, ?)`, g, CTX, ana, t, t);
    const outra = await pessoa("300", "prof-30", "ZZ QA Outro");
    const terceira = await pessoa("301", "", "ZZ QA Outro");
    for (const u of [ana, outra, terceira])
      await Q.run(
        `INSERT INTO conversa_membros (conversa_id, usuario_id, papel, entrou_em)
         VALUES (?, ?, 'membro', ?)`, g, u, t);

    const de2 = await Q.get("SELECT * FROM usuarios WHERE id = ?", terceira);
    const para2 = await Q.get("SELECT * FROM usuarios WHERE id = ?", outra);
    const plano2 = await planejar(Q, de2, para2);
    P.eq(plano2.soltarMembro.length, 1, "vê que as duas fichas já estão no grupo");
    P.eq(plano2.moverMembro.length, 0, "e que não há inscrição a mover");

    await aplicar(Q, de2, para2, plano2);
    const membros = await Q.all(
      "SELECT usuario_id FROM conversa_membros WHERE conversa_id = ?", g);
    P.eq(membros.length, 2, "o grupo fica com duas pessoas, sem inscrição duplicada");
    P.ok(!membros.some((m) => m.usuario_id === terceira), "a ficha velha saiu do grupo");
  } finally {
    if (Q.fechar) await Q.fechar();
    try { fs.rmSync(path.dirname(arquivo), { recursive: true, force: true }); } catch { }
  }

  return P;
}

rodar().then((P) => process.exit(P.fim() ? 0 : 1)).catch((e) => {
  console.error("\n  EXPLODIU:", e.message, "\n", e);
  process.exit(1);
});
