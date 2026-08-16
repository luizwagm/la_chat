/* ==========================================================================
   repositorios/usuarios.js

   O chat NÃO tem cadastro próprio de pessoas. Quem sabe quem trabalha na
   empresa é o hospedeiro; aqui existe apenas o REFLEXO dele, criado na
   primeira vez que a pessoa abre o chat e atualizado a cada entrada.

   Consequência prática: demitiu alguém no sistema do cliente? Ela para de
   receber passe e para de entrar. Não há uma segunda lista de usuários para
   alguém esquecer de atualizar — que é como contas fantasma sobrevivem anos.

   ---------------------------------------------------------------------------
   O QUE É CIFRADO AQUI, E O QUE NÃO É

   CIFRADO: e-mail. É dado pessoal e não é necessário para nenhuma consulta —
   ninguém busca colega por e-mail dentro do chat.

   NÃO CIFRADO: nome, cargo, departamento. Três motivos, nesta ordem:
     1. são exibidos para todos os colegas o tempo todo — não são segredo
        dentro da empresa;
     2. a busca da barra lateral procura por nome, e cifrado ela morreria (o
        índice cego serve para texto longo, não para lista de pessoas onde se
        espera achar "jo" digitando três letras);
     3. cifrar tudo sem critério é o que faz gente desligar a cifragem inteira
        quando ela atrapalha.

   Quem quiser o parque inteiro cifrado tem `cripto.cifrar` disponível — mas a
   troca (perder a busca por prefixo de nome) precisa ser consciente.
   ========================================================================== */
"use strict";

const { ulid } = require("../../../dominio/ids.js");
const { agora } = require("../banco.js");
const cripto = require("../../seguranca/cripto.js");

/* ==========================================================================
   O AVATAR VEM DE FORA, E VIRA `<img src>` NO NAVEGADOR DE TODOS OS COLEGAS.

   Ele chega no passe, assinado pelo hospedeiro. O hospedeiro é confiável por
   definição — mas "confiável" não é o mesmo que "livre de defeito": basta um
   campo de perfil mal validado no sistema do cliente para que um valor
   escolhido por um funcionário atravesse o passe e chegue aqui.

   `javascript:` num `src` de imagem não executa em navegador moderno, então o
   risco imediato é baixo. Os reais são outros: `data:` embute conteúdo
   arbitrário na página, e uma URL para servidor de terceiro faz cada abertura
   do chat delatar quem está online para quem controla aquele servidor.

   Lista branca de esquema, como em todo o resto do projeto.
   ========================================================================== */
function avatarSeguro(url) {
  const u = String(url || "").replace(/[\s\u0000-\u001F]/g, "");
  if (!u) return "";
  if (u.length > 500) return "";
  /* Caminho relativo do próprio hospedeiro é o caso mais comum e é seguro:
     ele resolve na origem da página, sem sair para lugar nenhum. */
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  return /^https?:\/\//i.test(u) ? u : "";
}

/* Colunas do usuário que saem para a tela. `email` nunca vai junto por padrão:
   a lista de colegas não precisa dele, e mandá-lo espalharia dado pessoal por
   toda resposta que devolve uma pessoa. */
const CAMPOS = `id, contexto_id, externo_id, nome, sobrenome, avatar, cargo,
                departamento, papel, situacao, ultimo_acesso, criado_em`;

function paraFora(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    externoId: linha.externo_id,
    nome: linha.nome,
    sobrenome: linha.sobrenome || "",
    nomeCompleto: [linha.nome, linha.sobrenome].filter(Boolean).join(" "),
    avatar: linha.avatar || "",
    cargo: linha.cargo || "",
    departamento: linha.departamento || "",
    papel: linha.papel,
    situacao: linha.situacao,
    ultimoAcesso: linha.ultimo_acesso || null,
    criadoEm: linha.criado_em,
    /* Só aparece quando a consulta pediu explicitamente. */
    ...(linha.email !== undefined ? { email: cripto.decifrar(linha.email) } : {}),
  };
}

