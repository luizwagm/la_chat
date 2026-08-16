/* ==========================================================================
   http/responder.js — resposta, leitura de corpo e os cabeçalhos de segurança

   Tudo que sai do servidor passa por aqui. É o que torna possível afirmar
   "toda resposta tem `nosniff`" — afirmação que ninguém consegue fazer quando
   cada rota monta os próprios cabeçalhos.
   ========================================================================== */
"use strict";

const { ErroDoChat } = require("../dominio/erros.js");

/* ==========================================================================
   CABEÇALHOS DE SEGURANÇA — em TODA resposta

   Cada um resolve um ataque concreto:

   · nosniff        o navegador para de adivinhar o tipo do conteúdo. Sem ele,
                    um .txt com HTML dentro pode ser tratado como HTML e
                    executar script.
   · DENY (frame)   ninguém embute o chat num iframe invisível para roubar
                    clique (clickjacking, §17). O chat é embutido por SCRIPT,
                    não por iframe — então negar tudo não custa nada.
   · no-referrer    a URL do chat (que pode conter id de conversa) não vaza
                    para sites de terceiros quando alguém clica num link.
   · no-store       resposta de API não fica no cache do navegador nem em
                    proxy. Conteúdo de conversa em cache é conteúdo que
                    sobrevive ao logout, no computador compartilhado.
   ========================================================================== */
const SEGURANCA = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

function responder(res, status, corpo, cabecalhos = {}) {
  if (res.writableEnded) return;
  const texto = corpo === undefined || corpo === null ? "" : JSON.stringify(corpo);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(texto),
    ...SEGURANCA,
    ...cabecalhos,
  });
  res.end(texto);
}

/* ==========================================================================
   ERRO

   A regra do §57, aplicada num lugar só:

     · erro NOSSO (`ErroDoChat`)  → a mensagem vai para o usuário; ela foi
                                    escrita para ser lida.
     · QUALQUER OUTRO            → 500 com texto genérico. Um erro não previsto
                                    é, por definição, um erro cujo texto
                                    ninguém revisou — e o texto de um erro de
                                    banco traz nome de tabela e caminho de
                                    arquivo no servidor.

   O detalhe técnico vai para o log. Sempre. Trocar por silêncio deixaria o
   operador sem nada quando o cliente ligasse dizendo "deu erro".
   ========================================================================== */
function responderErro(res, e, contexto = "") {
  if (e instanceof ErroDoChat) {
    if (e.detalhe && process.env.CHAT_DEBUG) console.warn(`  · ${contexto}: ${e.message} (${e.detalhe})`);
    return responder(res, e.status, { erro: e.message, codigo: e.codigo });
  }
  console.error(`  ✖ ${contexto || "erro"}:`, e?.message || e);
  if (process.env.CHAT_DEBUG) console.error(e);
  return responder(res, 500, { erro: "Algo deu errado do nosso lado. Tente de novo.", codigo: "interno" });
}

/* ==========================================================================
   LER O CORPO

   O TETO É CONFERIDO ENQUANTO CHEGA, e não no fim. Esperar o fim para depois
   reclamar do tamanho significa que os 500 MB já foram para a memória — o
   ataque já aconteceu, e a recusa é só o epitáfio.

   `Content-Length` também é conferido antes, mas ele é escrito pelo cliente e
   pode mentir; quem realmente protege é a contagem durante a leitura.
   ========================================================================== */
function lerCorpo(req, tetoBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const anunciado = Number(req.headers["content-length"] || 0);
    if (anunciado && anunciado > tetoBytes) {
      /* `resume()` descarta o que vier: sem isso, o socket fica com o corpo
         preso no buffer e a conexão não é liberada. */
      req.resume();
      return reject(new ErroDoChat("Conteúdo grande demais.", { status: 413, codigo: "grande_demais" }));
    }

    const pedacos = [];
    let total = 0;
    let encerrado = false;

    req.on("data", (p) => {
      if (encerrado) return;
      total += p.length;
      if (total > tetoBytes) {
        encerrado = true;
        req.destroy();
        return reject(new ErroDoChat("Conteúdo grande demais.", { status: 413, codigo: "grande_demais" }));
      }
      pedacos.push(p);
    });
    req.on("end", () => { if (!encerrado) resolve(Buffer.concat(pedacos)); });
    req.on("error", (e) => { if (!encerrado) reject(e); });
  });
}

async function lerJson(req, tetoBytes = 256 * 1024) {
  const bruto = await lerCorpo(req, tetoBytes);
  if (!bruto.length) return {};
  try {
    const v = JSON.parse(bruto.toString("utf8"));
    /* Só objeto. Um array ou um número como corpo faria `corpo.texto` ser
       `undefined` silenciosamente em vez de recusar a requisição. */
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new ErroDoChat("Formato inválido.", { status: 400 });
    return v;
  } catch (e) {
    if (e instanceof ErroDoChat) throw e;
    throw new ErroDoChat("Não entendi o que foi enviado.", { status: 400, codigo: "json_invalido" });
  }
}

module.exports = { responder, responderErro, lerCorpo, lerJson, SEGURANCA };
