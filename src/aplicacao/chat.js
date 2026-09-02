/* ==========================================================================
   aplicacao/chat.js — os casos de uso

   Esta camada é a única que sabe a ORDEM das coisas. Ela não sabe SQL (isso é
   dos repositórios), não sabe HTTP (isso é de `src/http`) e não sabe WebSocket
   (isso é do transporte). Ela sabe que enviar uma mensagem é:

       conferir limite → validar texto → conferir se é membro
       → gravar (transação) → anunciar no barramento → devolver

   Duas regras que valem para todo método daqui:

   1. TODA entrada vem de fora e é hostil até prova em contrário. `conversaId`
      é um id que o navegador escolheu; `seq` é um número que o navegador
      escolheu. Nada é usado antes de passar pela conferência de membro.

   2. A CONFERÊNCIA DE MEMBRO É A PRIMEIRA COISA, sempre. Não depois de ler a
      conversa, não junto com outra coisa: primeiro. É a diferença entre uma
      autorização e uma verificação que às vezes acontece.
   ========================================================================== */
"use strict";

const { erros } = require("../dominio/erros.js");
const { ehUlid } = require("../dominio/ids.js");
const texto = require("../dominio/texto.js");
const arquivos = require("../dominio/arquivos.js");
const { EVENTOS } = require("../infra/eventos/barramento.js");

/* ==========================================================================
   O SITE ESTÁ COM CONECTOR VELHO?

   O conector é um arquivo COPIADO para dentro de cada hospedeiro. Uma cópia
   atrasada não quebra nada — ela apenas deixa de mandar os campos que
   nasceram depois dela. A consequência é uma capacidade que some sem erro
   nenhum: o botão não aparece, o log fica limpo, e a causa está noutro
   repositório.

   Foi assim que a capacidade de criar reunião se perdeu: o chat na 0.19.0, o
   site com o conector 1.5, e o profissional sem a aba. Duas rodadas de
   investigação para descobrir que o arquivo certo estava no lugar errado.

   O aviso sai UMA VEZ por contexto, por subida. Repetir a cada login encheria
   o log e ensinaria a ignorá-lo — que é o destino de todo aviso frequente.
   ========================================================================== */
const VERSAO_CONECTOR_ESPERADA = "1.6";
const jaAvisadoDoConector = new Set();

function avisarSeConectorVelho(contexto, versao) {
  if (jaAvisadoDoConector.has(contexto)) return;
  const atual = String(versao || "");
  const [aM, am] = atual.split(".").map(Number);
  const [eM, em] = VERSAO_CONECTOR_ESPERADA.split(".").map(Number);
  const velho = !atual || aM < eM || (aM === eM && am < em);
  if (!velho) return;

  jaAvisadoDoConector.add(contexto);
  console.warn(
    "\n  ⚠  CONECTOR DESATUALIZADO em \"" + contexto + "\" — " +
    (atual || "anterior à 1.6") + " (esperado " + VERSAO_CONECTOR_ESPERADA + ")\n\n" +
    "     Uma cópia atrasada do conector não quebra nada: ela só deixa de\n" +
    "     mandar os campos novos, e a capacidade some sem erro — o botão não\n" +
    "     aparece e o log fica limpo.\n\n" +
    "     No projeto do chat:  node instalar-em.js ../<Projeto>\n" +
    "     Depois: commit e deploy DO SITE.\n");
}

