/* ==========================================================================
   aplicacao/salas.js — a reunião por link, com gente de fora

   ---------------------------------------------------------------------------
   O QUE MUDA NO MODELO DE SEGURANÇA, dito de uma vez

   O resto do sistema se apoia numa frase: *quem entra é quem é membro da
   conversa*. Aqui há três coisas que essa frase não cobre:

     · a pessoa NÃO está autenticada;
     · o LINK é a credencial — quem o tiver, entra;
     · o NOME é declarado por ela mesma.

   O que contém cada uma:

   1. A sessão de convidado é OUTRA (`seguranca/convidado.js`): vale para uma
      sala e não é aceita por nenhuma rota de conversa, mensagem, busca ou
      pessoa. É a proteção principal, e a única que importa se as outras
      falharem.

   2. O link expira, a reunião tem duração fixa, o anfitrião precisa estar
      presente e a sala pode ser revogada. Link vazado tem estrago limitado no
      tempo — sempre.

   3. O nome é saneado aqui e marcado como convidado na tela, sempre. Ninguém
      impede alguém de digitar o nome de um colega; o que impede a confusão é a
      etiqueta, não o campo.
   ========================================================================== */
"use strict";

const { erros } = require("../dominio/erros.js");
const { ehUlid } = require("../dominio/ids.js");
const dom = require("../dominio/salas.js");
const { EVENTOS } = require("../infra/eventos/barramento.js");

