#!/usr/bin/env node
/* ==========================================================================
   INSTALAR / ATUALIZAR o conector do LA Chat num projeto hospedeiro

       node instalar-em.js ../BemEstarClinic
       node instalar-em.js ../BemEstarClinic --conferir
       node instalar-em.js --todos

   POR QUE UM SCRIPT, e não "copie o arquivo"

   O conector é um arquivo copiado para dentro de cada site. Isso é bom — o
   site não ganha dependência, não precisa de `npm install`, e continua de pé
   se o chat sumir. E tem um custo: a cópia ENVELHECE. Quando o conector ganha
   uma correção (a 1.1 corrigiu o repasse com prefixo próprio, que fazia todo
   endereço fora de `/chat` responder 404), cada site fica com a versão do dia
   em que foi instalado, e ninguém sabe qual é.

   Este script resolve as duas metades:

     · COPIAR é uma linha, para atualizar não depender de memória;
     · CONFERIR diz, sem alterar nada, quem está atrasado.

   Ele NÃO mexe no `server.js` nem no HTML do site. Essas duas linhas são
   escritas uma vez, à mão, e nunca mais — é o `lachat.js` que muda.
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RAIZ = __dirname;
const ORIGEM = path.join(RAIZ, "conector", "lachat.js");

/* Onde procurar hospedeiros quando se pede `--todos`: a pasta que contém o
   próprio LA-Chat. É como o parque está organizado — um projeto por pasta,
   todos lado a lado. */
const PARQUE = path.dirname(RAIZ);

const versaoDe = (texto) => (/VERSAO_CONECTOR\s*=\s*"([^"]+)"/.exec(texto) || [])[1] || "?";

function ler(arquivo) {
  try { return fs.readFileSync(arquivo, "utf8"); } catch { return null; }
}

function estado(destino) {
  const alvo = path.join(destino, "lachat.js");
  const atual = ler(alvo);
  const novo = fs.readFileSync(ORIGEM, "utf8");
  if (atual === null) return { alvo, situacao: "ausente", versao: null, novaVersao: versaoDe(novo) };
  if (atual === novo) return { alvo, situacao: "em dia", versao: versaoDe(atual), novaVersao: versaoDe(novo) };
  return { alvo, situacao: "desatualizado", versao: versaoDe(atual), novaVersao: versaoDe(novo) };
}

/* Um projeto é hospedeiro se já tem o conector OU se o `server.js` o chama.
   A segunda condição pega o caso de alguém ter apagado o arquivo por engano —
   e é exatamente o caso em que a instalação precisa ser refeita. */
function ehHospedeiro(dir) {
  if (fs.existsSync(path.join(dir, "lachat.js"))) return true;
  const s = ler(path.join(dir, "server.js"));
  return !!(s && /require\(["']\.\/lachat["']\)/.test(s));
}

function instalar(destino, apenasConferir) {
  const e = estado(destino);
  const nome = path.basename(destino);

  if (apenasConferir) {
    const marca = e.situacao === "em dia" ? "✔" : e.situacao === "ausente" ? "—" : "⬆";
    console.log(`  ${marca} ${nome.padEnd(22)} ${String(e.versao || "não instalado").padEnd(16)}` +
      (e.situacao === "desatualizado" ? `→ ${e.novaVersao}` : ""));
    return e.situacao === "desatualizado" ? 1 : 0;
  }

  if (e.situacao === "em dia") {
    console.log(`  ✔ ${nome}: já está na ${e.versao}`);
    return 0;
  }

  /* Cópia ATÔMICA: escreve ao lado e renomeia. Uma escrita interrompida no meio
     deixaria o site com um `lachat.js` truncado — e o `require` dele acontece
     no boot, então o site inteiro pararia de subir por causa do chat. */
  const tmp = e.alvo + ".novo";
  fs.copyFileSync(ORIGEM, tmp);
  fs.renameSync(tmp, e.alvo);

  console.log(e.situacao === "ausente"
    ? `  + ${nome}: conector ${e.novaVersao} instalado`
    : `  ⬆ ${nome}: ${e.versao} → ${e.novaVersao}`);

  /* Instalar o arquivo é METADE do trabalho. As duas linhas do `server.js` são
     escritas à mão, e é justamente delas que alguém esquece — em especial a do
     `upgrade`, cuja ausência não quebra nada visivelmente: o chat carrega,
     autentica, e mensagem nenhuma chega em tempo real. */
  const s = ler(path.join(destino, "server.js")) || "";
  const faltando = [];
  if (!/require\(["']\.\/lachat["']\)/.test(s)) faltando.push('const chat = require("./lachat")({ … })');
  if (!/\.rota\(req,\s*res\)/.test(s)) faltando.push("if (chat.rota(req, res)) return;   // no topo do handler");
  if (!/conectarUpgrade\(/.test(s)) faltando.push("chat.conectarUpgrade(servidor);     // o WebSocket");
  if (faltando.length) {
    console.log(`     ⚠ falta no server.js de ${nome}:`);
    for (const f of faltando) console.log(`        ${f}`);
    console.log("        ver conector/INSTALAR.md");
  }
  return 0;
}

/* --------------------------------------------------------------------- */
const args = process.argv.slice(2);
const apenasConferir = args.includes("--conferir");
const todos = args.includes("--todos");
const alvos = args.filter((a) => !a.startsWith("--"));

if (!fs.existsSync(ORIGEM)) {
  console.error("  ✖ não achei conector/lachat.js — rode a partir da pasta do LA-Chat.");
  process.exit(1);
}

console.log(`\n  LA Chat — conector ${versaoDe(fs.readFileSync(ORIGEM, "utf8"))}\n`);

let lista;
if (todos) {
  lista = fs.readdirSync(PARQUE)
    .map((n) => path.join(PARQUE, n))
    .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } })
    .filter((d) => d !== RAIZ)
    .filter(ehHospedeiro);
  if (!lista.length) {
    console.log("  nenhum projeto com o conector instalado.\n");
    process.exit(0);
  }
} else if (alvos.length) {
  lista = alvos.map((a) => path.resolve(a));
} else {
  console.log("  uso:\n" +
    "    node instalar-em.js <pasta-do-site>      instala ou atualiza\n" +
    "    node instalar-em.js <pasta> --conferir   só diz se está atrasado\n" +
    "    node instalar-em.js --todos              em todos os hospedeiros\n" +
    "    node instalar-em.js --todos --conferir   panorama do parque\n");
  process.exit(0);
}

let atrasados = 0;
for (const d of lista) {
  if (!fs.existsSync(d)) { console.error(`  ✖ não existe: ${d}`); process.exitCode = 1; continue; }
  atrasados += instalar(d, apenasConferir);
}

if (apenasConferir && atrasados) {
  console.log(`\n  ${atrasados} projeto(s) atrasado(s). Atualize com: node instalar-em.js --todos\n`);
  /* Sai com erro DE PROPÓSITO: assim isto serve de passo de CI e de verificação
     no deploy, sem precisar de um segundo script que interprete a saída. */
  process.exit(1);
}
console.log("");