function criarServico({ repos, conf, barramento, limites, armazenamento, sessoes, passes, ipEmHash }) {
  const L = conf.limites;
  const JANELA_EDICAO_MS = Math.max(1, Number(L.janelaEdicaoMin || 5)) * 60e3;

  /* ------------------------------------------------------------------------
     Atalhos que aparecem em quase todo caso de uso.
     ------------------------------------------------------------------------ */

  /* A porta única da autorização de conversa. Devolve a linha do membro (com
     `ultima_lida_seq` e `ultima_seq`), que é o que quem chamou quase sempre
     precisa em seguida.

     Recusa com 404 — nunca 403 — pelo motivo escrito em `erros.js`. */
  async function exigirMembro(sessao, conversaId) {
    if (!ehUlid(conversaId)) throw erros.naoEncontrado();
    const m = await repos.conversas.membroDe(sessao.contextoId, conversaId, sessao.usuarioId);
    if (!m) throw erros.naoEncontrado();
    return m;
  }

  function exigirLimite(chave, maximo, janelaMs, mensagem) {
    const r = limites.conferir(chave, { maximo, janelaMs });
    if (!r.ok) throw erros.demais(r.esperar, mensagem);
    return r;
  }

  const servico = {
    /* ======================================================================
       ENTRAR — troca o passe do hospedeiro por sessão própria (§18)
       ====================================================================== */
    /* ======================================================================
       SINCRONIZAR O ELENCO — quem existe no sistema do hospedeiro

       Resolve a partida a frio: sem isto, o chat só conhece quem já entrou
       nele, a primeira pessoa a abrir encontra "Ninguém por aqui ainda" e
       ninguém entra num chat vazio.

       Quem chama é o SERVIDOR do site, provando-se com o MESMO passe assinado
       do `entrar`. Não há privilégio novo: quem tem o segredo já poderia
       entrar como qualquer pessoa.

       O passe é DE USO ÚNICO aqui também. Sem isso, um passe capturado uma vez
       poderia ser repetido para reescrever nomes e cargos de todo mundo — que
       é pouco, mas é gratuito de impedir.
       ====================================================================== */
    async sincronizarElenco({ passe, usuarios, ip }) {
      const ipHash = ipEmHash(ip);
      exigirLimite(`elenco:${ipHash || "sem-ip"}`, 20, 60e3,
        "Muitas sincronizações. Aguarde um instante.");

      const conf = passes.conferir(passe);
      if (!conf.ok) {
        await repos.auditoria.registrar({
          contextoId: "", evento: "PASSE_RECUSADO", ipHash, detalhe: "elenco: " + conf.erro,
        });
        throw erros.naoAutenticado("Sincronização recusada.");
      }
      const inedito = await repos.sessoes.marcarPasseUsado(conf.jti, conf.expiraEm);
      if (!inedito) throw erros.naoAutenticado("Sincronização repetida.");

      if (!Array.isArray(usuarios)) throw erros.invalido("Elenco inválido.");
      /* Teto: o corpo já é limitado a 256 KB na rota, mas um teto explícito
         diz o limite em pessoas, que é o que o hospedeiro entende. */
      if (usuarios.length > 500) throw erros.invalido("Elenco grande demais (máximo 500).");

      await repos.usuarios.garantirContexto(conf.contexto, conf.contexto);

      /* Retrato ANTES. O hospedeiro reenvia o elenco de tempos em tempos e a
         cada mudança de usuário — sem comparar, ou se avisava toda tela a cada
         5 minutos à toa, ou não se avisava nunca e um funcionário novo só
         aparecia depois de um F5. */
      const antes = new Map(
        (await repos.usuarios.elenco(conf.contexto)).map((p) => [String(p.externo_id), p]));

      let n = 0;
      for (const u of usuarios) {
        /* Sem id ou sem nome, PULA em vez de estourar: um cadastro incompleto
           do lado do site não pode derrubar a sincronização dos outros sete. */
        if (!u || !u.id || !u.nome) continue;
        await repos.usuarios.garantir(conf.contexto, {
          id: String(u.id), nome: String(u.nome).slice(0, 120),
          /* A identidade que sobrevive à troca de conta de acesso — no
             BemEstar, o profissional. Ver o comentário longo em
             `repositorios/usuarios.js`: é o que impede o mesmo profissional
             de virar duas pessoas (e duas conversas) depois de recadastrado. */
          identidade: String(u.identidade || "").slice(0, 120),
          sobrenome: String(u.sobrenome || "").slice(0, 120),
          email: String(u.email || "").slice(0, 200),
          avatar: String(u.avatar || "").slice(0, 500),
          cargo: String(u.cargo || "").slice(0, 120),
          departamento: String(u.departamento || "").slice(0, 120),
          papel: u.papel === "admin" ? "admin" : "membro",
          /* A capacidade vem junto do elenco, não só do login: quem deixou de
             ser profissional no cadastro do cliente perde o botão na próxima
             sincronização, sem precisar entrar de novo. */
          podeSala: !!u.podeSala,
        });
        n++;
      }

      /* Quem sumiu da lista sai da lista. É o que faz "as pessoas do chat" ser
         "as pessoas do sistema", e não "as pessoas que algum dia existiram".
         Só roda com elenco não vazio — uma lista vazia é bem mais provável ser
         defeito do hospedeiro do que a empresa ter demitido todo mundo. */
      /* A LISTA DE PRESENTES LEVA AS DUAS CHAVES de cada pessoa: o id da conta
         e a identidade. O repositório confere as duas colunas, e mandar só uma
         desativaria quem está na lista — derrubando a sessão de quem não saiu
         de lugar nenhum. */
      const presentes = [];
      for (const u of usuarios) {
        if (!u || !u.id) continue;
        presentes.push(String(u.id));
        if (u.identidade) presentes.push(String(u.identidade));
      }
      const desativados = n
        ? await repos.usuarios.desativarAusentes(conf.contexto, presentes)
        : 0;

      const depois = await repos.usuarios.elenco(conf.contexto);
      const marca = (p) => `${p.nome}|${p.sobrenome || ""}|${p.cargo || ""}|${p.departamento || ""}|${p.papel}|${p.situacao}`;
      const mudou = depois.length !== antes.size ||
        depois.some((p) => {
          const a = antes.get(String(p.externo_id));
          return !a || marca(a) !== marca(p);
        });

      await repos.auditoria.registrar({
        contextoId: conf.contexto, evento: "ELENCO_SINCRONIZADO", ipHash,
        detalhe: `${n} pessoa(s)` + (desativados ? `, ${desativados} desativada(s)` : ""),
      });

      if (mudou) barramento.emitir(EVENTOS.ELENCO_MUDOU, { contextoId: conf.contexto });

      return { ok: true, sincronizados: n, desativados, mudou };
    },

    async entrar({ passe, ip, agente }) {
      const ipHash = ipEmHash(ip);

      /* Freio ANTES de conferir a assinatura. Sem ele, um roteiro pode
         martelar passes forjados de graça — cada tentativa custa um HMAC ao
         servidor, e nada ao atacante. */
      exigirLimite(`entrar:${ipHash || "sem-ip"}`, 30, 60e3,
        "Muitas tentativas de entrada. Aguarde um instante.");

      const conf1 = passes.conferir(passe);
      if (!conf1.ok) {
        await repos.auditoria.registrar({
          contextoId: "", evento: "PASSE_RECUSADO", ipHash, detalhe: conf1.erro,
        });
        throw erros.naoAutenticado("Não foi possível entrar no chat. Recarregue a página.");
      }

      /* USO ÚNICO. O INSERT é a trava: dois usos simultâneos do mesmo passe
         disputam a chave primária, e só um ganha. */
      const inedito = await repos.sessoes.marcarPasseUsado(conf1.jti, conf1.expiraEm);
      if (!inedito) {
        await repos.auditoria.registrar({
          contextoId: conf1.contexto, evento: "PASSE_RECUSADO", ipHash, detalhe: "repetido",
        });
        throw erros.naoAutenticado("Este acesso já foi usado. Recarregue a página.");
      }

      await repos.usuarios.garantirContexto(conf1.contexto, conf1.contexto);
      /* O passe vem da SESSÃO do hospedeiro, que em geral não sabe a foto da
         pessoa — vazio aqui é "não sei", nunca "apague". Sem esta linha, cada
         login apagava o avatar que o elenco tinha acabado de sincronizar.
         Quem limpa foto é o ELENCO, que é o cadastro inteiro. */
      avisarSeConectorVelho(conf1.contexto, conf1.versaoConector);

      const dadosDoPasse = { ...conf1.usuario };
      if (!dadosDoPasse.avatar) delete dadosDoPasse.avatar;
      const usuario = await repos.usuarios.garantir(conf1.contexto, dadosDoPasse);

      if (usuario.situacao !== "ativa")
        throw erros.semPermissao("Seu acesso ao chat está desativado.");

      const { token, sessaoId, cookies } = await sessoes.abrir({
        usuarioId: usuario.id, ipHash, agente,
      });

      await repos.auditoria.registrar({
        contextoId: conf1.contexto, usuarioId: usuario.id,
        evento: "SESSAO_ABERTA", alvoTipo: "sessao", alvoId: sessaoId, ipHash,
      });

      return { usuario, token, sessaoId, cookies };
    },

    async sair(req, sessao) {
      const cookies = await sessoes.encerrar(req);
      if (sessao) {
        await repos.auditoria.registrar({
          contextoId: sessao.contextoId, usuarioId: sessao.usuarioId, evento: "SESSAO_ENCERRADA",
        });
        /* Sair também fecha os sockets. Num computador compartilhado, deixar o
           canal aberto depois do "sair" faria a próxima pessoa continuar
           recebendo as mensagens de quem saiu. */
        barramento.emitir(EVENTOS.USUARIO_EXPULSO, { usuarioId: sessao.usuarioId, motivo: "saiu" });
      }
      return cookies;
    },

    /* ======================================================================
       QUEM SOU EU — o que a tela carrega ao abrir
       ====================================================================== */
    async eu(sessao) {
      const [usuario, prefs, status] = await Promise.all([
        repos.usuarios.porId(sessao.contextoId, sessao.usuarioId),
        repos.usuarios.preferencias(sessao.usuarioId),
        repos.presenca.de(sessao.usuarioId),
      ]);
      if (!usuario) throw erros.naoAutenticado();
      return {
        usuario, preferencias: prefs, status: status.status, statusManual: status.manual,
        limites: {
          tamanhoMensagem: L.tamanhoMensagem,
          tamanhoArquivo: conf.arquivos.tamanhoMaximo,
          /* A JANELA VAI PARA A TELA, em vez de ser repetida lá.

             O lápis só pode aparecer enquanto a edição for aceita. Se o cliente
             guardasse o próprio "5 minutos", mudar aqui deixaria a tela
             oferecendo um botão que o servidor recusa — e o pior tipo de botão
             é o que promete e o sistema desmente. É o mesmo número, vindo de um
             lugar só. */
          janelaEdicaoMs: JANELA_EDICAO_MS,
        },
        /* O toque desta INSTALAÇÃO, e não desta pessoa: é o que faz o chat
           do Instituto soar diferente do da clínica na mesma mesa. Vem do
           servidor porque só ele sabe em qual instância está rodando. */
        toque: conf.toque || "padrao",
      };
    },

    /* ======================================================================
       CONVERSAS
       ====================================================================== */
    async listarConversas(sessao) {
      const lista = await repos.conversas.doUsuario(sessao.contextoId, sessao.usuarioId, L.porPagina);

      /* O status de todos os interlocutores numa consulta só. Um por linha
         seriam 50 idas ao banco para desenhar uma barra lateral. */
      const ids = [...new Set(lista.flatMap((c) => c.membros.map((m) => m.id)))];
      const status = await repos.presenca.deVarios(ids);
      for (const c of lista) {
        for (const m of c.membros) m.status = status.get(m.id)?.status || "offline";
        if (c.outro) {
          c.outro.status = status.get(c.outro.id)?.status || "offline";
          c.outro.vistoEm = status.get(c.outro.id)?.vistoEm || 0;
        }
      }
      return lista;
    },

    async abrirDireta(sessao, outroUsuarioId) {
      if (!ehUlid(outroUsuarioId)) throw erros.invalido("Pessoa inválida.");

      exigirLimite(`conversa:${sessao.usuarioId}`, L.conversasPorHora, 3600e3);

      /* O OUTRO tem de existir NO MESMO CONTEXTO. Sem esta conferência,
         mandar o id de alguém de outra empresa criaria uma conversa entre
         contextos — e o isolamento do §22 cairia por uma rota lateral. */
      const outro = await repos.usuarios.porId(sessao.contextoId, outroUsuarioId);
      if (!outro) throw erros.naoEncontrado("Pessoa não encontrada.");
      if (outro.situacao !== "ativa") throw erros.invalido("Esta pessoa não está mais no chat.");

      const conversa = await repos.conversas.abrirDireta(
        sessao.contextoId, sessao.usuarioId, outroUsuarioId);

      barramento.emitir(EVENTOS.CONVERSA_CRIADA, {
        conversaId: conversa.id, contextoId: sessao.contextoId,
        membros: [sessao.usuarioId, outroUsuarioId],
      });
      return { id: conversa.id, tipo: conversa.tipo, outro };
    },

    async criarGrupo(sessao, { titulo, membros }) {
      exigirLimite(`conversa:${sessao.usuarioId}`, L.conversasPorHora, 3600e3);

      const nome = String(titulo || "").trim().slice(0, 80);
      if (!nome) throw erros.invalido("Dê um nome ao grupo.");

      const ids = [...new Set((membros || []).filter(ehUlid))];
      if (!ids.length) throw erros.invalido("Escolha pelo menos uma pessoa.");
      if (ids.length > 200) throw erros.invalido("Um grupo aceita no máximo 200 pessoas.");

      /* Todos precisam ser do mesmo contexto — a consulta já filtra por ele,
         então quem não for simplesmente não volta, e a contagem denuncia. */
      const encontrados = await repos.usuarios.porIds(sessao.contextoId, ids);
      if (encontrados.length !== ids.length)
        throw erros.invalido("Uma das pessoas escolhidas não está disponível.");

      const conversa = await repos.conversas.criarGrupo(
        sessao.contextoId, sessao.usuarioId, nome, ids);

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "CONVERSA_CRIADA", alvoTipo: "conversa", alvoId: conversa.id,
      });
      barramento.emitir(EVENTOS.CONVERSA_CRIADA, {
        conversaId: conversa.id, contextoId: sessao.contextoId,
        membros: [...ids, sessao.usuarioId],
      });
      return { id: conversa.id, tipo: "grupo", titulo: nome };
    },

    /* ======================================================================
       HISTÓRICO — cursor, nunca offset (§26)
       ====================================================================== */
    async historico(sessao, conversaId, { antesDeSeq = null, limite } = {}) {
      const membro = await exigirMembro(sessao, conversaId);

      const n = Math.min(L.tetoPorPagina, Number(limite) || L.porPagina);
      const cursor = antesDeSeq === null || antesDeSeq === undefined ? null : Number(antesDeSeq);
      if (cursor !== null && !Number.isFinite(cursor)) throw erros.invalido("Cursor inválido.");

      const mensagens = await repos.mensagens.historico(conversaId, { antesDeSeq: cursor, limite: n });
      const anexos = await repos.mensagens.anexosDe(mensagens.map((m) => m.id));
      for (const m of mensagens) m.anexos = anexos.get(m.id) || [];

      const marcas = await repos.conversas.marcasDosOutros(conversaId, sessao.usuarioId);

      return {
        mensagens,
        marcas,
        minhaLeitura: Number(membro.ultima_lida_seq || 0),
        ultimaSeq: Number(membro.ultima_seq || 0),
        /* `temMais` sai de "veio a página cheia", e não de uma contagem total:
           contar o histórico inteiro a cada rolagem seria varrer a tabela para
           responder algo que a próxima página responde de graça. */
        temMais: mensagens.length === n && mensagens[0]?.seq > 1,
        proximoCursor: mensagens.length ? mensagens[0].seq : null,
      };
    },

    /* RETOMADA após reconexão (§25) — o caso que o `seq` existe para servir. */
    async sincronizar(sessao, conversaId, desdeSeq) {
      const membro = await exigirMembro(sessao, conversaId);
      const desde = Number(desdeSeq) || 0;

      const ultima = Number(membro.ultima_seq || 0);
      /* Buraco grande demais: mandar 40.000 mensagens de uma vez derruba a aba
         e ocupa o servidor. Acima do teto, a tela recarrega pelo caminho
         normal, paginado — e sabe disso pelo campo `recarregar`. */
      if (ultima - desde > 500) return { recarregar: true, ultimaSeq: ultima };

      const mensagens = await repos.mensagens.desde(conversaId, desde);
      const anexos = await repos.mensagens.anexosDe(mensagens.map((m) => m.id));
      for (const m of mensagens) m.anexos = anexos.get(m.id) || [];

      return {
        recarregar: false,
        mensagens,
        ultimaSeq: ultima,
        marcas: await repos.conversas.marcasDosOutros(conversaId, sessao.usuarioId),
      };
    },

    /* ======================================================================
       ENVIAR MENSAGEM — o caminho mais quente do sistema
       ====================================================================== */
    async enviarMensagem(sessao, { conversaId, texto: bruto, idCliente, respondeA = null, anexos = [] }) {
      const membro = await exigirMembro(sessao, conversaId);

      exigirLimite(`msg:${sessao.usuarioId}`, L.mensagensPorMinuto, 60e3,
        "Você está enviando mensagens rápido demais. Aguarde alguns segundos.");

      const temAnexo = Array.isArray(anexos) && anexos.length > 0;

      /* Mensagem só com anexo é legítima — a validação de texto só se aplica
         quando há texto. Exigir texto faria enviar uma foto sozinha ser
         impossível. */
      let corpo = "";
      if (bruto !== undefined && bruto !== null && String(bruto).trim() !== "") {
        const v = texto.validarMensagem(bruto, { tamanhoMaximo: L.tamanhoMensagem });
        if (!v.ok) throw erros.invalido(v.erro);
        corpo = v.texto;
      } else if (!temAnexo) {
        throw erros.invalido("Escreva algo ou anexe um arquivo.");
      }

      if (respondeA && !ehUlid(respondeA)) throw erros.invalido("Resposta inválida.");
      if (respondeA) {
        /* A mensagem respondida tem de ser DESTA conversa. Sem esta
           conferência, dá para amarrar uma resposta a uma mensagem de outra
           conversa e, ao renderizar a citação, vazar conteúdo alheio. */
        const alvo = await repos.mensagens.porId(conversaId, respondeA);
        if (!alvo) throw erros.invalido("A mensagem que você respondeu não existe mais.");
      }

      /* ======================================================================
         OS ANEXOS SÃO CONFERIDOS NO BANCO, NÃO ACEITOS DO CLIENTE.

         O corpo da requisição traz `[{id, ehImagem}]`. O `ehImagem` era usado
         para decidir o tipo da mensagem — ou seja, o cliente afirmava e o
         servidor acreditava. Um PDF podia ser anunciado como imagem.

         Agora a consulta devolve os anexos que REALMENTE existem, são desta
         pessoa, desta conversa e ainda não foram usados. O tipo sai do
         `tipo_mime` gravado no envio, que por sua vez saiu da conferência dos
         BYTES. O que o cliente diz não participa da decisão.
         ====================================================================== */
      let anexosValidos = [];
      if (temAnexo) {
        const pedidos = anexos.map((a) => (typeof a === "string" ? a : a?.id)).filter(Boolean);
        anexosValidos = await repos.anexos.paraAnexar(pedidos, sessao.usuarioId, conversaId);

        /* Pediu anexo e nenhum sobreviveu à conferência: recusa em vez de
           gravar uma mensagem vazia que o autor acha que levou o arquivo. */
        if (!anexosValidos.length)
          throw erros.invalido("O arquivo não está mais disponível para envio. Tente anexar de novo.");
      }

      const temAnexoValido = anexosValidos.length > 0;
      const tipo = temAnexoValido
        ? (anexosValidos.every((a) => String(a.tipo_mime).startsWith("image/")) ? "imagem" : "arquivo")
        : "texto";

      const { mensagem, repetida } = await repos.mensagens.enviar({
        contextoId: sessao.contextoId,
        conversaId,
        autorId: sessao.usuarioId,
        corpo,
        tipo,
        idCliente: String(idCliente || "").slice(0, 40),
        respondeA,
      });

      /* Reenvio reconhecido: devolve a mesma mensagem e NÃO anuncia de novo.
         Anunciar faria a mensagem aparecer duas vezes na tela de quem já a
         tinha recebido — o defeito que a deduplicação existe para evitar. */
      if (repetida) return { mensagem, repetida: true };

      if (temAnexoValido) {
        for (const a of anexosValidos) {
          await repos.anexos.amarrarNaMensagem(a.id, mensagem.id, sessao.usuarioId, conversaId);
        }
        mensagem.anexos = (await repos.mensagens.anexosDe([mensagem.id])).get(mensagem.id) || [];
      }

      const membros = await repos.conversas.idsDosMembros(conversaId);

      barramento.emitir(EVENTOS.MENSAGEM_ENVIADA, {
        contextoId: sessao.contextoId, conversaId, mensagem, membros, autorId: sessao.usuarioId,
      });

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "MENSAGEM_ENVIADA", alvoTipo: "conversa", alvoId: conversaId,
      });

      return { mensagem, repetida: false, membros };
    },

    /* ======================================================================
       LEITURA E ENTREGA
       ====================================================================== */
    async marcarLida(sessao, conversaId, ateSeq) {
      const membro = await exigirMembro(sessao, conversaId);
      const pedido = Number(ateSeq);
      if (!Number.isFinite(pedido) || pedido < 0) throw erros.invalido("Posição inválida.");

      /* ======================================================================
         A MARCA NÃO PASSA DA ÚLTIMA MENSAGEM QUE EXISTE.

         Sem o teto, qualquer membro podia mandar `seq: 999999` e:

           · fazer o AUTOR ver "✓✓ lida" em mensagens que ainda nem foram
             escritas — a marca de leitura é calculada pelo MENOR valor entre
             os outros membros, então um número absurdo marca tudo como lido
             para sempre, inclusive o que vier depois;
           · deixar a própria contagem de não lidas presa em zero.

         Não é vazamento de conteúdo, mas é falsificação de um sinal que as
         pessoas usam para decidir coisas ("ele já leu, então já sabe").
         ====================================================================== */
      const teto = Number(membro.ultima_seq || 0);
      const seq = Math.min(pedido, teto);

      await repos.conversas.marcarLida(conversaId, sessao.usuarioId, seq);
      const membros = await repos.conversas.idsDosMembros(conversaId);

      barramento.emitir(EVENTOS.MENSAGEM_LIDA, {
        conversaId, usuarioId: sessao.usuarioId, ateSeq: seq, membros,
      });
      return { ok: true };
    },

    async marcarEntregue(sessao, conversaId, ateSeq) {
      await exigirMembro(sessao, conversaId);
      await repos.conversas.marcarEntregue(conversaId, sessao.usuarioId, Number(ateSeq) || 0);
      return { ok: true };
    },

    /* ======================================================================
       APAGAR E EDITAR (§55, §56)
       ====================================================================== */
    async apagarMensagem(sessao, conversaId, mensagemId) {
      await exigirMembro(sessao, conversaId);
      const m = await repos.mensagens.porId(conversaId, mensagemId);
      if (!m) throw erros.naoEncontrado();

      /* Só o autor apaga — ou o admin do contexto. Um membro qualquer apagando
         a mensagem de outro seria censura sem trilha; o admin deixa trilha na
         auditoria, que é o que torna o poder aceitável. */
      if (m.autorId !== sessao.usuarioId && !sessao.ehAdmin)
        throw erros.semPermissao("Você só pode apagar as suas mensagens.");

      await repos.mensagens.apagar(conversaId, mensagemId, sessao.usuarioId);

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "MENSAGEM_APAGADA", alvoTipo: "mensagem", alvoId: mensagemId,
        detalhe: m.autorId === sessao.usuarioId ? "propria" : "por admin",
      });

      barramento.emitir(EVENTOS.MENSAGEM_APAGADA, {
        conversaId, mensagemId, seq: m.seq,
        membros: await repos.conversas.idsDosMembros(conversaId),
      });
      return { ok: true };
    },

    async editarMensagem(sessao, conversaId, mensagemId, novoTexto) {
      await exigirMembro(sessao, conversaId);
      const m = await repos.mensagens.porId(conversaId, mensagemId);
      if (!m) throw erros.naoEncontrado();
      if (m.autorId !== sessao.usuarioId)
        throw erros.semPermissao("Você só pode editar as suas mensagens.");

      /* Sem limite, editar vira reescrever a história: alguém combina algo hoje
         e muda a mensagem semana que vem. A janela está em `config.js`, com o
         porquê do número.

         A conta é sobre `criadaEm`, e não sobre `editadaEm`: senão cada edição
         renovaria o prazo, e editar de cinco em cinco minutos manteria a
         mensagem editável para sempre. */
      if (Date.now() - m.criadaEm > JANELA_EDICAO_MS)
        throw erros.invalido(
          "Mensagens só podem ser editadas nos primeiros " + L.janelaEdicaoMin + " minutos.");

      const v = texto.validarMensagem(novoTexto, { tamanhoMaximo: L.tamanhoMensagem });
      if (!v.ok) throw erros.invalido(v.erro);

      const atualizada = await repos.mensagens.editar(conversaId, mensagemId, sessao.usuarioId, v.texto);
      if (!atualizada) throw erros.invalido("Não foi possível editar esta mensagem.");

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "MENSAGEM_EDITADA", alvoTipo: "mensagem", alvoId: mensagemId,
      });
      barramento.emitir(EVENTOS.MENSAGEM_EDITADA, {
        conversaId, mensagem: atualizada,
        membros: await repos.conversas.idsDosMembros(conversaId),
      });
      return atualizada;
    },

    /* ======================================================================
       BUSCA (§16)
       ====================================================================== */
    async buscar(sessao, consulta, { conversaId = null } = {}) {
      exigirLimite(`busca:${sessao.usuarioId}`, L.buscasPorMinuto, 60e3);

      const termo = String(consulta || "").trim().slice(0, 200);
      if (termo.length < 2) return { pessoas: [], mensagens: [], palavras: [] };

      if (conversaId) await exigirMembro(sessao, conversaId);

      const [pessoas, mensagens] = await Promise.all([
        repos.usuarios.buscar(sessao.contextoId, termo),
        repos.mensagens.buscar(sessao.contextoId, sessao.usuarioId, termo, { conversaId }),
      ]);

      return {
        pessoas: pessoas.filter((p) => p.id !== sessao.usuarioId),
        mensagens,
        /* Quais palavras o índice conseguiu usar. A tela mostra isso — busca
           que descarta metade do que a pessoa digitou sem avisar devolve
           resultado errado com cara de certo. */
        palavras: repos.indice.palavrasUteis(termo),
      };
    },

    /* ======================================================================
       PESSOAS E PRESENÇA
       ====================================================================== */
    async pessoas(sessao, termo) {
      const lista = termo
        ? await repos.usuarios.buscar(sessao.contextoId, termo)
        : await repos.usuarios.listar(sessao.contextoId);
      const semEu = lista.filter((p) => p.id !== sessao.usuarioId);
      const status = await repos.presenca.deVarios(semEu.map((p) => p.id));
      for (const p of semEu) {
        p.status = status.get(p.id)?.status || "offline";
        p.vistoEm = status.get(p.id)?.vistoEm || 0;
      }
      return semEu;
    },

    /* ======================================================================
       ARQUIVAR — para mim, e para mais ninguém

       Some da MINHA lista. Os colegas continuam vendo a conversa como antes,
       e a próxima mensagem a traz de volta para todo mundo que a arquivou
       (ver `desarquivarTodos` no repositório).

       Não confundir com SILENCIAR, que já existia: aquela cala o aviso e
       mantém a conversa na lista. São dois desejos diferentes — "não me
       avise" e "tire da frente".
       ====================================================================== */
    async arquivarConversa(sessao, conversaId, arquivar) {
      if (sessao.ehConvidado) throw erros.semPermissao();
      const membro = await repos.conversas.membroDe(sessao.contextoId, conversaId, sessao.usuarioId);
      if (!membro) throw erros.naoEncontrado();
      await repos.conversas.arquivar(conversaId, sessao.usuarioId, !!arquivar);
      return { ok: true, arquivada: !!arquivar };
    },

    /* ======================================================================
       REMOVER — a conversa inteira, e só o administrador

       É a única operação deste chat que age sobre o histórico dos OUTROS.
       Por isso: exige administrador, avisa todo mundo que estiver com ela
       aberta, e fica na auditoria com quem fez.

       E NÃO APAGA LINHA NENHUMA — marca. A conversa e as mensagens continuam
       no banco, invisíveis. Um clique errado aqui não pode ser definitivo.
       ====================================================================== */
    async removerConversa(sessao, conversaId) {
      if (sessao.ehConvidado) throw erros.semPermissao();
      if (!sessao.ehAdmin)
        throw erros.semPermissao("Só um administrador pode remover uma conversa.");

      const conversa = await repos.conversas.porId(sessao.contextoId, conversaId);
      if (!conversa) throw erros.naoEncontrado();
      if (conversa.apagada_em) return { ok: true, jaEstava: true };

      /* Os membros ANTES de remover: depois disso a consulta não os alcança,
         e é para eles que o aviso precisa ir. */
      const paraIds = await repos.conversas.idsDosMembros(conversaId);

      await repos.conversas.apagar(conversaId, sessao.usuarioId);

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "CONVERSA_REMOVIDA", alvoTipo: "conversa", alvoId: conversaId,
        detalhe: `${paraIds.length} membros`,
      });

      barramento.emitir(EVENTOS.CONVERSA_REMOVIDA, {
        contextoId: sessao.contextoId, conversaId, paraIds, por: sessao.usuarioId,
      });

      return { ok: true };
    },

    async definirStatus(sessao, status) {
      if (!["online", "ocupado", "ausente", "offline"].includes(status))
        throw erros.invalido("Status inválido.");
      await repos.presenca.definirManual(sessao.usuarioId, status);
      barramento.emitir(EVENTOS.USUARIO_STATUS, {
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId, status,
      });
      return { status };
    },

    async atualizarPreferencias(sessao, prefs) {
      const p = await repos.usuarios.atualizarPreferencias(sessao.usuarioId, prefs || {});
      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId, evento: "PERFIL_ATUALIZADO",
      });
      return p;
    },

    async perfilDe(sessao, usuarioId) {
      if (!ehUlid(usuarioId)) throw erros.naoEncontrado();
      const u = await repos.usuarios.porId(sessao.contextoId, usuarioId);
      if (!u) throw erros.naoEncontrado("Pessoa não encontrada.");
      const s = await repos.presenca.de(usuarioId);
      return { ...u, status: s.status, vistoEm: s.vistoEm };
    },

    /* ======================================================================
       DIGITANDO (§53)

       NÃO passa pelo banco. É um aviso efêmero que expira sozinho em segundos;
       gravá-lo seria uma escrita por tecla digitada por pessoa — o caminho
       mais barato para derrubar o banco de um chat.
       ====================================================================== */
    async digitando(sessao, conversaId) {
      await exigirMembro(sessao, conversaId);
      /* Freio próprio, e generoso: o cliente já faz throttle, mas um cliente
         modificado não faz. 20 avisos por minuto é mais que suficiente para o
         cliente honesto (que manda 1 a cada 3 s) e barra o roteiro. */
      const r = limites.conferir(`digit:${sessao.usuarioId}`, { maximo: 20, janelaMs: 60e3 });
      if (!r.ok) return { ok: false };

      barramento.emitir(EVENTOS.USUARIO_DIGITANDO, {
        conversaId, usuarioId: sessao.usuarioId, nome: sessao.nome,
        membros: await repos.conversas.idsDosMembros(conversaId),
      });
      return { ok: true };
    },

    /* ======================================================================
       ARQUIVOS (§10, §11)
       ====================================================================== */
    async enviarArquivo(sessao, { conversaId, nome, tipo, buffer }) {
      await exigirMembro(sessao, conversaId);
      exigirLimite(`upload:${sessao.usuarioId}`, L.uploadsPorHora, 3600e3);

      const veredito = arquivos.conferir({
        nome, tipoDeclarado: tipo, buffer, tamanho: buffer.length,
        tiposPermitidos: conf.arquivos.tiposPermitidos,
        tamanhoMaximo: conf.arquivos.tamanhoMaximo,
      });

      if (!veredito.ok) {
        await repos.auditoria.registrar({
          contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
          evento: "ARQUIVO_RECUSADO", alvoTipo: "conversa", alvoId: conversaId,
          /* O detalhe técnico vai para a auditoria; a pessoa recebe só o
             motivo em português. */
          detalhe: `${veredito.erro}${veredito.detalhe ? " · " + veredito.detalhe : ""}`,
        });
        throw erros.invalido(veredito.erro);
      }

      const guardado = await armazenamento.gravar(buffer, { sufixo: "bin" });

      const anexoId = await repos.anexos.criar({
        conversaId, mensagemId: null, enviadoPor: sessao.usuarioId,
        nome: veredito.nome, tipoMime: veredito.tipo, tamanho: guardado.tamanho,
        caminho: guardado.caminho, hash: guardado.hash,
      });

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "ARQUIVO_ENVIADO", alvoTipo: "anexo", alvoId: anexoId,
        detalhe: `${veredito.tipo} ${guardado.tamanho}B`,
      });

      barramento.emitir(EVENTOS.ARQUIVO_ENVIADO, { conversaId, anexoId, usuarioId: sessao.usuarioId });

      return {
        id: anexoId, nome: veredito.nome, tipo: veredito.tipo,
        tamanho: guardado.tamanho, ehImagem: !!veredito.ehImagem,
      };
    },

    /* O DOWNLOAD — onde o IDOR do §11 é fechado.

       A autorização está dentro da consulta (ver `anexos.paraDownload`), então
       trocar o id na URL devolve 404 em vez de o arquivo de outra conversa. */
    async baixarArquivo(sessao, anexoId, { previa = false } = {}) {
      const a = await repos.anexos.paraDownload(anexoId, sessao.usuarioId, sessao.contextoId);
      if (!a) throw erros.naoEncontrado("Arquivo não encontrado.");

      /* ====================================================================
         A PRÉVIA SÓ EXISTE PARA IMAGEM DE VERDADE.

         Ela é servida INLINE, com o tipo real — é o que permite a bolha
         mostrar a foto em vez de um link. E isso só é seguro por causa de
         duas coisas que já aconteceram ANTES, no envio:

           · `image/svg+xml` NÃO está na lista branca. SVG com <script>
             dentro executaria no domínio do chat, com o cookie de quem abriu.
           · os BYTES foram conferidos: o arquivo é mesmo um PNG/JPEG/WebP/GIF,
             e não um HTML com nome de imagem.

         Sem essas duas, servir inline seria abrir XSS armazenado. Com elas, o
         conjunto que sai daqui é fechado e conhecido.
         ==================================================================== */
      if (previa && !String(a.tipo).startsWith("image/"))
        throw erros.naoEncontrado("Este arquivo não tem prévia.");

      if (!(await armazenamento.existe(a.caminho))) {
        /* O registro existe e o arquivo não. Vira erro claro no log em vez de
           um fluxo vazio que a tela mostra como download de 0 byte. */
        throw erros.naoEncontrado("Este arquivo não está mais disponível.");
      }

      /* A prévia NÃO é auditada. Ela dispara a cada rolagem que traz a bolha
         de volta à tela — auditar encheria a tabela com milhares de linhas que
         não respondem a pergunta nenhuma. O DOWNLOAD, que é o ato de levar o
         arquivo embora, continua auditado. */
      if (!previa) {
        await repos.auditoria.registrar({
          contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
          evento: "ARQUIVO_BAIXADO", alvoTipo: "anexo", alvoId: a.id,
        });
      }

      return { anexo: a, fluxo: armazenamento.fluxo(a.caminho), previa };
    },

    /* ======================================================================
       ADMINISTRAÇÃO (§30)
       ====================================================================== */
    async bloquearUsuario(sessao, usuarioId, bloquear) {
      if (!sessao.ehAdmin) throw erros.semPermissao();
      if (usuarioId === sessao.usuarioId)
        throw erros.invalido("Você não pode bloquear a si mesmo.");

      const ok = await repos.usuarios.definirSituacao(
        sessao.contextoId, usuarioId, bloquear ? "bloqueada" : "ativa");
      if (!ok) throw erros.naoEncontrado();

      /* ======================================================================
         BLOQUEAR TEM DE DERRUBAR O QUE JÁ ESTÁ ABERTO — as DUAS coisas.

         Apagar a sessão do banco corta o HTTP na requisição seguinte. Mas o
         WebSocket já estava autenticado: ele foi aceito no aperto de mão e
         não consulta a sessão a cada evento. Sem o segundo passo, a pessoa
         bloqueada continuava RECEBENDO MENSAGENS EM TEMPO REAL — o bloqueio
         parecia funcionar (ela não conseguia escrever nem recarregar) e
         vazava tudo pelo canal que ninguém fechou.

         Encontrado na auditoria de segurança, com sonda que enviou uma
         mensagem depois do bloqueio e conferiu que ela chegava.
         ====================================================================== */
      if (bloquear) {
        await repos.sessoes.encerrarDoUsuario(usuarioId);
        barramento.emitir(EVENTOS.USUARIO_EXPULSO, { usuarioId, motivo: "bloqueado" });
      }

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: bloquear ? "USUARIO_BLOQUEADO" : "USUARIO_LIBERADO",
        alvoTipo: "usuario", alvoId: usuarioId,
      });
      return { ok: true };
    },

    async auditoria(sessao, filtros) {
      if (!sessao.ehAdmin) throw erros.semPermissao();
      return repos.auditoria.listar(sessao.contextoId, filtros || {});
    },

    exigirMembro,
  };

  return servico;
}

module.exports = { criarServico };
