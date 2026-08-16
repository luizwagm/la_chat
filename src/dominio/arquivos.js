/* ==========================================================================
   dominio/arquivos.js — o que é este arquivo, de verdade (§10, §11)

   "NUNCA CONFIE APENAS NA EXTENSÃO" é a frase do briefing. Mas a extensão é só
   a primeira de TRÊS mentiras possíveis, e tratar só ela deixa duas abertas:

     1. a EXTENSÃO é escolhida por quem envia      → `virus.exe` vira `foto.jpg`
     2. o `Content-Type` é escolhido por quem envia → o formulário diz o que quiser
     3. os BYTES são a única coisa que não mente    → é o que este arquivo lê

   As três precisam CONCORDAR. Um arquivo que se diz `image/png`, termina em
   `.png` e começa com `MZ` (executável do Windows) é recusado — e essa
   discordância é, ela mesma, o sinal mais claro de tentativa de ataque que um
   upload pode dar.

   ---------------------------------------------------------------------------
   POR QUE ISSO IMPORTA MESMO COM A PASTA FORA DO nginx

   Alguém pode objetar: "os arquivos ficam fora da pasta pública e só saem por
   rota autenticada, então um `.php` enviado nunca seria executado". Correto —
   e mesmo assim a conferência é necessária, porque o alvo não é só o servidor:

   · o arquivo vai ser BAIXADO por um colega, no computador dele;
   · um SVG com `<script>` dentro executa no navegador de quem o abrir, no
     domínio do chat, com o cookie dele — é XSS armazenado com cara de imagem;
   · um HTML enviado como "documento" faz o mesmo.

   Por isso `image/svg+xml` NÃO está na lista de tipos permitidos do
   `config.js`, e por isso todo download sai com `Content-Disposition:
   attachment` e `X-Content-Type-Options: nosniff`.
   ========================================================================== */
"use strict";

const path = require("node:path");

/* ==========================================================================
   ASSINATURAS — os primeiros bytes de cada formato

   `deslocamento` existe porque nem toda assinatura começa no byte 0: o WebP e
   o WAV têm "RIFF" no início e o tipo real no byte 8.
   ========================================================================== */
const ASSINATURAS = [
  { mime: "image/jpeg", bytes: [0xFF, 0xD8, 0xFF] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },                       // GIF8
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] , confirma: { deslocamento: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },                 // %PDF
  /* ZIP, e tudo que é ZIP por dentro: .docx, .xlsx, .pptx. Os bytes são os
     mesmos — distinguir docx de zip exigiria abrir o pacote. O que se faz aqui
     é aceitar a FAMÍLIA e deixar a lista branca de `config.js` decidir se
     aquele tipo declarado é permitido. */
  { mime: "application/zip", bytes: [0x50, 0x4B, 0x03, 0x04] },
  { mime: "application/zip", bytes: [0x50, 0x4B, 0x05, 0x06] },                 // zip vazio
];

/* ==========================================================================
   O QUE NUNCA PASSA, mesmo que o tipo declarado esteja na lista branca.

   Esta é a lista NEGRA — e ela existe apesar de o projeto inteiro preferir
   lista branca. O motivo: a lista branca já decide o que ENTRA; esta aqui é
   uma segunda tranca contra o caso em que alguém, um dia, acrescenta um tipo
   perigoso à configuração sem perceber (`text/html` parece inofensivo).
   ========================================================================== */
const CONTEUDO_EXECUTAVEL = [
  { rotulo: "executável do Windows", bytes: [0x4D, 0x5A] },                      // MZ
  { rotulo: "executável ELF (Linux)", bytes: [0x7F, 0x45, 0x4C, 0x46] },
  { rotulo: "classe Java", bytes: [0xCA, 0xFE, 0xBA, 0xBE] },
  { rotulo: "script com shebang", bytes: [0x23, 0x21] },                         // #!
];

/* Extensões perigosas em QUALQUER posição do nome. `.php` no fim é o óbvio;
   `foto.php.jpg` é o truque contra servidores mal configurados que executam
   pela extensão do meio. */
const EXTENSOES_PROIBIDAS = /\.(php\d?|phtml|phar|asp|aspx|jsp|jspx|cgi|pl|py|rb|sh|bash|exe|com|scr|bat|cmd|ps1|vbs|vbe|js|mjs|jar|msi|dll|so|app|dmg|lnk|hta|reg|htaccess|svg|html?|xhtml)(\.|$)/i;

