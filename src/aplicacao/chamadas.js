/* ==========================================================================
   aplicacao/chamadas.js — os casos de uso da reunião

   ---------------------------------------------------------------------------
   A AUTORIZAÇÃO NÃO É NOVA, E ISSO É O PONTO

   Quem pode entrar numa chamada é exatamente quem é membro da conversa dela.
   Essa conferência já existe (`exigirMembro`), já vive dentro do SQL e já tem
   suíte de segurança em cima. O vídeo não traz superfície de autorização nova:
   ele pega carona na que já foi provada.

   A alternativa — sala com link, como o Teams — exigiria um conceito próprio
   de "quem entra", convite para gente de fora, sala de espera e expiração de
   link. Quatro lugares novos para errar, e cada um deles é um vazamento
   diferente.

   ---------------------------------------------------------------------------
   O SERVIDOR NÃO ENTENDE WebRTC

   Ele não lê SDP, não interpreta candidato ICE e não vê um frame de vídeo.
   O papel dele é o de uma telefonista: dizer quem está chamando quem, e
   repassar envelopes fechados entre pessoas que ele já sabe que podem falar.

   Isso é o que torna a malha possível sem servidor de mídia — e o que faz a
   conversa por vídeo ser, de fato, ponta a ponta (DTLS-SRTP é obrigatório no
   WebRTC; não é opcional e não é configuração).
   ========================================================================== */
"use strict";

const { erros } = require("../dominio/erros.js");
const { ehUlid } = require("../dominio/ids.js");
const dom = require("../dominio/chamadas.js");
const { EVENTOS } = require("../infra/eventos/barramento.js");

