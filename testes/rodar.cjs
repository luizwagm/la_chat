/* ==========================================================================
   testes/rodar.cjs — todas as suítes, em ordem

       npm test

   A ORDEM NÃO É ARBITRÁRIA. Vai do mais rápido e mais específico para o mais
   lento e mais amplo:

       unidade    → não sobe nada. Falhou aqui, nada mais importa.
       integração → sobe o chat. Prova o sistema por HTTP.
       tempo real → sobe o chat. Prova o WebSocket e a reconexão.
       segurança  → sobe o chat. Prova que o ABUSO falha.
       e2e        → sobe o chat E o hospedeiro. Prova a INSTALAÇÃO.

   Cada suíte roda em PROCESSO PRÓPRIO, em porta própria, com banco próprio.
   Rodá-las no mesmo processo faria uma herdar o estado da outra — e um teste
   que só passa quando roda depois de outro é pior que teste nenhum, porque
   mente com aparência de prova.
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const SUITES = [
  { nome: "unidade", arquivo: "unidade.cjs" },
  /* Fusão logo depois da unidade: não sobe servidor, roda em banco de
     brinquedo e é a única operação sem volta do sistema. */
  { nome: "fusão", arquivo: "fusao.cjs" },
  { nome: "integração", arquivo: "integracao.cjs" },
  { nome: "tempo real", arquivo: "realtime.cjs" },
  { nome: "vídeo", arquivo: "video.cjs" },
  { nome: "salas", arquivo: "salas.cjs" },
  { nome: "segurança", arquivo: "seguranca.cjs" },
  { nome: "e2e", arquivo: "e2e.cjs" },
];

function rodarSuite(arquivo) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, arquivo)], {
      stdio: "inherit", cwd: path.join(__dirname, ".."),
    });
    p.on("close", (codigo) => resolve(codigo === 0));
  });
}

(async () => {
  const so = process.argv[2];
  const alvo = so ? SUITES.filter((s) => s.nome.startsWith(so) || s.arquivo.startsWith(so)) : SUITES;

  if (!alvo.length) {
    console.error(`\n  Não conheço a suíte "${so}". Use uma de: ${SUITES.map((s) => s.nome).join(", ")}\n`);
    process.exit(1);
  }

  const resultado = [];
  for (const s of alvo) {
    console.log(`\n${"═".repeat(62)}\n  ${s.nome.toUpperCase()}\n${"═".repeat(62)}`);
    resultado.push({ nome: s.nome, ok: await rodarSuite(s.arquivo) });
  }

  console.log(`\n${"═".repeat(62)}`);
  for (const r of resultado) console.log(`  ${r.ok ? "✓" : "✗"}  ${r.nome}`);
  const falhou = resultado.filter((r) => !r.ok);
  console.log(falhou.length
    ? `\n  ${falhou.length} suíte(s) falharam.\n`
    : `\n  Tudo passou.\n`);

  process.exit(falhou.length ? 1 : 0);
})();
