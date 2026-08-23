/* ==========================================================================
   storage/armazenamento.js — a interface, e o driver local (§23)

   O briefing pede uma abstração de storage para permitir S3, R2 ou MinIO
   depois. A abstração aqui é DELIBERADAMENTE ESTREITA — cinco métodos:

       gravar(bytes, {sufixo})  → devolve um "caminho" opaco
       ler(caminho)             → Buffer
       fluxo(caminho)           → ReadStream (para download sem carregar tudo)
       remover(caminho)
       existe(caminho)

   Estreita porque é isso que a torna verdadeira. Uma interface de storage que
   vaza `path.join`, permissão de arquivo ou `fs.stat` não é uma interface: é o
   sistema de arquivos com outro nome, e o dia da troca por S3 descobre-se que
   metade do código chamava `fs` direto.

   O CAMINHO É OPACO. Quem chama guarda a string e devolve depois. Ela é um
   caminho relativo no driver local e vira uma chave no S3 — e nenhum código
   acima daqui deve interpretá-la.
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const { ulid } = require("../../dominio/ids.js");
const cripto = require("../seguranca/cripto.js");

function criarLocal({ pasta }) {
  fs.mkdirSync(pasta, { recursive: true });

  /* ==========================================================================
     A TRAVA CONTRA TRAVESSIA DE DIRETÓRIO

     Toda leitura passa por aqui. Mesmo que o caminho venha do banco — e no
     caminho normal ele vem —, a conferência acontece: o dia em que uma rota
     nova aceitar caminho de outro lugar, ela já nasce protegida.

     `path.resolve` normaliza `..`, e a comparação é feita sobre o resultado
     ABSOLUTO. Comparar as strings ANTES de resolver é o erro clássico:
     `dados/arquivos/../../etc/passwd` não contém nada suspeito depois de um
     `replace("../", "")` ingênuo, mas resolve para fora.
     ========================================================================== */
  const raiz = path.resolve(pasta);
  function caminhoReal(relativo) {
    const alvo = path.resolve(raiz, String(relativo || ""));
    /* O separador no fim impede que `/dados/arquivos-outro` passe por estar
       dentro de `/dados/arquivos` só por começar com o mesmo texto. */
    if (alvo !== raiz && !alvo.startsWith(raiz + path.sep))
      throw new Error("caminho fora da pasta de arquivos");
    return alvo;
  }

  return {
    tipo: "local",

    /* ======================================================================
       GRAVAR

       O nome no disco é um ULID — NUNCA o nome enviado. Isso mata travessia
       de diretório na origem (não há o que sanear se o nome não é usado) e
       impede que dois arquivos com o mesmo nome se sobrescrevam.

       As pastas são divididas por ANO/MÊS. Não é organização: é que um
       diretório com centenas de milhares de arquivos fica lento para listar e
       para abrir em alguns sistemas de arquivos, e um chat corporativo chega lá.
       ====================================================================== */
    async gravar(bytes, { sufixo = "" } = {}) {
      const agora = new Date();
      const ano = String(agora.getUTCFullYear());
      const mes = String(agora.getUTCMonth() + 1).padStart(2, "0");
      const nome = ulid() + (sufixo ? "." + String(sufixo).replace(/[^a-z0-9]/gi, "").slice(0, 8) : "");
      const relativo = path.posix.join(ano, mes, nome);

      const alvo = caminhoReal(relativo);
      await fsp.mkdir(path.dirname(alvo), { recursive: true });

      /* Grava em temporário e renomeia. Se faltar energia no meio, fica um
         `.tmp` órfão em vez de um anexo pela metade que o banco jura estar
         inteiro. */
      /* ====================================================================
         CIFRADO EM DISCO.

         Até a 0.11.0 o banco era cifrado e o anexo não — uma assimetria que
         ninguém espera: quem levasse um backup lia os arquivos e não lia as
         conversas. E o arquivo é justamente onde mora o exame, o contrato, a
         foto.

         O que se grava é `cifrarBytes`; o `tamanho` e o `hash` devolvidos
         continuam sendo os do conteúdo EM CLARO, de propósito: eles são o que
         o usuário vê na tela e o que o download declara. Trocá-los pelos do
         arquivo cifrado faria o `Content-Length` mentir em 33 bytes e a
         conferência de integridade acusar corrupção em todo download.
         ==================================================================== */
      const tmp = alvo + ".tmp";
      await fsp.writeFile(tmp, cripto.cifrarBytes(bytes), { mode: 0o600 });
      await fsp.rename(tmp, alvo);

      return {
        caminho: relativo,
        tamanho: bytes.length,
        /* O hash serve para conferir integridade no download e para detectar
           o mesmo arquivo enviado duas vezes. */
        hash: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    },

    async ler(relativo) {
      return cripto.decifrarBytes(await fsp.readFile(caminhoReal(relativo)));
    },

    /* Download por FLUXO. Um anexo de 10 MB lido inteiro para a memória, vezes
       vinte pessoas baixando ao mesmo tempo, são 200 MB de pico num servidor
       que hospeda vinte sites. O fluxo entrega em pedaços. */
    /* ======================================================================
       O FLUXO, COM A TAG QUE MORA NO FIM

       Decifrar em fluxo tem um problema de ordem: o GCM só autentica quando
       recebe a tag, e a tag está no ÚLTIMO bloco do arquivo. Ler linearmente
       não serve — quando ela chegasse, os bytes já teriam ido para o navegador.

       Então: abre o arquivo, lê os 17 bytes do começo (é nosso?), lê os 16 do
       FIM (a tag), e só então põe o miolo para correr através do decifrador. É
       uma busca no arquivo antes de começar, e é o que permite manter o
       download em pedaços — vinte pessoas baixando 10 MB não podem virar
       200 MB de pico num servidor que hospeda vinte sites.

       Arquivo sem o selo é anexo anterior à cifra: sai direto, como sempre saiu.
       ====================================================================== */
    fluxo(relativo) {
      const alvo = caminhoReal(relativo);
      const saida = new PassThrough();

      (async () => {
        let fd;
        try {
          fd = await fsp.open(alvo, "r");
          const info = await fd.stat();

          const cabecalho = Buffer.alloc(cripto.TAM_CABECALHO);
          const { bytesRead } = await fd.read(cabecalho, 0, cabecalho.length, 0);
          const cab = bytesRead === cabecalho.length ? cripto.lerCabecalho(cabecalho) : null;

          if (!cab) {
            await fd.close(); fd = null;
            fs.createReadStream(alvo).on("error", (e) => saida.destroy(e)).pipe(saida);
            return;
          }

          const tag = Buffer.alloc(cripto.TAM_TAG);
          await fd.read(tag, 0, tag.length, info.size - cripto.TAM_TAG);

          const decifrador = cripto.decifradorDeFluxo({ versao: cab.versao, iv: cab.iv, tag });

          const corpo = fd.createReadStream({
            start: cripto.TAM_CABECALHO,
            end: info.size - cripto.TAM_TAG - 1,
            autoClose: true,
          });
          fd = null;   // o fluxo passa a ser dono do descritor

          corpo.on("error", (e) => saida.destroy(e));
          /* Um erro do decifrador aqui é a TAG NÃO CONFERINDO: o arquivo foi
             alterado no disco. Destruir o fluxo é o certo — melhor download
             interrompido que bytes adulterados entregues como íntegros. */
          decifrador.on("error", (e) => saida.destroy(e));
          corpo.pipe(decifrador).pipe(saida);
        } catch (e) {
          try { await fd?.close(); } catch { }
          saida.destroy(e);
        }
      })();

      return saida;
    },

    async existe(relativo) {
      try { await fsp.access(caminhoReal(relativo)); return true; } catch { return false; }
    },

    async remover(relativo) {
      try { await fsp.unlink(caminhoReal(relativo)); return true; } catch { return false; }
    },

    /* O tamanho do CONTEÚDO, não o do arquivo. Num arquivo cifrado eles
       diferem pelos 33 bytes de selo, IV e tag — e quem pergunta o tamanho
       quer saber quanto vai baixar. */
    async tamanho(relativo) {
      try {
        const alvo = caminhoReal(relativo);
        const bruto = (await fsp.stat(alvo)).size;
        const cabecalho = Buffer.alloc(cripto.TAM_CABECALHO);
        const fd = await fsp.open(alvo, "r");
        try {
          const { bytesRead } = await fd.read(cabecalho, 0, cabecalho.length, 0);
          const nosso = bytesRead === cabecalho.length && !!cripto.lerCabecalho(cabecalho);
          return nosso ? bruto - cripto.TAM_CABECALHO - cripto.TAM_TAG : bruto;
        } finally { await fd.close(); }
      } catch { return 0; }
    },
  };
}

/* ==========================================================================
   A FÁBRICA

   Hoje só existe `local`. O `default` do switch RECUSA em vez de cair no
   local: um `CHAT_STORAGE=s3` digitado por engano tem de parar o serviço, e
   não gravar silenciosamente no disco de um servidor que o operador acha que
   está usando a nuvem.
   ========================================================================== */
function criar(conf) {
  const driver = (conf.driver || "local").toLowerCase();
  switch (driver) {
    case "local": return criarLocal({ pasta: conf.pasta });
    default:
      throw new Error(`CHAT_STORAGE="${driver}" não existe — hoje só há "local". Ver docs/STORAGE.md`);
  }
}

module.exports = { criar, criarLocal };
