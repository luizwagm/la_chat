/* Conta as tabelas de um SQLite. Existe para o `ensaiar.sh` poder provar que a
   migração criou o banco de verdade — sem embutir JavaScript dentro de aspas
   no shell, que é onde o escape se perde e o teste passa a mentir. */
"use strict";
const { DatabaseSync } = require("node:sqlite");

const arquivo = process.argv[2];
if (!arquivo) { console.log(0); process.exit(0); }

try {
  const db = new DatabaseSync(arquivo);
  const { c } = db.prepare(
    "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table'").get();
  console.log(c);
} catch {
  console.log(0);
}
