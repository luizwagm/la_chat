#!/usr/bin/env node
/* ==========================================================================
   fundir-pessoas — junta duas fichas que são a MESMA pessoa

   ---------------------------------------------------------------------------
   PARA QUE SERVE

   O `externo_id` é o id da conta no hospedeiro, e conta é descartável. No
   BemEstarClinic o cliente removeu o usuário de um profissional, reativou a
   pessoa e criou uma conta NOVA para ela. Conta nova = pessoa nova aqui =
   conversa nova, e a barra lateral passou a mostrar duas linhas com o mesmo
   nome: uma com o histórico e outra vazia.

   A coluna `identidade` (migração 002) impede que isso volte a acontecer. Ela
   NÃO conserta o que já aconteceu: os dois registros já existem, cada um com
   suas conversas. Juntar é este programa.

   ---------------------------------------------------------------------------
   POR QUE É FERRAMENTA DE LINHA DE COMANDO, E NÃO BOTÃO NA TELA

   Fundir move o histórico de conversa de uma pessoa para outra e NÃO TEM
   VOLTA. Um clique errado numa lista de nomes parecidos mistura conversas de
   duas pessoas diferentes — e mensagem de chat corporativo é justamente o que
   não pode vazar de um para o outro. Então:

     • sem argumento nenhum, ele só RELATA os candidatos;
     • com dois ids, mostra o que faria e para;
     • só mexe no banco com `--aplicar`, e ainda pede o `--confirmo` com o
       nome da pessoa digitado por extenso.

   ---------------------------------------------------------------------------
   USO

     node ferramentas/fundir-pessoas.cjs                      # lista candidatos
     node ferramentas/fundir-pessoas.cjs --de X --para Y      # simula
     node ferramentas/fundir-pessoas.cjs --de X --para Y --aplicar --confirmo "Nome"

   `--para` é a ficha que FICA (a que tem a identidade certa e a conta atual).
   `--de` é a ficha que se dissolve.
   ========================================================================== */
"use strict";

const path = require("path");
const raiz = path.join(__dirname, "..");
const { CONF } = require(path.join(raiz, "config.js"));
const { abrir, agora } = require(path.join(raiz, "src/infra/dados/banco.js"));
const { migrar } = require(path.join(raiz, "src/infra/dados/migrar.js"));
const { ulid } = require(path.join(raiz, "src/dominio/ids.js"));
const { chaveDireta } = require(path.join(raiz, "src/infra/dados/repositorios/conversas.js"));

/* -------------------------------------------------------------- argumentos */
function lerArgs(argv) {
  const a = { aplicar: false, confirmo: "", de: "", para: "", contexto: "" };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--aplicar") a.aplicar = true;
    else if (t === "--de") a.de = String(argv[++i] || "");
    else if (t === "--para") a.para = String(argv[++i] || "");
    else if (t === "--confirmo") a.confirmo = String(argv[++i] || "");
    else if (t === "--contexto") a.contexto = String(argv[++i] || "");
  }
  return a;
}

const rotulo = (u) =>
  `${u.nome}${u.sobrenome ? " " + u.sobrenome : ""} ` +
  `[${u.id}] conta=${u.externo_id} identidade=${u.identidade || "—"} ${u.situacao}`;

/* ==========================================================================
   RELATÓRIO — quem parece ser a mesma pessoa duas vezes

   O critério é nome igual (sem acento, sem caixa) dentro do mesmo contexto.
   É de propósito FROUXO: aqui um falso positivo custa uma linha a mais para
   o humano ler, e um falso negativo esconde o problema que viemos resolver.
   Quem decide é quem lê.
   ========================================================================== */
const normal = (s) => String(s || "").normalize("NFD")
  .replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