function criarServicoDeSalas({ repos, conf, barramento, limites, convidados,
                               chamadas, servicoChat, ipEmHash }) {
  const V = conf.video;

  function exigirVideoLigado() {
    if (!V.ativo)
      throw erros.invalido("As reuniões por vídeo não estão ativadas nesta instalação.");
  }

  /* Alguém DA CASA está dentro da chamada? É a pergunta que decide se um
     convidado pode entrar — ver o comentário em dominio/salas.js sobre
     estranhos conversando pelo seu relay. */
  async function anfitriaoPresente(sala) {
    if (!sala.chamada_id) return false;
    const dentro = await repos.chamadas.dentro(sala.chamada_id);
    if (!dentro.length) return false;
    const pessoas = await repos.usuarios.porIds(sala.contexto_id, dentro);
    /* `porIds` já filtra `convidado = 0` — então qualquer resultado aqui é
       gente da casa. */
    return pessoas.length > 0;
  }

  const servico = {
    /* ======================================================================
       CRIAR O LINK — só quem está autenticado
       ====================================================================== */
    async criar(sessao, { titulo, duracaoMin, validadeH, exigeAnfitriao, maxConvidados } = {}) {
      exigirVideoLigado();
      if (sessao.ehConvidado) throw erros.semPermissao();

      /* ==================================================================
         SÓ ADMINISTRADOR CRIA REUNIÃO POR LINK

         Todo funcionário pode LIGAR para um colega — é conversa entre quem
         já está dentro. Criar um link é outra coisa: é abrir uma porta que
         responde a quem não tem credencial nenhuma, com a banda e o nome da
         empresa atrás dela.

         Essa decisão não pertence a cada pessoa. Pertence a quem responde
         pelo sistema — e é a única rota deste chat que precisa desse
         degrau, justamente porque é a única que fabrica acesso externo.

         REVOGAR e REMOVER continuam abertos a quem CRIOU a sala (ver
         `revogar` e `expulsar`): tirar gente de uma reunião não pode
         depender de achar um administrador.
         ================================================================== */
      if (!sessao.ehAdmin)
        throw erros.semPermissao("Só um administrador pode criar link de reunião.");

      /* Criar sala é barato para quem cria e caro para o servidor: cada uma é
         uma porta pública a mais. */
      const freio = limites.conferir(`sala:${sessao.usuarioId}`, { maximo: 20, janelaMs: 3600e3 });
      if (!freio.ok) throw erros.demais(freio.esperar,
        "Você criou muitos links de reunião na última hora. Aguarde um pouco.");

      const d = dom.validarDuracao(duracaoMin);
      if (!d.ok) throw erros.invalido(d.erro);
      const v = dom.validarValidade(validadeH);
      if (!v.ok) throw erros.invalido(v.erro);

      const teto = Math.max(1, Math.min(V.teto - 1, Number(maxConvidados) || (V.teto - 1)));
      const nome = String(titulo || "").trim().slice(0, 80);

      /* ==================================================================
         A CONVERSA DA SALA

         Existe para a autorização da chamada continuar sendo a mesma do resto
         do sistema — `exigirMembro`, dentro do SQL. Ver repositorios/salas.js.

         Ela nasce com o anfitrião apenas; cada convidado vira membro ao
         entrar, e deixa de ser quando a sala acaba.
         ================================================================== */
      const conversa = await repos.conversas.criarGrupo(
        sessao.contextoId, sessao.usuarioId, nome || "Reunião por link", []);

      const { sala, codigo } = await repos.salas.criar({
        contextoId: sessao.contextoId,
        criadaPor: sessao.usuarioId,
        conversaId: conversa.id,
        titulo: nome,
        duracaoMin: d.minutos,
        validadeH: v.horas,
        exigeAnfitriao: exigeAnfitriao !== false,
        maxConvidados: teto,
      });

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "SALA_CRIADA", alvoTipo: "sala", alvoId: sala.id,
        detalhe: `${d.minutos}min validade=${v.horas}h teto=${teto}`,
      });

      return servico.paraODono(sala, codigo);
    },

    /* O link montado. `CHAT_BASE` é o endereço público — em produção ele é o
       do site do cliente, e é ele que a pessoa vai receber. */
    paraODono(sala, codigo) {
      return {
        id: sala.id,
        codigo,
        link: `${conf.base}/call/${codigo}`,
        titulo: repos.salas.tituloDe(sala),
        duracaoMin: Number(sala.duracao_min),
        expiraEm: Number(sala.expira_em),
        exigeAnfitriao: !!sala.exige_anfitriao,
        maxConvidados: Number(sala.max_convidados),
        estado: sala.estado,
        conversaId: sala.conversa_id,
        chamadaId: sala.chamada_id || null,
        encerraEm: sala.encerra_em ? Number(sala.encerra_em) : null,
        criadaEm: Number(sala.criada_em),
      };
    },

    /* ======================================================================
       A LISTA DO ANFITRIÃO — com o estado REAL da chamada

       `estado = 'ativa'` diz que a sala foi aberta, e não que há reunião
       acontecendo agora. Quando o anfitrião sai e era o último, a CHAMADA
       encerra e a SALA continua ativa, apontando para ela.

       Sem distinguir os dois, a tela oferecia "Entrar" — que levava à chamada
       morta e respondia "Esta chamada já terminou". O anfitrião ficava
       trancado do lado de fora da própria reunião, com o link já distribuído.
       ====================================================================== */
    async minhas(sessao) {
      if (sessao.ehConvidado) throw erros.semPermissao();
      const linhas = await repos.salas.doUsuario(sessao.contextoId, sessao.usuarioId);
      return Promise.all(linhas.map(async (s) => ({
        ...servico.paraODono(s, s.codigo),
        chamadaViva: await servico.chamadaViva(s),
      })));
    },

    /* Uma consulta por sala VIVA apenas. Salas paradas não têm chamada para
       conferir, e perguntar por elas seria trabalho para responder `false`. */
    async chamadaViva(sala) {
      if (!sala?.chamada_id || sala.estado !== "ativa") return false;
      const c = await repos.chamadas.porIdCru(sala.chamada_id);
      return !!c && c.estado !== "encerrada";
    },

    async revogar(sessao, salaId) {
      if (sessao.ehConvidado) throw erros.semPermissao();
      const sala = await repos.salas.porId(sessao.contextoId, salaId);
      if (!sala) throw erros.naoEncontrado();
      if (sala.criada_por !== sessao.usuarioId && !sessao.ehAdmin)
        throw erros.semPermissao("Só quem criou o link pode revogá-lo.");

      await repos.salas.encerrar(sala.id, "revogada");
      await servico.derrubarSala(sala, "revogada");

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "SALA_REVOGADA", alvoTipo: "sala", alvoId: sala.id,
      });
      return { ok: true };
    },

    /* ======================================================================
       ABRIR — o anfitrião entra e o relógio começa
       ====================================================================== */
    async abrir(sessao, salaId) {
      exigirVideoLigado();
      if (sessao.ehConvidado) throw erros.semPermissao();

      const sala = await repos.salas.porId(sessao.contextoId, salaId);
      if (!sala) throw erros.naoEncontrado();
      if (sala.estado === "revogada" || sala.estado === "encerrada")
        throw erros.invalido("Esta sala não está mais disponível.");
      if (Number(sala.expira_em) <= Date.now())
        throw erros.invalido("O link desta sala expirou.");

      /* ==================================================================
         O TEMPO ACABOU — e quem pergunta é o ANFITRIÃO

         Esta linha faltava, e a falta tinha forma de privilégio: o convidado
         era julgado pelo RELÓGIO (`podeEntrar` confere `tempo().acabou`),
         enquanto o anfitrião era julgado pelo ESTADO — que só vira
         'encerrada' quando a faxina roda, até 20 segundos depois.

         Nessa janela, quem criou a sala reabria uma reunião cujo prazo já
         tinha vencido, e os convidados batiam na porta de uma reunião viva
         recebendo "o tempo desta reunião terminou". Duas verdades sobre a
         mesma sala, dependendo de quem pergunta.

         O prazo é do RELÓGIO. A faxina apenas o registra.
         ================================================================== */
      if (dom.tempo(sala).acabou)
        throw erros.invalido(dom.RECUSAS.tempo_esgotado);

      /* A chamada é criada pelo caminho normal — o anfitrião é membro da
         conversa da sala, então `exigirMembro` passa sem exceção nenhuma. */
      const chamada = await chamadas.iniciar(sessao, sala.conversa_id);

      await repos.salas.abrir(sala.id, chamada.id, Number(sala.duracao_min));
      const atual = await repos.salas.porIdCru(sala.id);

      return {
        ...servico.paraODono(atual, repos.salas.codigoDe(atual)),
        chamada,
      };
    },

    /* ======================================================================
       A PÁGINA DO LINK — pública, sem sessão nenhuma

       O que ela devolve é DELIBERADAMENTE pouco. Ver `RECUSAS` no domínio: a
       mesma frase cobre inexistente, revogada e expirada, porque distinguir
       confirmaria ao curioso que ele acertou um código — e é assim que
       tentativa e erro vira mapa.

       O TÍTULO SAI, e isso é escolha de quem cria a sala: quem põe
       "Demissão do João" no título de um link público está publicando isso
       para quem tiver o link. A tela de criação avisa.
       ====================================================================== */
    async info(codigo, { ip } = {}) {
      exigirVideoLigado();

      /* ==================================================================
         O FREIO CONTRA ADIVINHAÇÃO — não é opcional

         São 58^11 (~2^64) combinações: tentar é inviável COM freio, e apenas
         demorado sem ele. E o freio precisa ser por IP e apertado, porque
         esta é a única rota do sistema que responde sem nenhuma credencial.
         ================================================================== */
      const chave = `sala:info:${ipEmHash(ip) || "sem-ip"}`;
      const freio = limites.conferir(chave, { maximo: 20, janelaMs: 60e3 });
      if (!freio.ok) throw erros.demais(freio.esperar, "Muitas tentativas. Aguarde um instante.");

      const sala = await repos.salas.porCodigo(codigo);

      /* Código fora de forma e sala inexistente devolvem a MESMA resposta, no
         MESMO caminho — inclusive gastando o mesmo freio. */
      if (!sala) return { ok: false, motivo: "inexistente", mensagem: dom.RECUSAS.inexistente };

      const podem = dom.podeEntrar(sala, {
        anfitriaoPresente: await anfitriaoPresente(sala),
        convidadosDentro: await repos.salas.quantosDentro(sala.id),
      });

      const t = dom.tempo(sala);

      return {
        ok: podem.ok,
        motivo: podem.motivo || "",
        mensagem: podem.ok ? "" : (dom.RECUSAS[podem.motivo] || dom.RECUSAS.inexistente),
        titulo: repos.salas.tituloDe(sala),
        /* "Aguarde o anfitrião" precisa saber se vale a pena esperar. Só um
           booleano — nunca quem é, nem quantos são. */
        aguardando: podem.motivo === "sem_anfitriao",
        duracaoMin: Number(sala.duracao_min),
        restanteMs: t.restanteMs,
      };
    },

    /* ======================================================================
       ENTRAR COMO CONVIDADO — a rota mais exposta do sistema inteiro
       ====================================================================== */
    async entrar({ codigo, nome, ip, agente }) {
      exigirVideoLigado();

      const ipHash = ipEmHash(ip);
      const freio = limites.conferir(`sala:entrar:${ipHash || "sem-ip"}`,
        { maximo: V.freioEntrar || 10, janelaMs: 60e3 });
      if (!freio.ok) throw erros.demais(freio.esperar, "Muitas tentativas. Aguarde um instante.");

      const n = dom.validarNome(nome);
      if (!n.ok) throw erros.invalido(n.erro);

      const sala = await repos.salas.porCodigo(codigo);
      if (!sala) throw erros.naoEncontrado(dom.RECUSAS.inexistente);

      const podem = dom.podeEntrar(sala, {
        anfitriaoPresente: await anfitriaoPresente(sala),
        convidadosDentro: await repos.salas.quantosDentro(sala.id),
      });
      if (!podem.ok) throw erros.invalido(dom.RECUSAS[podem.motivo] || dom.RECUSAS.inexistente);

      if (!sala.chamada_id) throw erros.invalido(dom.RECUSAS.sem_anfitriao);

      /* ------------------------------------------------------------------
         A identidade do convidado nasce agora, e morre com a sala.
         ------------------------------------------------------------------ */
      const usuario = await repos.usuarios.criarConvidado(sala.contexto_id, n.nome);

      await repos.conversas.garantirMembro(sala.conversa_id, usuario.id);
      await repos.chamadas.acrescentarParticipante(sala.chamada_id, usuario.id);

      await repos.salas.registrarConvidado({
        salaId: sala.id, usuarioId: usuario.id, nome: n.nome, ipHash, agente,
      });

      const sessao = {
        ehConvidado: true,
        usuarioId: usuario.id,
        salaId: sala.id,
        conversaId: sala.conversa_id,
        contextoId: sala.contexto_id,
        nome: n.nome,
        ehAdmin: false,
        papel: "convidado",
        sessaoId: "cvd:" + sala.id,
      };

      /* Entra na chamada pelo caminho normal: ele já é membro da conversa, e
         `exigirMembro` passa sem exceção. */
      const dados = await chamadas.entrar(sessao, sala.chamada_id);

      const cookie = convidados.abrir({
        usuarioId: usuario.id,
        salaId: sala.id,
        conversaId: sala.conversa_id,
        contextoId: sala.contexto_id,
        nome: n.nome,
      });

      await repos.auditoria.registrar({
        contextoId: sala.contexto_id, usuarioId: usuario.id,
        evento: "SALA_CONVIDADO_ENTROU", alvoTipo: "sala", alvoId: sala.id, ipHash,
      });

      return {
        cookies: cookie.cookies,
        eu: { id: usuario.id, nome: n.nome, convidado: true },
        sala: {
          id: sala.id,
          titulo: repos.salas.tituloDe(sala),
          encerraEm: sala.encerra_em ? Number(sala.encerra_em) : null,
          duracaoMin: Number(sala.duracao_min),
        },
        chamada: dados,
      };
    },

    /* ======================================================================
       RETOMAR — recarregar a página não é entrar de novo

       No celular, recarregar acontece o tempo todo: a pessoa gira a tela,
       troca de aplicativo, o navegador descarta a aba em segundo plano. Antes
       disto, cada recarga voltava à tela de nome — e, pior, ENTRAR de novo
       criava um convidado NOVO, com id novo, gastando mais uma vaga do teto.
       Uma sala de 5 lugares se esgotava com uma pessoa e quatro recargas.

       O cookie do convidado vale 4 horas justamente para isto. Aqui ele é
       usado para RETOMAR a identidade que já existe, em vez de fabricar outra.

       As mesmas recusas continuam valendo: sala revogada, encerrada, tempo
       esgotado ou convidado expulso não retomam nada.
       ====================================================================== */
    async retomar(sessao, codigo) {
      exigirVideoLigado();
      if (!sessao?.ehConvidado) throw erros.naoAutenticado();

      const sala = await repos.salas.porCodigo(codigo);
      if (!sala) throw erros.naoEncontrado(dom.RECUSAS.inexistente);

      /* O cookie precisa ser DESTA sala. Sem esta linha, quem tivesse entrado
         numa reunião retomaria a sessão dentro de outra, com o código dela. */
      if (sessao.salaId !== sala.id) throw erros.semPermissao();

      if (await repos.salas.foiExpulso(sala.id, sessao.usuarioId))
        throw erros.semPermissao("Você foi removido desta reunião.");

      const podem = dom.podeEntrar(sala, {
        anfitriaoPresente: await anfitriaoPresente(sala),
        /* Quem retoma já ocupa a própria vaga — contá-la de novo faria a
           última pessoa da sala perder o lugar ao recarregar. */
        convidadosDentro: 0,
      });
      if (!podem.ok) throw erros.invalido(dom.RECUSAS[podem.motivo] || dom.RECUSAS.inexistente);
      if (!sala.chamada_id) throw erros.invalido(dom.RECUSAS.sem_anfitriao);

      /* A conversa e a chamada podem ter mudado (o anfitrião reabriu a sala
         enquanto a pessoa estava fora). Garantir de novo é barato e evita o
         caso em que ela retoma para uma chamada que já não é a da sala. */
      await repos.conversas.garantirMembro(sala.conversa_id, sessao.usuarioId);
      await repos.chamadas.acrescentarParticipante(sala.chamada_id, sessao.usuarioId);
      const dados = await chamadas.entrar(sessao, sala.chamada_id);

      return {
        eu: { id: sessao.usuarioId, nome: sessao.nome, convidado: true },
        sala: {
          id: sala.id,
          titulo: repos.salas.tituloDe(sala),
          encerraEm: sala.encerra_em ? Number(sala.encerra_em) : null,
          duracaoMin: Number(sala.duracao_min),
        },
        chamada: dados,
      };
    },

    /* ======================================================================
       EXPULSAR — e o cookie do expulso morre junto
       ====================================================================== */
    async expulsar(sessao, salaId, usuarioId) {
      if (sessao.ehConvidado) throw erros.semPermissao();
      const sala = await repos.salas.porId(sessao.contextoId, salaId);
      if (!sala) throw erros.naoEncontrado();
      if (sala.criada_por !== sessao.usuarioId && !sessao.ehAdmin)
        throw erros.semPermissao("Só o anfitrião pode remover participantes.");

      await repos.salas.expulsar(sala.id, usuarioId);
      /* Sem isto, "remover da reunião" valeria até a pessoa recarregar a
         página — o cookie dela continuaria valendo. */
      convidados.encerrarDoUsuario(usuarioId);
      barramento.emitir(EVENTOS.USUARIO_EXPULSO, { usuarioId, motivo: "removido da reunião" });

      if (sala.chamada_id) {
        await repos.chamadas.mudarEstado(sala.chamada_id, usuarioId, "saiu");
        const chamada = await repos.chamadas.porIdCru(sala.chamada_id);
        if (chamada) await chamadas.depoisDeAlguemSair(chamada, usuarioId);
      }

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "SALA_CONVIDADO_REMOVIDO", alvoTipo: "sala", alvoId: sala.id,
        detalhe: usuarioId,
      });
      return { ok: true };
    },

    async participantes(sessao, salaId) {
      if (sessao.ehConvidado) throw erros.semPermissao();
      const sala = await repos.salas.porId(sessao.contextoId, salaId);
      if (!sala) throw erros.naoEncontrado();
      if (sala.criada_por !== sessao.usuarioId && !sessao.ehAdmin) throw erros.semPermissao();
      return { convidados: await repos.salas.convidados(sala.id) };
    },

    /* ======================================================================
       DERRUBAR TUDO — quando a sala acaba, por tempo ou por revogação
       ====================================================================== */
    async derrubarSala(sala, motivo) {
      /* Os cookies primeiro: enquanto eles valerem, quem foi derrubado
         reentra. */
      convidados.encerrarDaSala(sala.id);

      if (sala.chamada_id) {
        const chamada = await repos.chamadas.porIdCru(sala.chamada_id);
        if (chamada && chamada.estado !== "encerrada") await chamadas.encerrar(chamada, "normal");
      }

      barramento.emitir(EVENTOS.SALA_ENCERRADA, {
        contextoId: sala.contexto_id,
        salaId: sala.id,
        conversaId: sala.conversa_id,
        motivo,
        paraIds: sala.chamada_id ? await repos.chamadas.dentro(sala.chamada_id) : [],
      });
    },

    /* ======================================================================
       O RELÓGIO — o aviso e o encerramento saem do SERVIDOR

       Poderiam sair do navegador, que já sabe a hora de fim. Não saem: o
       relógio do navegador é do visitante, e adiantá-lo ou atrasá-lo é um
       clique nas configurações do sistema operacional. O que encerra a reunião
       tem de ser o servidor.
       ====================================================================== */
    async faxina() {
      if (!V.ativo) return { avisadas: 0, encerradas: 0 };

      /* O aviso dos últimos minutos. A janela é a do domínio, e a marca em
         memória impede que ele seja repetido a cada volta da faxina. */
      const janela = dom.AVISO_MIN * 60_000;
      let avisadas = 0;
      for (const sala of await repos.salas.paraAvisar(janela)) {
        if (avisados.has(sala.id)) continue;
        avisados.add(sala.id);
        avisadas++;
        barramento.emitir(EVENTOS.SALA_AVISO, {
          contextoId: sala.contexto_id,
          salaId: sala.id,
          restanteMs: Math.max(0, Number(sala.encerra_em) - Date.now()),
          paraIds: sala.chamada_id ? await repos.chamadas.dentro(sala.chamada_id) : [],
        });
      }

      let encerradas = 0;
      for (const sala of await repos.salas.vencidas()) {
        await repos.salas.encerrar(sala.id, "encerrada");
        await servico.derrubarSala(sala, "tempo_esgotado");
        avisados.delete(sala.id);
        encerradas++;
      }

      return { avisadas, encerradas };
    },
  };

  /* Quem já foi avisado. Em memória: perder isso num reinício custa um aviso
     repetido, e gravar no banco custaria uma coluna e uma escrita para um
     dado que vale cinco minutos. */
  const avisados = new Set();

  return servico;
}

module.exports = { criarServicoDeSalas };