function combina(buffer, assinatura) {
  const { bytes, confirma } = assinatura;
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buffer[i] !== bytes[i]) return false;
  if (confirma) {
    const { deslocamento, bytes: b2 } = confirma;
    if (buffer.length < deslocamento + b2.length) return false;
    for (let i = 0; i < b2.length; i++) if (buffer[deslocamento + i] !== b2[i]) return false;
  }
  return true;
}

/* O tipo REAL, lido dos bytes. `null` = formato não reconhecido, que não é o
   mesmo que "perigoso": um .txt ou .csv não tem assinatura nenhuma. */
function tipoPelosBytes(buffer) {
  for (const a of ASSINATURAS) if (combina(buffer, a)) return a.mime;
  return null;
}

function pareceExecutavel(buffer) {
  for (const e of CONTEUDO_EXECUTAVEL) if (combina(buffer, e)) return e.rotulo;
  return null;
}

/* ==========================================================================
   NOME SEGURO

   O nome enviado NUNCA vira nome no disco (o disco recebe um ULID). Este
   saneamento serve para o nome que é GUARDADO e EXIBIDO — e ele ainda precisa
   ser seguro, porque vai para um cabeçalho HTTP no download, onde uma quebra
   de linha permitiria injetar cabeçalhos.
   ========================================================================== */
function nomeSeguro(bruto) {
  let n = String(bruto || "arquivo")
    /* `path.basename` tira `../` e `C:\...`. Fazer isso primeiro impede que o
       resto do saneamento seja aplicado a um caminho e produza algo que ainda
       navegue diretórios. */
    .split(/[\\/]/).pop();

  n = n
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\r\n]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .replace(/^\.+/, "");             // nome começando com ponto vira oculto

  if (!n) n = "arquivo";
  /* 180 caracteres, preservando a extensão: cortar pelo fim produziria
     "relatorio-muito-longo-com-nome-gig" sem extensão nenhuma. */
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}

/* ==========================================================================
   A CONFERÊNCIA COMPLETA
   ========================================================================== */
function conferir({ nome, tipoDeclarado, buffer, tamanho, tiposPermitidos, tamanhoMaximo }) {
  const limpo = nomeSeguro(nome);

  if (!tamanho || tamanho <= 0) return { ok: false, erro: "arquivo vazio" };
  if (tamanho > tamanhoMaximo)
    return { ok: false, erro: `arquivo passa do limite de ${Math.round(tamanhoMaximo / 1024 / 1024)} MB` };

  if (EXTENSOES_PROIBIDAS.test(limpo))
    return { ok: false, erro: "este tipo de arquivo não é aceito" };

  const executavel = pareceExecutavel(buffer);
  if (executavel) return { ok: false, erro: "o conteúdo do arquivo é um programa", detalhe: executavel };

  const declarado = String(tipoDeclarado || "").split(";")[0].trim().toLowerCase();
  if (!tiposPermitidos.includes(declarado))
    return { ok: false, erro: "este tipo de arquivo não é aceito", detalhe: declarado };

  const real = tipoPelosBytes(buffer);

  /* Formato SEM assinatura (texto, csv): os bytes não confirmam nem desmentem.
     Aceita-se o declarado, porque já passou pela lista branca, pela extensão e
     pela checagem de executável. */
  if (!real) {
    if (declarado.startsWith("text/")) return { ok: true, nome: limpo, tipo: declarado, tipoReal: null };
    return { ok: false, erro: "não foi possível reconhecer o conteúdo do arquivo" };
  }

  /* A família ZIP cobre os formatos do Office. Um `.docx` legítimo tem
     assinatura de ZIP, e isso é correto — não é discordância. */
  const familiaZip = real === "application/zip" && (
    declarado === "application/zip" ||
    declarado.startsWith("application/vnd.openxmlformats-officedocument."));

  if (real !== declarado && !familiaZip)
    return { ok: false, erro: "o conteúdo do arquivo não corresponde ao tipo informado",
             detalhe: `declarado ${declarado}, real ${real}` };

  return {
    ok: true,
    nome: limpo,
    tipo: declarado,
    tipoReal: real,
    ehImagem: real.startsWith("image/"),
  };
}

module.exports = { conferir, nomeSeguro, tipoPelosBytes, pareceExecutavel, EXTENSOES_PROIBIDAS };