async function relatar(Q, contexto) {
  const linhas = await Q.all(
    `SELECT id, contexto_id, externo_id, identidade, nome, sobrenome, situacao, criado_em
       FROM usuarios ${contexto ? "WHERE contexto_id = ?" : ""}
      ORDER BY contexto_id, nome, criado_em`,
    ...(contexto ? [contexto] : []));

  const grupos = new Map();
  for (const u of linhas) {
    const chave = `${u.contexto_id}|${normal(u.nome + " " + u.sobrenome)}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(u);
  }

  const repetidos = [...grupos.values()].filter((g) => g.length > 1);
  if (!repetidos.length) {
    console.log("Nenhum nome aparece duas vezes. Nada a fundir.");
    return;
  }

  console.log(`\n${repetidos.length} nome(s) aparecem mais de uma vez:\n`);
  for (const g of repetidos) {
    console.log(`  ${g[0].nome} ${g[0].sobrenome || ""} — contexto ${g[0].contexto_id}`);
    for (const u of g) {
      const msgs = await Q.get(
        "SELECT COUNT(*) AS n FROM mensagens WHERE autor_id = ?", u.id);
      const convs = await Q.get(
        "SELECT COUNT(*) AS n FROM conversa_membros WHERE usuario_id = ?", u.id);
      console.log(`     · ${rotulo(u)}  ${Number(msgs.n)} mensagens, ${Number(convs.n)} conversas`);
    }
    /* A sugestão aponta para quem TEM identidade — é a ficha que o hospedeiro
       reconhece hoje. Empatou, fica a mais nova (a conta em uso). */
    const fica = g.slice().sort((a, b) =>
      (b.identidade ? 1 : 0) - (a.identidade ? 1 : 0) || b.criado_em - a.criado_em)[0];
    for (const u of g) {
      if (u.id === fica.id) continue;
      console.log(`       → node ferramentas/fundir-pessoas.cjs --de ${u.id} --para ${fica.id}`);
    }
    console.log("");
  }
}

/* ==========================================================================
   O PLANO — o que a fusão faria, conversa por conversa

   Separado da execução de propósito: é ele que o humano lê antes de deixar
   mexer, e é ele que o teste confere sem escrever no banco.
   ========================================================================== */
async function planejar(Q, de, para) {
  const membros = await Q.all(
    `SELECT m.conversa_id, c.tipo, c.chave_direta, c.ultima_seq, c.titulo
       FROM conversa_membros m JOIN conversas c ON c.id = m.conversa_id
      WHERE m.usuario_id = ?`, de.id);

  const plano = { mudarChave: [], juntar: [], moverMembro: [], soltarMembro: [], mensagens: 0 };

  for (const conv of membros) {
    const jaEsta = await Q.get(
      "SELECT usuario_id FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?",
      conv.conversa_id, para.id);

    if (conv.tipo === "grupo") {
      /* Grupo é fácil: ou a pessoa que fica entra no lugar da que sai, ou já
         estava lá e a inscrição velha simplesmente some. */
      if (jaEsta) plano.soltarMembro.push(conv);
      else plano.moverMembro.push(conv);
      continue;
    }

    /* Direta: quem é a outra ponta? */
    const outros = await Q.all(
      "SELECT usuario_id FROM conversa_membros WHERE conversa_id = ? AND usuario_id <> ?",
      conv.conversa_id, de.id);
    const outro = outros.map((o) => o.usuario_id).find((id) => id !== para.id);

    /* Conversa da pessoa CONSIGO MESMA depois da fusão (a ficha velha falando
       com a nova). Não existe destino para ela: vira histórico órfão e o
       sistema recusa conversa consigo mesmo. Fica marcada e não se move. */
    if (!outro) { plano.juntar.push({ ...conv, outro: null, destino: null, consigo: true }); continue; }

    const chaveNova = chaveDireta(de.contexto_id, para.id, outro);
    const destino = await Q.get(
      "SELECT id, ultima_seq FROM conversas WHERE chave_direta = ? AND contexto_id = ?",
      chaveNova, de.contexto_id);

    if (destino && destino.id !== conv.conversa_id) {
      const n = await Q.get(
        "SELECT COUNT(*) AS n FROM mensagens WHERE conversa_id = ?", conv.conversa_id);
      plano.mensagens += Number(n.n);
      plano.juntar.push({ ...conv, outro, destino });
    } else {
      /* Não existe conversa equivalente: basta a conversa mudar de dono e de
         chave. Nada de mensagem se move — é o caminho barato e o mais comum. */
      plano.mudarChave.push({ ...conv, outro, chaveNova });
    }
  }

  const minhas = await Q.get("SELECT COUNT(*) AS n FROM mensagens WHERE autor_id = ?", de.id);
  plano.autoria = Number(minhas.n);
  return plano;
}

function imprimirPlano(plano, de, para) {
  console.log(`\n  ficha que SAI  : ${rotulo(de)}`);
  console.log(`  ficha que FICA : ${rotulo(para)}\n`);
  console.log(`  · ${plano.autoria} mensagem(ns) trocam de autor`);
  console.log(`  · ${plano.mudarChave.length} conversa(s) direta(s) mudam de dono sem mover nada`);
  console.log(`  · ${plano.juntar.filter((j) => j.destino).length} conversa(s) direta(s) são ` +
    `EMENDADAS numa já existente (${plano.mensagens} mensagens renumeradas)`);
  console.log(`  · ${plano.moverMembro.length} grupo(s) trocam a inscrição`);
  console.log(`  · ${plano.soltarMembro.length} grupo(s) já tinham as duas fichas dentro`);
  const consigo = plano.juntar.filter((j) => j.consigo);
  if (consigo.length)
    console.log(`  · ${consigo.length} conversa(s) entre as duas fichas ficam onde estão ` +
      `(viraria conversa consigo mesmo)`);
}

/* ==========================================================================
   A EXECUÇÃO

   Tudo dentro de uma transação: ou a pessoa fica inteira do outro lado, ou
   nada aconteceu. Meia fusão é pior que nenhuma — some da barra lateral de um
   e não aparece na do outro.
   ========================================================================== */
async function aplicar(Q, de, para, plano) {
  const t = agora();
  await Q.transacao(async () => {
    /* 1. Diretas que só mudam de dono. */
    for (const c of plano.mudarChave) {
      await Q.run("UPDATE conversas SET chave_direta = ? WHERE id = ?", c.chaveNova, c.conversa_id);
      await Q.run(
        "UPDATE conversa_membros SET usuario_id = ? WHERE conversa_id = ? AND usuario_id = ?",
        para.id, c.conversa_id, de.id);
    }

    /* 2. Diretas emendadas — as mensagens mudam de conversa e são renumeradas
          DEPOIS da última do destino, para o `seq` seguir estritamente
          crescente. Ordem por `criada_em` e não por `seq`: os dois lados
          numeram do 1, e a hora é a única linha do tempo comum. */
    for (const j of plano.juntar) {
      if (!j.destino) continue;
      const msgs = await Q.all(
        "SELECT id FROM mensagens WHERE conversa_id = ? ORDER BY criada_em ASC, seq ASC",
        j.conversa_id);
      let seq = Number(j.destino.ultima_seq);
      for (const m of msgs) {
        seq += 1;
        /* `id_cliente` TAMBÉM é reescrito. Ele é único por (conversa, autor,
           id_cliente) — é o que faz o clique duplo e a reconexão perderem no
           banco em vez de num `if`. Só que o valor vem do NAVEGADOR e é único
           por conversa, não no mundo: as duas conversas que estamos juntando
           têm um "c1" cada, do mesmo autor. Mover sem tocar nele estoura o
           índice no meio da fusão.

           Trocar pelo id da mensagem mantém a dedup viva (id de mensagem é
           único) e não perde nada: reenvio é coisa de segundos, e estas
           mensagens já estão gravadas há tempo. */
        await Q.run("UPDATE mensagens SET conversa_id = ?, seq = ?, id_cliente = ? WHERE id = ?",
          j.destino.id, seq, "fus:" + m.id, m.id);
        await Q.run("UPDATE mensagem_tokens SET conversa_id = ? WHERE mensagem_id = ?",
          j.destino.id, m.id);
        await Q.run("UPDATE anexos SET conversa_id = ? WHERE mensagem_id = ?",
          j.destino.id, m.id);
      }
      await Q.run(
        "UPDATE conversas SET ultima_seq = ?, ultima_mensagem_em = ? WHERE id = ?",
        seq, t, j.destino.id);

      /* A conversa esvaziada é marcada como apagada, não removida: `mensagens`
         aponta para ela com ON DELETE CASCADE, e um DELETE aqui num banco onde
         alguma mensagem tenha escapado levaria a mensagem junto. */
      await Q.run("UPDATE conversas SET apagada_em = ?, chave_direta = NULL WHERE id = ?",
        t, j.conversa_id);
      await Q.run("DELETE FROM conversa_membros WHERE conversa_id = ?", j.conversa_id);

      /* Quem fica não pode voltar com o selo de não lida de mensagem que ele
         mesmo já tinha lido do outro lado — mas também não pode perder as que
         não leu. A marca conservadora é a MENOR das duas. */
      const meu = await Q.get(
        "SELECT ultima_lida_seq FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?",
        j.destino.id, para.id);
      if (meu) {
        await Q.run(
          "UPDATE conversa_membros SET ultima_lida_seq = ? WHERE conversa_id = ? AND usuario_id = ?",
          Math.min(Number(meu.ultima_lida_seq), Number(j.destino.ultima_seq)),
          j.destino.id, para.id);
      }
    }

    /* 3. Grupos. */
    for (const g of plano.moverMembro)
      await Q.run(
        "UPDATE conversa_membros SET usuario_id = ? WHERE conversa_id = ? AND usuario_id = ?",
        para.id, g.conversa_id, de.id);
    for (const g of plano.soltarMembro)
      await Q.run("DELETE FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?",
        g.conversa_id, de.id);

    /* 4. Autoria e rastros. `criada_por` e `apagada_por` também: o nome de
          quem abriu a conversa aparece na tela. */
    await Q.run("UPDATE mensagens SET autor_id = ? WHERE autor_id = ?", para.id, de.id);
    await Q.run("UPDATE anexos SET enviado_por = ? WHERE enviado_por = ?", para.id, de.id);
    await Q.run("UPDATE conversas SET criada_por = ? WHERE criada_por = ?", para.id, de.id);
    await Q.run("UPDATE mensagens SET apagada_por = ? WHERE apagada_por = ?", para.id, de.id);

    /* Notificações pendentes seguem a pessoa; as já lidas somem com a ficha. */
    await Q.run("UPDATE notificacoes SET usuario_id = ? WHERE usuario_id = ? AND lida_em IS NULL",
      para.id, de.id);
    await Q.run("DELETE FROM notificacoes WHERE usuario_id = ?", de.id);

    /* 5. As sessões da ficha velha morrem. Quem estava logado por ela precisa
          entrar de novo — e vai entrar já na ficha certa. Deixar viva é deixar
          uma aba escrevendo numa pessoa que não existe mais. */
    await Q.run("DELETE FROM sessoes WHERE usuario_id = ?", de.id);

    /* 6. A ficha velha é desativada, e a `identidade` é liberada para não
          brigar com o índice único. O `externo_id` ganha um prefixo: sem isso,
          a conta antiga voltando do hospedeiro reviveria a ficha vazia e
          desfaria a fusão na sincronização seguinte. */
    await Q.run(
      `UPDATE usuarios SET situacao = 'desativada', identidade = '',
              externo_id = ?, atualizado_em = ? WHERE id = ?`,
      `fundido:${de.id}`, t, de.id);

    await Q.run(
      `INSERT INTO auditoria (id, contexto_id, usuario_id, evento, alvo_tipo, alvo_id,
                             detalhe, criado_em)
       VALUES (?, ?, ?, 'usuario.fundido', 'usuario', ?, ?, ?)`,
      ulid(), de.contexto_id, para.id, de.id,
      JSON.stringify({
        mensagens: plano.autoria,
        conversasMudadas: plano.mudarChave.length,
        conversasEmendadas: plano.juntar.filter((j) => j.destino).length,
      }), t);
  });
}

/* ------------------------------------------------------------------ entrada */
async function principal() {
  const a = lerArgs(process.argv.slice(2));
  const Q = abrir(CONF.banco);
  await migrar({ Q, silencioso: true });

  if (!a.de || !a.para) {
    await relatar(Q, a.contexto);
    console.log("Rode com --de <id> --para <id> para ver o que a fusão faria.\n");
    return;
  }

  const buscar = (id) => Q.get(
    `SELECT id, contexto_id, externo_id, identidade, nome, sobrenome, situacao
       FROM usuarios WHERE id = ?`, id);
  const de = await buscar(a.de);
  const para = await buscar(a.para);

  if (!de) throw new Error(`ficha --de ${a.de} não existe`);
  if (!para) throw new Error(`ficha --para ${a.para} não existe`);
  if (de.id === para.id) throw new Error("--de e --para são a mesma ficha");
  /* Fundir entre contextos misturaria empresas diferentes: é o pior erro
     possível neste programa, e por isso é uma parada e não um aviso. */
  if (de.contexto_id !== para.contexto_id)
    throw new Error(`fichas de contextos diferentes (${de.contexto_id} × ${para.contexto_id})`);

  const plano = await planejar(Q, de, para);
  imprimirPlano(plano, de, para);

  if (!a.aplicar) {
    console.log(`\n  Nada foi alterado. Para aplicar:\n` +
      `  node ferramentas/fundir-pessoas.cjs --de ${de.id} --para ${para.id} ` +
      `--aplicar --confirmo "${de.nome}"\n`);
    return;
  }

  /* O nome digitado é a última cerca: obriga a olhar QUEM está sendo
     dissolvido. Id de 26 caracteres embaralhados não faz ninguém desconfiar;
     um nome de pessoa faz. */
  if (normal(a.confirmo) !== normal(de.nome))
    throw new Error(`--confirmo precisa ser o nome da ficha que SAI ("${de.nome}")`);

  await aplicar(Q, de, para, plano);
  console.log(`\n  Fundido. ${de.nome} agora é uma ficha só.\n`);
}

/* `planejar` e `aplicar` recebem o `Q` de fora justamente para a suíte poder
   provar a fusão num banco de brinquedo, sem passar pela linha de comando e
   sem chegar perto do banco de ninguém. */
module.exports = { planejar, aplicar, relatar, normal };

if (require.main === module) {
  principal().then(() => process.exit(0)).catch((e) => {
    console.error("\n  ERRO:", e.message, "\n");
    process.exit(1);
  });
}
