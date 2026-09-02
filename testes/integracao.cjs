/* ==========================================================================
   testes/integracao.cjs — o fluxo de verdade, por HTTP

       node testes/integracao.cjs

   Sobe o servidor numa porta própria, com banco descartável, e conversa com
   ele como o navegador conversaria: cookie, CSRF, JSON.
   ========================================================================== */
"use strict";

const { criarPlacar, subirChat, entrar, espera, pedir, emitirPasse } = require("./ajuda.cjs");

const ANA = { id: "func-001", nome: "ZZ QA Ana", sobrenome: "Ribeiro", email: "ana@zzqa.com",
              cargo: "Gerente", departamento: "Operações", papel: "admin" };
const BRUNO = { id: "func-002", nome: "ZZ QA Bruno", sobrenome: "Tavares", email: "bruno@zzqa.com",
                cargo: "Analista", departamento: "Financeiro" };
const CARLA = { id: "func-003", nome: "ZZ QA Carla", sobrenome: "Menezes" };

async function rodar() {
  const P = criarPlacar("Integração");
  const chat = await subirChat({ porta: 5297 });

  try {
    /* ==================================================================== */
    P.secao("entrada e sessão");

    const ana = await entrar(chat, ANA);
    P.ok(!!ana.usuario?.id, "Ana entrou com o passe do hospedeiro");
    P.eq(ana.usuario.nome, "ZZ QA Ana", "o nome veio do passe");
    P.ok(!!ana.potes.get("cid"), "cookie de sessão foi plantado");
    P.ok(!!ana.csrf(), "cookie de CSRF foi plantado");

    const eu = await ana.vai("/eu");
    P.eq(eu.status, 200, "/eu responde");
    P.eq(eu.dados.usuario.id, ana.usuario.id, "/eu devolve a própria pessoa");
    P.ok(eu.dados.usuario.email === undefined, "/eu NÃO devolve e-mail de brinde");

    const bruno = await entrar(chat, BRUNO);
    const carla = await entrar(chat, CARLA);
    P.ok(bruno.usuario.id !== ana.usuario.id, "Bruno é outra pessoa");

    /* Entrar de novo não cria pessoa nova. */
    const ana2 = await entrar(chat, ANA);
    P.eq(ana2.usuario.id, ana.usuario.id, "entrar duas vezes não duplica a pessoa");

    /* ==================================================================== */
    P.secao("pessoas");

    const pessoas = await ana.vai("/pessoas");
    P.eq(pessoas.status, 200, "lista de pessoas responde");
    P.ok(!pessoas.dados.pessoas.some((p) => p.id === ana.usuario.id), "a lista não me inclui");
    P.ok(pessoas.dados.pessoas.length >= 2, `a lista traz os colegas (${pessoas.dados.pessoas.length})`);

    const perfil = await ana.vai("/pessoas/" + bruno.usuario.id);
    P.eq(perfil.status, 200, "perfil de colega abre");
    P.eq(perfil.dados.cargo, "Analista", "o perfil traz o cargo");

    /* ====================================================================
       O ELENCO É O CADASTRO DO HOSPEDEIRO — inclusive quando alguém SAI

       A sincronização só sabia acrescentar. Uma pessoa desligada da empresa
       continuava na aba "Pessoas" para sempre, e a lista ia divergindo do
       sistema um pouco a cada mês — sem nunca dar erro.

       Desativar (e não apagar) preserva o histórico: as mensagens antigas
       continuam com autor. E quem volta a ser cadastrado volta a aparecer.
       ==================================================================== */
    const NOVATA = { id: "func-777", nome: "ZZ QA Novata", cargo: "Recepção" };
    /* A EQUIPE INTEIRA vai em toda chamada — inclusive a Ana. Quem fica de
       fora da lista é desativado, e desativar a própria dona da sessão
       derrubaria o resto da suíte de um jeito difícil de ler. Também é o
       contrato real: o hospedeiro manda o cadastro completo, não um pedaço. */
    const EQUIPE = [
      { id: ANA.id, nome: ANA.nome, sobrenome: ANA.sobrenome, cargo: ANA.cargo,
        departamento: ANA.departamento, papel: "admin" },
      { id: BRUNO.id, nome: BRUNO.nome, sobrenome: BRUNO.sobrenome, cargo: BRUNO.cargo,
        departamento: BRUNO.departamento },
      { id: CARLA.id, nome: CARLA.nome, sobrenome: CARLA.sobrenome },
    ];

    const mandarElenco = (lista) => pedir(chat.base + "/elenco", {
      metodo: "POST",
      corpo: {
        passe: emitirPasse(chat.segredos.CHAT_SEGREDO_PASSE,
          { id: "__elenco__", nome: "Sincronização de elenco" }),
        usuarios: lista,
      },
    });
    const nomesDoElenco = async () =>
      (await ana.vai("/pessoas")).dados.pessoas.map((p) => p.nomeCompleto || p.nome);

    const entrou = await mandarElenco([...EQUIPE, NOVATA]);
    P.eq(entrou.status, 200, "elenco sincroniza");
    P.ok(entrou.dados.mudou === true, "e avisa que MUDOU (entrou gente nova)");
    P.ok((await nomesDoElenco()).some((n) => n.includes("Novata")),
      "a pessoa nova aparece sem ninguém recarregar");

    const igual = await mandarElenco([...EQUIPE, NOVATA]);
    P.ok(igual.dados.mudou === false,
      "reenviar o MESMO elenco não é mudança (senão o log enche à toa)");

    const saiu = await mandarElenco(EQUIPE);
    P.eq(saiu.dados.desativados, 1, "quem sumiu do cadastro é desativado");
    P.ok(!(await nomesDoElenco()).some((n) => n.includes("Novata")),
      "e some da lista de pessoas");

    const voltou = await mandarElenco([...EQUIPE, NOVATA]);
    P.ok(voltou.dados.mudou === true, "recontratar é mudança");
    P.ok((await nomesDoElenco()).some((n) => n.includes("Novata")),
      "e a pessoa VOLTA para a lista");

    /* ====================================================================
       A CONTA MUDA, A PESSOA NÃO

       O cliente do BemEstarClinic removeu um profissional, reativou e criou
       uma conta NOVA para ele. Conta nova = id novo = pessoa nova aqui, e a
       barra lateral passou a mostrar DUAS conversas com o mesmo nome — uma
       com o histórico e outra vazia.

       Com `identidade`, o chat reconhece que é a mesma pessoa e MIGRA o
       registro: o `externo_id` passa a ser a identidade e as conversas, as
       mensagens e as não-lidas ficam onde estavam.
       ==================================================================== */
    const COM_IDENTIDADE = EQUIPE.map((u) => ({ ...u, identidade: "prof-" + u.id }));
    await mandarElenco(COM_IDENTIDADE);

    const antesDaTroca = (await ana.vai("/pessoas")).dados.pessoas.length;

    /* Mesma gente, contas com ids NOVOS — só a identidade se repete. */
    const CONTAS_NOVAS = COM_IDENTIDADE.map((u) => ({ ...u, id: "recriado-" + u.id }));
    const migrou = await mandarElenco(CONTAS_NOVAS);
    P.eq(migrou.status, 200, "elenco com contas recriadas sincroniza");
    P.eq(migrou.dados.desativados, 0,
      "e NINGUÉM é desativado — a chave de presença acompanhou a identidade");
    P.eq((await ana.vai("/pessoas")).dados.pessoas.length, antesDaTroca,
      "o número de pessoas não muda: não nasceu ninguém duplicado");

    /* A conversa que a Ana já tinha com o Bruno continua sendo A MESMA — é o
       ponto todo: o histórico não se parte quando a conta é refeita. */
    const antesConv = (await ana.vai("/conversas")).dados.conversas.length;
    await mandarElenco(CONTAS_NOVAS);
    P.eq((await ana.vai("/conversas")).dados.conversas.length, antesConv,
      "e a lista de conversas continua com o mesmo tamanho");

    /* Devolve as contas originais, ainda com identidade: é ela que reconhece a
       gente e faz o `externo_id` apontar de volta para a conta de sempre. */
    await mandarElenco(COM_IDENTIDADE);

    /* E AGORA O CAMPO SOME. Hospedeiro velho, rollback, conector desatualizado
       — o elenco volta a ser só id e nome. Ninguém pode ser desativado e
       ninguém pode nascer de novo: é o `externo_id` que segura a barra.

       Esta é a garantia contra a armadilha de mão única. A primeira versão da
       mudança reescrevia o próprio `externo_id` com a identidade, e a suíte
       morreu aqui com 401 — a dona da sessão tinha sido "removida do cadastro"
       sem ter saído de lugar nenhum. */
    const semCampo = await mandarElenco(EQUIPE);
    P.eq(semCampo.dados.desativados, 0,
      "tirar a identidade do elenco NÃO desativa ninguém");
    P.eq((await ana.vai("/pessoas")).dados.pessoas.length, antesDaTroca,
      "e nem faz nascer gente duplicada");
    P.eq((await ana.vai("/eu")).status, 200, "a sessão de quem estava dentro sobrevive");

    /* ENTRAR TAMBÉM CRIA PESSOA — e é por isso que o PASSE carrega a
       identidade, não só o elenco.

       A conta da Carla foi refeita e ela entra pelo id novo. Se só o elenco
       soubesse quem ela é, este login abriria a SEGUNDA ficha dela e a conversa
       se partiria em duas — exatamente o defeito que veio da clínica, só que
       entrando pela outra porta. */
    const carlaRecriada = await entrar(chat, {
      ...CARLA, id: "conta-refeita-carla", identidade: "prof-" + CARLA.id,
    });
    P.eq(carlaRecriada.usuario.id, carla.usuario.id,
      "entrar por uma conta NOVA, com a mesma identidade, é a MESMA pessoa");
    P.eq((await ana.vai("/pessoas")).dados.pessoas.length, antesDaTroca,
      "e o login não fez nascer ninguém");

    /* O hospedeiro sincroniza depois do login e devolve a conta de sempre. */
    const depoisDoLogin = await mandarElenco(COM_IDENTIDADE);
    P.eq(depoisDoLogin.dados.desativados, 0,
      "a sincronização seguinte não desativa a Carla, que acabou de entrar");
    P.eq((await carla.vai("/eu")).status, 200, "e a sessão antiga dela continua de pé");

    /* ==================================================================== */
    P.secao("conversa e mensagens");

    const abrir = await ana.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: bruno.usuario.id },
    });
    P.eq(abrir.status, 200, "conversa direta abre");
    const conversaId = abrir.dados.id;

    const abrirDeNovo = await bruno.vai("/conversas/direta", {
      metodo: "POST", corpo: { usuarioId: ana.usuario.id },
    });
    P.eq(abrirDeNovo.dados.id, conversaId, "abrir do outro lado devolve a MESMA conversa");

    const m1 = await ana.vai(`/conversas/${conversaId}/mensagens`, {
      metodo: "POST", corpo: { texto: "Bom dia! O **orçamento** foi aprovado?", idCliente: "c1" },
    });
    P.eq(m1.status, 200, "mensagem enviada");
    P.eq(m1.dados.mensagem.seq, 1, "primeira mensagem tem seq 1");
    P.eq(m1.dados.mensagem.corpo, "Bom dia! O **orçamento** foi aprovado?", "o corpo volta íntegro");

    const m2 = await bruno.vai(`/conversas/${conversaId}/mensagens`, {
      metodo: "POST", corpo: { texto: "Foi sim, aprovado ontem.", idCliente: "c2" },
    });
    P.eq(m2.dados.mensagem.seq, 2, "segunda mensagem tem seq 2");

    /* Deduplicação: o reenvio que a reconexão provoca. */
    const repetida = await ana.vai(`/conversas/${conversaId}/mensagens`, {
      metodo: "POST", corpo: { texto: "Bom dia! O **orçamento** foi aprovado?", idCliente: "c1" },
    });
    P.ok(repetida.dados.repetida === true, "reenvio com mesmo idCliente é reconhecido");
    P.eq(repetida.dados.mensagem.id, m1.dados.mensagem.id, "e devolve a MESMA mensagem");

    const hist = await ana.vai(`/conversas/${conversaId}/mensagens`);
    P.eq(hist.dados.mensagens.length, 2, "o histórico tem 2 mensagens (não 3)");
    P.ok(hist.dados.mensagens[0].seq < hist.dados.mensagens[1].seq, "vem em ordem de leitura");

    /* ==================================================================== */
    P.secao("não lidas e marcas d'água");

    const listaBruno = await bruno.vai("/conversas");
    const cB = listaBruno.dados.conversas.find((c) => c.id === conversaId);
    P.eq(cB.naoLidas, 0, "quem escreveu por último não tem não lidas");

    const listaAna = await ana.vai("/conversas");
    const cA = listaAna.dados.conversas.find((c) => c.id === conversaId);
    P.eq(cA.naoLidas, 1, "Ana tem 1 não lida (a do Bruno)");
    P.ok(cA.previa?.texto?.includes("aprovado ontem"), "a prévia é a última mensagem");
    P.eq(cA.outro.id, bruno.usuario.id, "a conversa direta mostra o OUTRO");

    await ana.vai(`/conversas/${conversaId}/lida`, { metodo: "POST", corpo: { seq: 2 } });
    const listaAna2 = await ana.vai("/conversas");
    P.eq(listaAna2.dados.conversas.find((c) => c.id === conversaId).naoLidas, 0,
      "depois de marcar lida, zera");

    /* A marca não retrocede. */
    await ana.vai(`/conversas/${conversaId}/lida`, { metodo: "POST", corpo: { seq: 1 } });
    const listaAna3 = await ana.vai("/conversas");
    P.eq(listaAna3.dados.conversas.find((c) => c.id === conversaId).naoLidas, 0,
      "marca antiga NÃO faz a conversa voltar a não lida");

    const histBruno = await bruno.vai(`/conversas/${conversaId}/mensagens`);
    P.eq(histBruno.dados.marcas.lidaAte, 2, "Bruno vê que a Ana leu até a 2 (✓✓)");

    /* ==================================================================== */
    P.secao("paginação por cursor");

    for (let i = 0; i < 12; i++) {
      await ana.vai(`/conversas/${conversaId}/mensagens`, {
        metodo: "POST", corpo: { texto: `ZZ QA linha ${i}`, idCliente: "lote-" + i },
      });
    }
    const pag1 = await ana.vai(`/conversas/${conversaId}/mensagens?limite=5`);
    P.eq(pag1.dados.mensagens.length, 5, "primeira página traz 5");
    P.ok(pag1.dados.temMais === true, "diz que há mais");
    const pag2 = await ana.vai(`/conversas/${conversaId}/mensagens?limite=5&antes=${pag1.dados.proximoCursor}`);
    P.eq(pag2.dados.mensagens.length, 5, "segunda página traz 5");
    const seqs1 = pag1.dados.mensagens.map((m) => m.seq);
    const seqs2 = pag2.dados.mensagens.map((m) => m.seq);
    P.ok(!seqs1.some((s) => seqs2.includes(s)), "as páginas não se sobrepõem");
    P.ok(Math.max(...seqs2) < Math.min(...seqs1), "a segunda página é mais antiga");

    /* ==================================================================== */
    P.secao("busca sobre conteúdo cifrado");

    const b1 = await ana.vai("/busca?q=" + encodeURIComponent("orçamento"));
    P.eq(b1.status, 200, "busca responde");
    P.ok(b1.dados.mensagens.some((m) => m.id === m1.dados.mensagem.id),
      "acha a mensagem por palavra ACENTUADA");

    const b2 = await ana.vai("/busca?q=orcamento");
    P.ok(b2.dados.mensagens.length >= 1, "acha a mesma coisa SEM acento");

    const b3 = await ana.vai("/busca?q=" + encodeURIComponent("orcamento aprovado"));
    P.ok(b3.dados.mensagens.length >= 1, "duas palavras: acha");

    const b4 = await ana.vai("/busca?q=" + encodeURIComponent("orcamento jabuticaba"));
    P.eq(b4.dados.mensagens.length, 0, "duas palavras é E — palavra ausente zera");

    const b5 = await ana.vai("/busca?q=" + encodeURIComponent("ZZ QA Bruno"));
    P.ok(b5.dados.pessoas.some((p) => p.id === bruno.usuario.id), "busca acha PESSOAS");

    /* Quem não é membro não acha. */
    const b6 = await carla.vai("/busca?q=" + encodeURIComponent("orçamento"));
    P.eq(b6.dados.mensagens.length, 0, "quem não participa NÃO acha a mensagem");

    /* ==================================================================== */
    /* ====================================================================
       O TOQUE É DA INSTALAÇÃO, E VEM DO SERVIDOR

       O mesmo código serve a clínica e o Instituto. Quem sabe em qual
       instância está rodando é o servidor — o site hospedeiro não tem como
       declarar isso sem repetir configuração, e repetir configuração entre
       dois lados de um limite é como se perde a segunda metade.
       ==================================================================== */
    P.secao("o toque desta instalação");

    {
      const eu = await ana.vai("/eu");
      P.eq(eu.dados.toque, "padrao",
        "sem CHAT_TOQUE, o /eu responde o padrão — o som de sempre",
        JSON.stringify(eu.dados.toque));

      /* Quem não escolheu nada NÃO PODE ter o som trocado. É a metade do
         pedido que ninguém percebe se quebrar: o cliente que já estava
         servido continua ouvindo o que ouvia. */
      P.ok(eu.dados.toque !== "forte" && eu.dados.toque !== "grave",
        "e nunca um toque novo por acidente");

      /* ==================================================================
         E AGORA O CASO QUE IMPORTA: UM TOQUE ESCOLHIDO CHEGA À TELA

         A versão anterior deste teste conferia SÓ o padrão — e o padrão é a
         resposta certa mesmo quando a ligação está quebrada. Ele passou verde
         enquanto CHAT_TOQUE não era lido de lugar nenhum: a chave tinha sido
         escrita dentro do objeto `limites`, e o /eu, que lê `conf.toque`,
         nunca a encontrava.

         O sintoma foi o Instituto continuar com o som da clínica. Nada
         quebrou, nada avisou. Um teste que só exercita o valor padrão de uma
         configuração é um teste que não pode falhar.
         ================================================================== */
      const outro = await subirChat({ porta: 5288, extra: { CHAT_TOQUE: "forte" } });
      try {
        const ana2 = await entrar(outro, { id: "tq-a", nome: "ZZ QA Toque" });
        const eu2 = await ana2.vai("/eu");
        P.eq(eu2.dados.toque, "forte",
          "com CHAT_TOQUE=forte, o /eu responde forte — a escolha atravessa",
          JSON.stringify(eu2.dados.toque));
      } finally { await outro.derrubar(); }
    }

    P.secao("apagar e editar");

    const paraApagar = await ana.vai(`/conversas/${conversaId}/mensagens`, {
      metodo: "POST", corpo: { texto: "ZZ QA texto secreto para apagar", idCliente: "apagar-1" },
    });
    const idApagar = paraApagar.dados.mensagem.id;

    const apagarAlheia = await bruno.vai(`/conversas/${conversaId}/mensagens/${idApagar}`, { metodo: "DELETE" });
    P.recusa(apagarAlheia, 403, "membro comum NÃO apaga mensagem alheia");

    const apagar = await ana.vai(`/conversas/${conversaId}/mensagens/${idApagar}`, { metodo: "DELETE" });
    P.eq(apagar.status, 200, "o autor apaga a própria mensagem");

    const depois = await ana.vai(`/conversas/${conversaId}/mensagens?limite=50`);
    const achada = depois.dados.mensagens.find((m) => m.id === idApagar);
    P.ok(achada && achada.apagada === true, "a mensagem aparece como apagada");
    P.eq(achada.corpo, "", "e NÃO devolve o corpo");

    const buscaApagada = await ana.vai("/busca?q=" + encodeURIComponent("secreto"));
    P.eq(buscaApagada.dados.mensagens.length, 0, "apagada some da BUSCA também");

    const paraEditar = await ana.vai(`/conversas/${conversaId}/mensagens`, {
      metodo: "POST", corpo: { texto: "ZZ QA erro de digitaçao", idCliente: "editar-1" },
    });
    const editar = await ana.vai(`/conversas/${conversaId}/mensagens/${paraEditar.dados.mensagem.id}`, {
      metodo: "PATCH", corpo: { texto: "ZZ QA erro de digitação corrigido" },
    });
    P.eq(editar.status, 200, "o autor edita a própria mensagem");
    P.ok(!!editar.dados.editadaEm, "e fica marcada como editada");

    const editarAlheia = await bruno.vai(`/conversas/${conversaId}/mensagens/${paraEditar.dados.mensagem.id}`, {
      metodo: "PATCH", corpo: { texto: "invadido" },
    });
    P.recusa(editarAlheia, 403, "ninguém edita mensagem alheia");

    /* ====================================================================
       A JANELA FECHA

       Editar serve para consertar o erro de digitação que a pessoa viu logo
       depois de enviar. Sem prazo, vira reescrever a história: alguém combina
       algo hoje e muda a mensagem semana que vem — e num chat de clínica, o
       que se combinou sobre um paciente é justamente o que não pode mudar
       depois de lido.

       O relógio do teste anda para trás no BANCO, e não no processo: mexer no
       relógio do servidor faria o teste provar o teste, e não a regra.
       ==================================================================== */
    {
      const idEditar = paraEditar.dados.mensagem.id;
      const bd = new (require("better-sqlite3"))(
        require("node:path").join(chat.pastaDados, "chat.db"));
      bd.prepare("UPDATE mensagens SET criada_em = ? WHERE id = ?")
        .run(Date.now() - 6 * 60_000, idEditar);
      bd.close();

      const tarde = await ana.vai(`/conversas/${conversaId}/mensagens/${idEditar}`, {
        metodo: "PATCH", corpo: { texto: "ZZ QA reescrevendo a historia" },
      });
      P.recusa(tarde, 400, "passados os 5 minutos, o próprio autor não edita mais");
      P.ok(/5 minutos/.test(JSON.stringify(tarde.dados)),
        "e a recusa DIZ qual é o prazo", JSON.stringify(tarde.dados));

      /* A JANELA SAI DO SERVIDOR PARA A TELA. O lápis só pode aparecer
         enquanto a edição for aceita; se o cliente guardasse o próprio
         número, mudar a configuração deixaria a tela oferecendo um botão que
         o servidor recusa. */
      const eu = await ana.vai("/eu");
      P.eq(eu.dados.limites?.janelaEdicaoMs, 5 * 60_000,
        "e o servidor DIZ ao cliente qual é a janela, em vez de deixá-lo adivinhar",
        JSON.stringify(eu.dados.limites));
    }

    /* ====================================================================
       FOTO COM LEGENDA NÃO SE EDITA

       O repositório só aceita `tipo = 'texto'`. Se a legenda mudasse, a
       imagem continuaria sendo outra coisa do que a legenda diz — e quem
       leu antes não teria como saber.
       ==================================================================== */
    {
      const bd2 = new (require("better-sqlite3"))(
        require("node:path").join(chat.pastaDados, "chat.db"));
      const comAnexo = await ana.vai(`/conversas/${conversaId}/mensagens`, {
        metodo: "POST", corpo: { texto: "ZZ QA legenda", idCliente: "editar-anexo-1" },
      });
      const idAnexo = comAnexo.dados.mensagem.id;
      bd2.prepare("UPDATE mensagens SET tipo = 'imagem' WHERE id = ?").run(idAnexo);
      bd2.close();

      P.recusa(await ana.vai(`/conversas/${conversaId}/mensagens/${idAnexo}`, {
        metodo: "PATCH", corpo: { texto: "ZZ QA outra legenda" },
      }), 400, "mensagem com anexo não é editável — só texto puro");
    }

    /* ==================================================================== */
    P.secao("grupos");

    const grupo = await ana.vai("/conversas/grupo", {
      metodo: "POST", corpo: { titulo: "ZZ QA Projeto", membros: [bruno.usuario.id, carla.usuario.id] },
    });
    P.eq(grupo.status, 200, "grupo criado");

    await ana.vai(`/conversas/${grupo.dados.id}/mensagens`, {
      metodo: "POST", corpo: { texto: "ZZ QA olá time", idCliente: "g1" },
    });

    const listaCarla = await carla.vai("/conversas");
    const gC = listaCarla.dados.conversas.find((c) => c.id === grupo.dados.id);
    P.ok(!!gC, "quem foi incluída vê o grupo");
    P.eq(gC.titulo, "ZZ QA Projeto", "o título do grupo volta decifrado");
    P.eq(gC.naoLidas, 1, "e com 1 não lida");

    /* ==================================================================== */
    P.secao("arquivos");

    /* PNG mínimo de verdade: assinatura correta, para passar pela conferência
       de bytes. Um buffer aleatório seria recusado — e com razão. */
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");

    const envio = await ana.vai(`/arquivos?conversa=${conversaId}`, {
      metodo: "POST", corpo: png, bruto: true,
      cabecalhos: {
        "Content-Type": "image/png",
        "X-Arquivo-Nome": Buffer.from("ZZ QA planta.png", "utf8").toString("base64"),
      },
    });
    P.eq(envio.status, 200, "imagem aceita");
    P.eq(envio.dados.nome, "ZZ QA planta.png", "o nome original é preservado");

    const comAnexo = await ana.vai(`/conversas/${conversaId}/mensagens`, {
      metodo: "POST", corpo: { texto: "", idCliente: "anexo-1", anexos: [{ id: envio.dados.id, ehImagem: true }] },
    });
    P.eq(comAnexo.status, 200, "mensagem só com anexo é aceita");
    P.eq(comAnexo.dados.mensagem.anexos?.length, 1, "a mensagem carrega o anexo");

    const baixar = await bruno.vai("/arquivos/" + envio.dados.id);
    P.eq(baixar.status, 200, "o outro membro baixa o anexo");
    P.ok(baixar.bruto.equals(png), "os bytes chegam idênticos");
    P.ok(String(baixar.cabecalhos["content-disposition"] || "").startsWith("attachment"),
      "o download vai como ANEXO, nunca inline");
    P.eq(baixar.cabecalhos["content-type"], "application/octet-stream",
      "e como octet-stream, para não executar no navegador de quem baixou");
    P.eq(baixar.cabecalhos["x-content-type-options"], "nosniff", "com nosniff");

    /* --- a prévia: é o que faz a bolha mostrar a foto em vez de um link --- */
    const previa = await bruno.vai(`/arquivos/${envio.dados.id}/previa`);
    P.eq(previa.status, 200, "a prévia da imagem responde");
    P.eq(previa.cabecalhos["content-type"], "image/png",
      "com o tipo REAL (sem ele o <img> não renderiza)");
    P.ok(String(previa.cabecalhos["content-disposition"] || "").startsWith("inline"),
      "e inline, não attachment");
    P.eq(previa.cabecalhos["x-content-type-options"], "nosniff",
      "ainda com nosniff — o navegador usa o tipo que declaramos, e os bytes já foram conferidos");
    P.ok(String(previa.cabecalhos["cache-control"] || "").includes("private"),
      "cache PRIVADO — nunca num cache compartilhado, que alcançaria quem não é membro");
    P.ok(previa.bruto.equals(png), "os bytes da prévia são os mesmos");

    /* Prévia é só para imagem: um PDF não vira prévia inline. */
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 0x20)]);
    const envioPdf = await ana.vai(`/arquivos?conversa=${conversaId}`, {
      metodo: "POST", corpo: pdf, bruto: true,
      cabecalhos: { "Content-Type": "application/pdf",
        "X-Arquivo-Nome": Buffer.from("ZZ QA contrato.pdf", "utf8").toString("base64") },
    });
    P.eq(envioPdf.status, 200, "PDF é aceito");
    P.recusa(await ana.vai(`/arquivos/${envioPdf.dados.id}/previa`), 404,
      "PDF NÃO tem prévia inline (só imagem, e só depois de os bytes provarem)");

    /* E a prévia respeita a mesma autorização do download. */
    P.recusa(await carla.vai(`/arquivos/${envio.dados.id}/previa`), 404,
      "quem não é membro NÃO vê a prévia");

    /* ==================================================================== */
    P.secao("presença e status");

    const st = await ana.vai("/status", { metodo: "POST", corpo: { status: "ocupado" } });
    P.eq(st.status, 200, "status manual aceito");
    const euDepois = await ana.vai("/eu");
    P.eq(euDepois.dados.statusManual, "ocupado", "e persiste");

    const stRuim = await ana.vai("/status", { metodo: "POST", corpo: { status: "voando" } });
    P.recusa(stRuim, 400, "status inventado é recusado");

    /* ==================================================================== */
    P.secao("cliente que não manda idCliente");

    /* ====================================================================
       O índice de deduplicação é UNIQUE (conversa, autor, id_cliente), e a
       coluna tem `DEFAULT ''`. Quem não manda a chave gravava `''` — e a
       SEGUNDA mensagem daquela pessoa naquela conversa batia no índice e
       voltava 500, sem nada que explicasse o quê.

       Ficou invisível desde o começo porque o nosso componente SEMPRE manda o
       ULID dele. Apareceu no primeiro cliente que não é ele: uma suíte falando
       HTTP direto — e valeria igual para um robô de avisos usando a API.

       Fica no fim da suíte de propósito: acrescentar mensagens no meio mexeria
       nas contagens de não lidas e na paginação testadas acima.
       ==================================================================== */
    const semChave1 = await bruno.vai(`/conversas/${conversaId}/mensagens`, {
      metodo: "POST", corpo: { texto: "Primeira sem idCliente." },
    });
    P.eq(semChave1.status, 200, "mensagem SEM idCliente é aceita");

    const semChave2 = await bruno.vai(`/conversas/${conversaId}/mensagens`, {
      metodo: "POST", corpo: { texto: "Segunda sem idCliente." },
    });
    P.eq(semChave2.status, 200, "e a SEGUNDA também — não colide no índice de dedup");
    P.ok(semChave2.dados.mensagem?.id !== semChave1.dados.mensagem?.id,
      "são duas mensagens distintas");
    P.ok(!semChave2.dados.repetida, "e nenhuma é tomada por reenvio");

    /* ==================================================================== */
    P.secao("preferências e saída");

    const prefs = await ana.vai("/preferencias", { metodo: "PATCH", corpo: { som: false, tema: "escuro" } });
    P.eq(prefs.dados.som, false, "preferência de som grava");
    P.eq(prefs.dados.tema, "escuro", "preferência de tema grava");

    const sair = await ana.vai("/sair", { metodo: "POST" });
    P.eq(sair.status, 200, "saiu");
    const depoisDeSair = await ana.vai("/eu");
    P.recusa(depoisDeSair, 401, "a sessão morreu de verdade");

    /* ==================================================================== */
    P.secao("saúde");

    const saude = await ana.vai("/saude");
    P.eq(saude.status, 200, "health check responde");
    P.eq(saude.dados.banco, "ok", "banco ok");
    P.ok(!saude.texto.includes(chat.pastaDados), "o health check NÃO vaza caminho do servidor");


    /* ======================================================================
       ARQUIVAR E REMOVER — duas ações que parecem a mesma

         ARQUIVAR  é de QUEM ARQUIVOU. Some da lista dela e de mais ninguém.
         REMOVER   é da CONVERSA. Some para todos, e só o administrador pode.

       Se arquivar morasse em `conversas` em vez de `conversa_membros`,
       arquivar para si esconderia a conversa da equipe inteira — e o defeito
       só apareceria quando o segundo membro reclamasse que ela sumiu sozinha.
       Este é o caso que prova a separação.
       ====================================================================== */
    P.secao("arquivar e remover conversa");

    {
      /* Sessões PRÓPRIAS. As de cima já foram encerradas por casos anteriores
         (há testes de logout e de sessão duplicada), e reaproveitá-las faria
         este bloco falhar por um motivo que não é o dele. */
      const adm = await entrar(chat, ANA);
      const membro = await entrar(chat, BRUNO);

      const conv = (await adm.vai("/conversas/direta", {
        metodo: "POST", corpo: { usuarioId: membro.usuario.id },
      })).dados;
      const cid = conv.id || conv.conversa?.id;

      await adm.vai(`/conversas/${cid}/mensagens`, {
        metodo: "POST", corpo: { texto: "ZZ QA para arquivar", idCliente: "zzqa-arq-1" },
      });

      const arq = await adm.vai(`/conversas/${cid}/arquivar`, {
        metodo: "POST", corpo: { arquivar: true },
      });
      P.eq(arq.status, 200, "a Ana arquiva a conversa");

      const listaAna = (await adm.vai("/conversas")).dados.conversas;
      const naAna = listaAna.find((c) => c.id === cid);
      P.eq(naAna?.arquivada, true, "e ela vem marcada como arquivada para a Ana");

      /* O PONTO: o Bruno não foi afetado. */
      const naBruno = (await membro.vai("/conversas")).dados.conversas.find((c) => c.id === cid);
      P.ok(!!naBruno, "o Bruno continua com a conversa");
      P.ok(!naBruno.arquivada, "e ela NÃO está arquivada para ele — arquivar é de quem arquivou");

      /* Desarquivar volta. */
      await adm.vai(`/conversas/${cid}/arquivar`, { metodo: "POST", corpo: { arquivar: false } });
      P.ok(!(await adm.vai("/conversas")).dados.conversas.find((c) => c.id === cid)?.arquivada,
        "desarquivar devolve a conversa à lista");

      /* ==================================================================
         A MENSAGEM NOVA DESARQUIVA.

         Sem isto, a mensagem seguinte chegaria a um lugar que ninguém olha —
         e o efeito seria PERDER MENSAGEM, o pior defeito possível num chat.
         Quem quer silêncio tem `silenciada`, que é outra coisa.
         ================================================================== */
      await adm.vai(`/conversas/${cid}/arquivar`, { metodo: "POST", corpo: { arquivar: true } });
      await membro.vai(`/conversas/${cid}/mensagens`, {
        metodo: "POST", corpo: { texto: "ZZ QA mensagem nova", idCliente: "zzqa-arq-2" },
      });
      P.ok(!(await adm.vai("/conversas")).dados.conversas.find((c) => c.id === cid)?.arquivada,
        "mensagem nova DESARQUIVA — senão a conversa engoliria o que chega");

      /* ==================================================================
         REMOVER — só administrador, e para todos.
         ================================================================== */
      P.recusa(await membro.vai(`/conversas/${cid}`, { metodo: "DELETE" }), 403,
        "funcionário comum NÃO remove conversa");

      const rem = await adm.vai(`/conversas/${cid}`, { metodo: "DELETE" });
      P.eq(rem.status, 200, "a administradora remove");

      P.ok(!(await adm.vai("/conversas")).dados.conversas.find((c) => c.id === cid),
        "e ela some da lista de quem removeu");
      P.ok(!(await membro.vai("/conversas")).dados.conversas.find((c) => c.id === cid),
        "e da lista de TODOS os outros também");

      /* A conversa removida não recebe mais nada. */
      P.recusa(await adm.vai(`/conversas/${cid}/mensagens`, {
        metodo: "POST", corpo: { texto: "ZZ QA depois de remover", idCliente: "zzqa-arq-3" },
      }), 404, "e não recebe mensagem nova");

      /* NÃO APAGOU LINHA NENHUMA — é marca, e a auditoria registra quem fez.
         Remoção é ato de administrador sobre o histórico dos outros; um
         clique errado não pode ser definitivo. */
      const registro = (await adm.vai("/admin/auditoria?evento=CONVERSA_REMOVIDA")).dados;
      const eventos = registro?.eventos || registro?.registros || [];
      P.ok(eventos.some((e) => e.alvoId === cid || e.alvo_id === cid),
        "a remoção fica na auditoria, com quem fez", JSON.stringify(eventos[0] || {}).slice(0, 90));
    }
  } finally {
    await chat.derrubar();
  }


  return P.fim();
}

if (require.main === module) {
  rodar().then((ok) => { process.exitCode = ok ? 0 : 1; })
    .catch((e) => { console.error("\n  EXPLODIU:", e.message, "\n", e.stack); process.exitCode = 1; });
}

module.exports = { rodar };