function criarServicoDeChamadas({ repos, conf, barramento, limites, turn, exigirMembro }) {
  const V = conf.video;

  function exigirVideoLigado() {
    if (!V.ativo)
      throw erros.invalido("As chamadas de vídeo não estão ativadas nesta instalação.");
  }

  /* A chamada tem de existir, estar viva, e a pessoa tem de ser membro da
     CONVERSA dela. As três coisas numa função só, porque separá-las é como se
     ganha uma rota que confere duas de três. */
  async function exigirChamada(sessao, chamadaId, { viva = true } = {}) {
    if (!ehUlid(chamadaId)) throw erros.naoEncontrado();
    const c = await repos.chamadas.porId(sessao.contextoId, chamadaId);
    if (!c) throw erros.naoEncontrado();
    if (viva && c.estado === "encerrada") throw erros.invalido("Esta chamada já terminou.");

    /* 404, e não 403: confirmar que a chamada existe entregaria o mapa de
       quais reuniões acontecem na empresa a quem só sabe variar um id. */
    await exigirMembro(sessao, c.conversa_id);
    return c;
  }

  const servico = {
    /* ======================================================================
       O ESTADO DA CONVERSA — "tem reunião rolando aqui?"

       Consultado ao abrir uma conversa. É o que faz quem chega depois ver o
       botão "Entrar na reunião" em vez de "Chamar".
       ====================================================================== */
    async daConversa(sessao, conversaId) {
      if (!V.ativo) return { ativo: false };
      await exigirMembro(sessao, conversaId);

      const c = await repos.chamadas.viva(conversaId);
      if (!c) return { ativo: true, chamada: null };

      const participantes = await repos.chamadas.participantes(c.id);
      return { ativo: true, chamada: paraFora(c, participantes, sessao.usuarioId) };
    },

    /* ======================================================================
       INICIAR
       ====================================================================== */
    async iniciar(sessao, conversaId) {
      exigirVideoLigado();
      const membro = await exigirMembro(sessao, conversaId);

      /* Tocar o telefone dos colegas é barato para quem chama e caro para quem
         recebe. Sem freio, é assédio de custo zero. */
      const freio = limites.conferir(`chamada:${sessao.usuarioId}`,
        { maximo: V.porHora, janelaMs: 3600e3 });
      if (!freio.ok) throw erros.demais(freio.esperar,
        "Você iniciou muitas chamadas na última hora. Aguarde um pouco.");

      const membros = await repos.conversas.idsDosMembros(conversaId);

      /* O teto vale já na porta: numa conversa de doze pessoas, uma reunião de
         vídeo em malha não existe. Melhor recusar com explicação do que abrir
         uma chamada que vai derrubar o áudio de todo mundo na sexta pessoa. */
      if (membros.length > V.teto) {
        throw erros.invalido(
          `Esta conversa tem ${membros.length} pessoas e a reunião por vídeo comporta ${V.teto}. ` +
          "Crie um grupo menor para a reunião.");
      }

      const { chamada, jaExistia } = await repos.chamadas.abrir({
        contextoId: sessao.contextoId,
        conversaId,
        iniciadaPor: sessao.usuarioId,
        tipo: membro.tipo === "grupo" ? "reuniao" : "direta",
        membros,
      });

      /* Já havia chamada: quem clicou ENTRA nela em vez de abrir outra. É o
         desfecho certo para o clique simultâneo — e para quem chega atrasado
         e aperta "chamar" sem ver que a reunião começou. */
      if (jaExistia) return servico.entrar(sessao, chamada.id);

      const tocarPara = dom.quemToca(membros, sessao.usuarioId);
      await repos.chamadas.marcarTocando(chamada.id, tocarPara);

      await repos.auditoria.registrar({
        contextoId: sessao.contextoId, usuarioId: sessao.usuarioId,
        evento: "CHAMADA_INICIADA", alvoTipo: "chamada", alvoId: chamada.id,
        detalhe: `${membros.length} convidados`,
      });

      const participantes = await repos.chamadas.participantes(chamada.id);
      barramento.emitir(EVENTOS.CHAMADA_TOCANDO, {
        contextoId: sessao.contextoId,
        conversaId,
        chamadaId: chamada.id,
        de: sessao.usuarioId,
        paraIds: tocarPara,
        chamada: paraFora(chamada, participantes, null),
      });

      return {
        ...paraFora(chamada, participantes, sessao.usuarioId),
        credenciais: turn.credenciais(sessao.usuarioId, {
          aberta: await repos.salas.ehDeSala(conversaId),
        }),
      };
    },

    /* ======================================================================
       ENTRAR
       ====================================================================== */
    async entrar(sessao, chamadaId) {
      exigirVideoLigado();
      const c = await exigirChamada(sessao, chamadaId);

      const r = await repos.chamadas.entrar(chamadaId, sessao.usuarioId, V.teto);
      if (!r.ok) {
        if (r.motivo === "lotada") throw erros.invalido(r.detalhe);
        if (r.motivo === "encerrada") throw erros.invalido("Esta chamada já terminou.");
        throw erros.naoEncontrado();
      }

      const participantes = await repos.chamadas.participantes(chamadaId);
      const atualizada = await repos.chamadas.porIdCru(chamadaId);

      if (!r.repetido) {
        barramento.emitir(EVENTOS.CHAMADA_ENTROU, {
          contextoId: sessao.contextoId,
          conversaId: c.conversa_id,
          chamadaId,
          usuarioId: sessao.usuarioId,
          /* Quem já está dentro é quem precisa saber — e é para eles que o
             cliente vai abrir uma conexão WebRTC nova. */
          paraIds: participantes.filter((p) => p.estado === "dentro").map((p) => p.usuario_id),
          participantes,
        });
      }

      return {
        ...paraFora(atualizada, participantes, sessao.usuarioId),
        /* As credenciais do TURN saem AQUI, e não numa rota separada: quem
           entrou é quem precisa delas, e emiti-las em qualquer outro lugar
           seria dar relay a quem não está em reunião nenhuma. */
        credenciais: turn.credenciais(sessao.usuarioId, {
          aberta: await repos.salas.ehDeSala(atualizada.conversa_id),
        }),
      };
    },

    /* ======================================================================
       SAIR — e o encerramento automático

       Quando o último sai, a chamada acaba. Sem isso ela ficaria "ativa" para
       sempre, e o índice único impediria qualquer outra reunião naquela
       conversa: o sintoma seria "o botão de chamar parou de funcionar".
       ====================================================================== */
    async sair(sessao, chamadaId) {
      const c = await exigirChamada(sessao, chamadaId, { viva: false });
      if (c.estado === "encerrada") return { ok: true, encerrada: true };

      await repos.chamadas.mudarEstado(chamadaId, sessao.usuarioId, "saiu");
      return servico.depoisDeAlguemSair(c, sessao.usuarioId);
    },

    async recusar(sessao, chamadaId) {
      const c = await exigirChamada(sessao, chamadaId, { viva: false });
      if (c.estado === "encerrada") return { ok: true, encerrada: true };

      await repos.chamadas.mudarEstado(chamadaId, sessao.usuarioId, "recusou");

      barramento.emitir(EVENTOS.CHAMADA_SAIU, {
        contextoId: sessao.contextoId, conversaId: c.conversa_id, chamadaId,
        usuarioId: sessao.usuarioId, motivo: "recusou",
        paraIds: await repos.chamadas.dentro(chamadaId),
      });

      /* Numa chamada direta, recusar acaba com ela: não há terceiro para
         continuar esperando. Em grupo, os outros continuam podendo entrar. */
      if (c.tipo === "direta") return servico.encerrar(c, "recusada");
      return { ok: true };
    },

    /* Chamado por `sair` e pela queda do socket. É o mesmo desfecho. */
    async depoisDeAlguemSair(chamada, usuarioId) {
      const dentro = await repos.chamadas.dentro(chamada.id);

      barramento.emitir(EVENTOS.CHAMADA_SAIU, {
        contextoId: chamada.contexto_id, conversaId: chamada.conversa_id,
        chamadaId: chamada.id, usuarioId, motivo: "saiu", paraIds: dentro,
      });

      /* Uma pessoa sozinha numa reunião não é reunião. Encerrar aqui é o que
         faz a linha do histórico dizer a duração certa em vez de contar o
         tempo que o último ficou olhando para a própria câmera. */
      if (dentro.length <= 1) {
        return servico.encerrar(chamada, dentro.length === 0 ? "normal" : "sozinho");
      }
      return { ok: true, dentro: dentro.length };
    },

    /* ======================================================================
       ENCERRAR — e a linha que fica na conversa
       ====================================================================== */
    async encerrar(chamada, motivo) {
      const fechou = await repos.chamadas.encerrar(chamada.id, motivo);
      if (!fechou) return { ok: true, encerrada: true };

      const atual = await repos.chamadas.porIdCru(chamada.id);
      const participantes = await repos.chamadas.participantes(chamada.id);

      const atendida = !!atual.atendida_em;
      const duracao = atendida ? Number(atual.encerrada_em) - Number(atual.atendida_em) : 0;
      const desfecho = dom.desfecho({
        atendida,
        participantes,
        encerradaPor: motivo === "sozinho" ? "sozinho" : "",
      });

      /* ==================================================================
         A MENSAGEM DE SISTEMA

         A chamada vira uma linha na conversa — como no WhatsApp e no Teams.
         O corpo é JSON, não frase: a frase depende de quem lê ("você perdeu"
         x "não atenderam") e gravá-la montada congelaria isso no banco,
         cifrado, para sempre. Ver dominio/chamadas.js.

         Falhar aqui não pode desfazer o encerramento: a chamada acabou de
         verdade, e uma exceção neste ponto deixaria o índice único travado.
         ================================================================== */
      try {
        const { mensagem } = await repos.mensagens.enviar({
          contextoId: chamada.contexto_id,
          conversaId: chamada.conversa_id,
          autorId: chamada.iniciada_por,
          tipo: "sistema",
          formato: "evento",
          idCliente: "chamada-" + chamada.id,
          corpo: dom.corpoDoEvento({
            chamadaId: chamada.id,
            motivo: desfecho,
            duracaoMs: duracao,
            participantes: Number(atual.pico || 0),
          }),
        });

        barramento.emitir(EVENTOS.MENSAGEM_ENVIADA, {
          contextoId: chamada.contexto_id,
          conversaId: chamada.conversa_id,
          mensagem,
          membros: await repos.conversas.idsDosMembros(chamada.conversa_id),
          autorId: null,
        });
      } catch (e) {
        console.error("  ⚠ não gravei a linha da chamada no histórico:", e.message);
      }

      await repos.auditoria.registrar({
        contextoId: chamada.contexto_id, usuarioId: chamada.iniciada_por,
        evento: "CHAMADA_ENCERRADA", alvoTipo: "chamada", alvoId: chamada.id,
        detalhe: `${desfecho} ${Math.round(duracao / 1000)}s pico=${atual.pico}`,
      });

      barramento.emitir(EVENTOS.CHAMADA_ENCERRADA, {
        contextoId: chamada.contexto_id,
        conversaId: chamada.conversa_id,
        chamadaId: chamada.id,
        motivo: desfecho,
        paraIds: participantes.map((p) => p.usuario_id),
      });

      return { ok: true, encerrada: true, motivo: desfecho };
    },

    /* ======================================================================
       DISPOSITIVOS — mudo, câmera, tela
       ====================================================================== */
    async dispositivos(sessao, chamadaId, estado) {
      const c = await exigirChamada(sessao, chamadaId);

      if (estado.tela && !V.tela)
        throw erros.invalido("Compartilhar tela está desativado nesta instalação.");

      const mudou = await repos.chamadas.definirDispositivos(chamadaId, sessao.usuarioId, {
        microfone: estado.microfone,
        camera: estado.camera,
        tela: estado.tela,
      });
      if (!mudou) throw erros.invalido("Você não está nesta chamada.");

      barramento.emitir(EVENTOS.CHAMADA_DISPOSITIVOS, {
        contextoId: sessao.contextoId, conversaId: c.conversa_id, chamadaId,
        usuarioId: sessao.usuarioId,
        microfone: estado.microfone, camera: estado.camera, tela: estado.tela,
        paraIds: await repos.chamadas.dentro(chamadaId),
      });
      return { ok: true };
    },

    /* ======================================================================
       SINALIZAR — o repasse de envelope fechado

       ESTA É A ROTA MAIS SENSÍVEL DO VÍDEO, porque ela repassa conteúdo
       arbitrário de uma pessoa para outra. As quatro travas, na ordem:

         1. FORMA — tipo de lista fechada e tamanho com teto (domínio).
         2. QUEM MANDA — é membro da conversa e está DENTRO da chamada.
         3. QUEM RECEBE — está DENTRO da mesma chamada.
         4. A ORIGEM É CARIMBADA PELO SERVIDOR. O campo `de` que vier do
            cliente é ignorado; quem diz de quem é o sinal é a sessão do
            socket. Sem isso, qualquer participante poderia se passar por
            outro e injetar uma oferta de mídia em nome dele.
       ====================================================================== */
    async sinalizar(sessao, chamadaId, sinal) {
      const forma = dom.validarSinal(sinal);
      if (!forma.ok) throw erros.invalido(forma.erro);

      const c = await exigirChamada(sessao, chamadaId);

      const dentro = await repos.chamadas.dentro(chamadaId);
      if (!dentro.includes(sessao.usuarioId))
        throw erros.invalido("Você não está nesta chamada.");
      if (!dentro.includes(sinal.para))
        throw erros.naoEncontrado("A pessoa saiu da chamada.");

      barramento.emitir(EVENTOS.CHAMADA_SINAL, {
        contextoId: sessao.contextoId,
        chamadaId,
        conversaId: c.conversa_id,
        /* Carimbado aqui. Nunca copiado do corpo. */
        de: sessao.usuarioId,
        paraIds: [sinal.para],
        tipo: sinal.tipo,
        dados: sinal.dados,
      });

      return { ok: true };
    },

    /* ======================================================================
       CREDENCIAIS — renovação no meio de uma reunião longa
       ====================================================================== */
    async credenciais(sessao, chamadaId) {
      const chamada = await exigirChamada(sessao, chamadaId);
      const dentro = await repos.chamadas.dentro(chamadaId);
      if (!dentro.includes(sessao.usuarioId))
        throw erros.invalido("Você não está nesta chamada.");
      /* A RENOVAÇÃO tem de responder a MESMA política da entrada. Devolvendo
         `all` aqui, uma reunião longa vazaria os endereços na primeira troca
         de credencial — duas horas depois, quando ninguém está olhando. */
      return turn.credenciais(sessao.usuarioId, {
        aberta: await repos.salas.ehDeSala(chamada?.conversa_id),
      });
    },

    /* ======================================================================
       QUANDO O SOCKET CAI

       Fechar a aba não manda "sair". Sem este caminho, a pessoa ficaria
       eternamente "dentro" da reunião para os outros — um retrato congelado no
       grid — e a chamada nunca encerraria sozinha.
       ====================================================================== */
    async socketCaiu(usuarioId) {
      try {
        const linhas = await repos.Q.all(
          `SELECT c.* FROM chamadas c
             JOIN chamada_participantes p ON p.chamada_id = c.id
            WHERE p.usuario_id = ? AND p.estado = 'dentro' AND c.estado <> 'encerrada'`,
          usuarioId);

        for (const c of linhas) {
          await repos.chamadas.mudarEstado(c.id, usuarioId, "saiu");
          await servico.depoisDeAlguemSair(c, usuarioId);
        }
      } catch (e) {
        console.error("  ⚠ falha ao tirar da chamada quem caiu:", e.message);
      }
    },

    /* ======================================================================
       FAXINA — as chamadas que ninguém encerrou

       O toque que ninguém atendeu, a reunião que ficou vazia porque o servidor
       reiniciou no meio. Sem isto, o índice único vira uma trava permanente na
       conversa e o botão de chamar "para de funcionar" para sempre.
       ====================================================================== */
    async faxina() {
      const fantasmas = await repos.chamadas.fantasmas({
        tocandoMs: V.tocandoMs,
        abandonoMs: dom.ABANDONO_MS,
      });
      for (const f of fantasmas) {
        const c = await repos.chamadas.porIdCru(f.id);
        if (c) await servico.encerrar(c, c.atendida_em ? "normal" : "ninguem_atendeu");
      }
      return fantasmas.length;
    },

    exigirChamada,
  };

  return servico;
}

/* ==========================================================================
   O QUE SAI PARA A TELA

   Sem nada de mídia (não existe) e sem o `contexto_id` (a tela não tem o que
   fazer com ele, e devolvê-lo só espalharia o identificador do inquilino).
   ========================================================================== */
function paraFora(c, participantes, euId) {
  return {
    id: c.id,
    conversaId: c.conversa_id,
    tipo: c.tipo,
    estado: c.estado,
    iniciadaPor: c.iniciada_por,
    iniciadaEm: Number(c.iniciada_em),
    atendidaEm: c.atendida_em ? Number(c.atendida_em) : null,
    souOIniciador: euId ? c.iniciada_por === euId : undefined,
    participantes: (participantes || []).map((p) => ({
      id: p.usuario_id,
      nome: [p.nome, p.sobrenome].filter(Boolean).join(" "),
      avatar: p.avatar || "",
      estado: p.estado,
      microfone: !!p.microfone,
      camera: !!p.camera,
      tela: !!p.tela,
      entrouEm: p.entrou_em ? Number(p.entrou_em) : null,
    })),
  };
}

module.exports = { criarServicoDeChamadas, paraFora };