function criar(Q) {
  return {
    /* ======================================================================
       GARANTIR CONTEXTO

       Criado na primeira vez que alguém daquele contexto aparece. Não há tela
       de "cadastrar empresa": o contexto vem do passe, e existir é
       consequência de alguém entrar.
       ====================================================================== */
    async garantirContexto(contextoId, nome) {
      const existe = await Q.get("SELECT id FROM contextos WHERE id = ?", contextoId);
      if (existe) return contextoId;
      await Q.run(
        "INSERT INTO contextos (id, nome, ativo, criado_em) VALUES (?, ?, 1, ?)",
        contextoId, nome || contextoId, agora());
      return contextoId;
    },

    /* ======================================================================
       GARANTIR USUÁRIO — o upsert que roda a cada entrada

       CORRIDA REAL: duas abas abrindo o chat no mesmo instante executam este
       método ao mesmo tempo. Sem tratamento, as duas leem "não existe" e as
       duas inserem — e a pessoa fica com DUAS identidades no chat, com as
       conversas divididas entre elas e nenhum erro na tela.

       Quem impede é o índice único (contexto_id, externo_id). O INSERT
       perdedor estoura, e aqui a gente RELÊ em vez de propagar: o resultado
       correto para quem chamou é "o usuário existe e é este", não um erro.
       ====================================================================== */
    async garantir(contextoId, dados) {
      const t = agora();
      const externo = String(dados.id);

      const achado = await Q.get(
        `SELECT ${CAMPOS} FROM usuarios WHERE contexto_id = ? AND externo_id = ?`,
        contextoId, externo);

      if (achado) {
        /* O hospedeiro é a fonte da verdade sobre nome, cargo e foto: se
           mudaram lá, mudam aqui. `papel` também — tirar o admin de alguém no
           sistema do cliente tem de tirar aqui na entrada seguinte. */
        /* `situacao = 'ativa'` no UPDATE: quem some do elenco é desativado (ver
           `desativarAusentes`), e quem VOLTA precisa voltar de verdade — sem
           isto, reativar um funcionário no sistema do cliente o deixaria mudo
           no chat, existindo na tabela e fora de toda lista. */
        await Q.run(
          `UPDATE usuarios SET nome = ?, sobrenome = ?, email = ?, avatar = ?,
                  cargo = ?, departamento = ?, papel = ?, situacao = 'ativa',
                  ultimo_acesso = ?, atualizado_em = ?
             WHERE id = ?`,
          dados.nome, dados.sobrenome || "", cripto.cifrar(dados.email || ""),
          avatarSeguro(dados.avatar), dados.cargo || "", dados.departamento || "",
          dados.papel === "admin" ? "admin" : "membro", t, t, achado.id);

        return paraFora({ ...achado, nome: dados.nome, sobrenome: dados.sobrenome || "" });
      }

      const id = ulid();
      try {
        await Q.run(
          `INSERT INTO usuarios (id, contexto_id, externo_id, nome, sobrenome, email,
                                 avatar, cargo, departamento, papel, situacao,
                                 ultimo_acesso, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ativa', ?, ?, ?)`,
          id, contextoId, externo, dados.nome, dados.sobrenome || "",
          cripto.cifrar(dados.email || ""), avatarSeguro(dados.avatar), dados.cargo || "",
          dados.departamento || "", dados.papel === "admin" ? "admin" : "membro", t, t, t);

        await Q.run(
          "INSERT INTO usuario_preferencias (usuario_id, atualizado_em) VALUES (?, ?)", id, t);
        await Q.run(
          "INSERT INTO usuario_status (usuario_id, manual, visto_em) VALUES (?, 'online', ?)", id, t);
      } catch (e) {
        /* Perdeu a corrida do índice único. Relê — a outra aba já criou. */
        const agoraSim = await Q.get(
          `SELECT ${CAMPOS} FROM usuarios WHERE contexto_id = ? AND externo_id = ?`,
          contextoId, externo);
        if (agoraSim) return paraFora(agoraSim);
        throw e;
      }

      return paraFora(await Q.get(`SELECT ${CAMPOS} FROM usuarios WHERE id = ?`, id));
    },

    /* ======================================================================
       LEITURA

       `contextoId` é parâmetro OBRIGATÓRIO em tudo que lê pessoa. Não é
       redundância: é o que faz uma consulta esquecida devolver vazio em vez
       de devolver gente de outra empresa (§22).
       ====================================================================== */
    async porId(contextoId, id) {
      return paraFora(await Q.get(
        `SELECT ${CAMPOS} FROM usuarios WHERE id = ? AND contexto_id = ?`, id, contextoId));
    },

    async porIds(contextoId, ids) {
      if (!ids?.length) return [];
      /* Os `?` são gerados pelo TAMANHO da lista, e os valores vão por
         parâmetro. Nunca por interpolação — é a diferença entre uma consulta
         parametrizada e um SQL Injection com nome bonito. */
      const marcas = ids.map(() => "?").join(",");
      const linhas = await Q.all(
        `SELECT ${CAMPOS} FROM usuarios WHERE contexto_id = ? AND id IN (${marcas})`,
        contextoId, ...ids);
      return linhas.map(paraFora);
    },

    /* Busca da barra lateral (§16).

       O termo é ESCAPADO para LIKE: sem isso, digitar `%` traria a empresa
       inteira e digitar `_` casaria qualquer caractere. Não é injeção — o
       valor vai por parâmetro —, mas é a pessoa conseguindo um resultado que a
       busca não pretendia oferecer, e num diretório corporativo isso é
       enumeração de funcionários. */
    async buscar(contextoId, termo, limite = 20) {
      const t = String(termo || "").trim();
      if (t.length < 2) return [];
      const escapado = t.replace(/[\\%_]/g, (c) => "\\" + c);
      const linhas = await Q.all(
        `SELECT ${CAMPOS} FROM usuarios
          WHERE contexto_id = ?
            AND situacao = 'ativa'
            AND (nome LIKE ? ESCAPE '\\' OR sobrenome LIKE ? ESCAPE '\\' OR departamento LIKE ? ESCAPE '\\')
          ORDER BY nome
          LIMIT ?`,
        contextoId, `%${escapado}%`, `%${escapado}%`, `%${escapado}%`, Math.min(50, limite));
      return linhas.map(paraFora);
    },

    /* ======================================================================
       O ELENCO — o retrato usado para comparar antes e depois

       Devolve o mínimo (quem, como se chama, que cargo tem, se está ativa),
       incluindo os INATIVOS. Serve a `sincronizarElenco`: sem saber o estado
       anterior não dá para dizer se algo mudou, e sem isso ou se avisa as
       telas a cada sincronização (ruído a cada 5 minutos) ou nunca se avisa.
       ====================================================================== */
    async elenco(contextoId) {
      return await Q.all(
        `SELECT externo_id, nome, sobrenome, cargo, departamento, papel, situacao
           FROM usuarios WHERE contexto_id = ? ORDER BY externo_id`, contextoId);
    },

    /* Quem não veio na lista do hospedeiro não trabalha mais lá. Desativar (e
       não apagar) preserva o histórico das conversas — as mensagens antigas
       continuam com autor, em vez de virarem "usuário desconhecido". */
    async desativarAusentes(contextoId, externosPresentes) {
      const presentes = [...new Set((externosPresentes || []).map(String))];
      if (!presentes.length) return 0;
      const marcas = presentes.map(() => "?").join(",");
      const alvos = await Q.all(
        `SELECT id FROM usuarios
          WHERE contexto_id = ? AND situacao = 'ativa' AND externo_id NOT IN (${marcas})`,
        contextoId, ...presentes);
      /* `desativada`, e não `bloqueada`: são coisas diferentes. Bloqueio é ato
         de moderação, feito por um admin dentro do chat; desativação é o
         reflexo do cadastro do hospedeiro, e volta sozinha se a pessoa voltar.
         O CHECK da tabela só aceita ativa/bloqueada/desativada — inventar um
         quarto valor derrubava a sincronização inteira com 500. */
      for (const a of alvos)
        await Q.run("UPDATE usuarios SET situacao = 'desativada', atualizado_em = ? WHERE id = ?",
          agora(), a.id);
      return alvos.length;
    },

    async listar(contextoId, limite = 200) {
      const linhas = await Q.all(
        `SELECT ${CAMPOS} FROM usuarios
          WHERE contexto_id = ? AND situacao = 'ativa'
          ORDER BY nome LIMIT ?`, contextoId, limite);
      return linhas.map(paraFora);
    },

    /* ======================================================================
       PERFIL (§7) — o que a própria pessoa pode mudar

       Curto de propósito. Nome, cargo e departamento vêm do hospedeiro e são
       reescritos na próxima entrada: deixar a pessoa editá-los aqui criaria a
       ilusão de ter mudado algo que volta sozinho no dia seguinte.
       ====================================================================== */
    async atualizarPreferencias(usuarioId, prefs) {
      const atual = await Q.get(
        "SELECT som, notificacoes, tema FROM usuario_preferencias WHERE usuario_id = ?", usuarioId);
      const som = prefs.som === undefined ? (atual?.som ?? 1) : (prefs.som ? 1 : 0);
      const notif = prefs.notificacoes === undefined ? (atual?.notificacoes ?? 1) : (prefs.notificacoes ? 1 : 0);
      const tema = ["sistema", "claro", "escuro"].includes(prefs.tema) ? prefs.tema : (atual?.tema || "sistema");

      if (!atual) {
        await Q.run(
          `INSERT INTO usuario_preferencias (usuario_id, som, notificacoes, tema, atualizado_em)
           VALUES (?, ?, ?, ?, ?)`, usuarioId, som, notif, tema, agora());
      } else {
        await Q.run(
          `UPDATE usuario_preferencias SET som = ?, notificacoes = ?, tema = ?, atualizado_em = ?
            WHERE usuario_id = ?`, som, notif, tema, agora(), usuarioId);
      }
      return { som: !!som, notificacoes: !!notif, tema };
    },

    async preferencias(usuarioId) {
      const p = await Q.get(
        "SELECT som, notificacoes, tema FROM usuario_preferencias WHERE usuario_id = ?", usuarioId);
      return { som: !!(p?.som ?? 1), notificacoes: !!(p?.notificacoes ?? 1), tema: p?.tema || "sistema" };
    },

    /* ======================================================================
       ADMINISTRAÇÃO (§30)

       Bloquear NÃO apaga nada. Apagar mensagem de quem foi desligado
       destruiria o histórico de quem conversou com a pessoa — que é registro
       da empresa, não propriedade de quem saiu.
       ====================================================================== */
    async definirSituacao(contextoId, usuarioId, situacao) {
      if (!["ativa", "bloqueada", "desativada"].includes(situacao))
        throw new Error("situação inválida");
      const r = await Q.run(
        "UPDATE usuarios SET situacao = ?, atualizado_em = ? WHERE id = ? AND contexto_id = ?",
        situacao, agora(), usuarioId, contextoId);
      return r.linhas > 0;
    },
  };
}

module.exports = { criar, paraFora, CAMPOS };
