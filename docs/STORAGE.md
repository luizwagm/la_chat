# STORAGE.md — anexos

## A regra que sustenta tudo

**Arquivo enviado nunca fica numa pasta servida pelo nginx.**

Ele vai para `dados/arquivos/`, e todo download passa por uma rota que confere
se quem pede é **membro da conversa**. É isso que fecha o IDOR do §11: trocar o
id na URL devolve 404, não o anexo de outra conversa.

---

## A interface

Cinco métodos, deliberadamente estreitos (`src/infra/storage/armazenamento.js`):

```
gravar(bytes, {sufixo}) → { caminho, tamanho, hash }
ler(caminho)            → Buffer
fluxo(caminho)          → ReadStream
existe(caminho)         → boolean
remover(caminho)        → boolean
```

Estreita porque é isso que a torna verdadeira. Uma interface de storage que vaza
`path.join`, permissão de arquivo ou `fs.stat` não é uma interface: é o sistema
de arquivos com outro nome, e no dia da troca por S3 descobre-se que metade do
código chamava `fs` direto.

**O caminho é opaco.** Quem chama guarda a string e devolve depois — é um
caminho relativo no driver local e vira uma chave no S3.

---

## Como o arquivo é gravado

```
dados/arquivos/2026/08/01M0048JXZPMS58EXBWE1S6K2Z.bin
                └──┬──┘ └────────────┬────────────┘
                 ano/mês         ULID gerado
```

- **O nome no disco é um ULID, nunca o nome enviado.** Isso mata travessia de
  diretório na origem: não há o que sanear se o nome não é usado. E impede que
  dois arquivos com o mesmo nome se sobrescrevam.
- **Pastas por ano/mês** — não é organização: um diretório com centenas de
  milhares de arquivos fica lento em alguns sistemas de arquivos, e um chat
  corporativo chega lá.
- **Grava em temporário e renomeia.** Falta de energia no meio deixa um `.tmp`
  órfão em vez de um anexo pela metade que o banco jura estar inteiro.
- **Modo 600.**
- O **nome original** vai cifrado para o banco — nome de arquivo é conteúdo:
  `rescisao-joao-silva.pdf` conta a história inteira sem ninguém abrir nada.

---

## A validação — três camadas que têm de concordar

```
1. EXTENSÃO       escolhida por quem envia  →  virus.exe vira foto.jpg
2. Content-Type   escolhido por quem envia  →  o formulário diz o que quiser
3. BYTES iniciais a única coisa que não mente
```

Um arquivo que se diz `image/png`, termina em `.png` e começa com `MZ`
(executável do Windows) é recusado — e essa **discordância** é, ela mesma, o
sinal mais claro de ataque que um upload pode dar.

Além disso (`src/dominio/arquivos.js`):

- **lista branca** de MIME (`config.js` → `tiposPermitidos`);
- **lista negra** de extensão perigosa **em qualquer posição** do nome —
  `foto.php.jpg` é o truque contra servidores que executam pela extensão do
  meio;
- recusa de **conteúdo executável** (`MZ`, `ELF`, `CAFEBABE`, `#!`), mesmo que o
  tipo declarado esteja na lista branca;
- **`image/svg+xml` não está na lista** — SVG com `<script>` dentro executa no
  navegador de quem abrir, no domínio do chat, com o cookie dele. É XSS
  armazenado com cara de imagem.

### Por que validar, se a pasta está fora do nginx?

Porque o alvo não é só o servidor:

- o arquivo vai ser **baixado por um colega**, no computador dele;
- um HTML ou SVG enviado como "documento" executa no navegador de quem abrir.

Por isso todo download sai com:

```
Content-Disposition: attachment; filename*=UTF-8''...
Content-Type: application/octet-stream
X-Content-Type-Options: nosniff
Cache-Control: private, no-store
```

`attachment` faz o navegador **baixar** em vez de abrir; `nosniff` impede que
ele "melhore" essa decisão adivinhando o tipo.

---

## O download

```js
// repositorios/anexos.js — a autorização está DENTRO do SQL
JOIN conversa_membros m ON m.conversa_id = a.conversa_id AND m.usuario_id = ?
WHERE a.id = ? AND m.saiu_em IS NULL AND c.contexto_id = ?
```

Estar no SQL, e não num `if` depois, importa: rotas de download se multiplicam
(arquivo, miniatura, prévia), e basta uma esquecer o `if` para vazar tudo.

O envio é por **fluxo**, não lendo tudo para a memória: um anexo de 10 MB vezes
vinte pessoas baixando ao mesmo tempo seriam 200 MB de pico num servidor que
hospeda vinte sites.

---

## Órfãos

O navegador envia o arquivo, recebe o id, e **só então** manda a mensagem que o
carrega. Quem desiste no meio deixa um anexo sem mensagem.

A faxina (a cada 30 min) remove anexos sem mensagem com mais de 6 h — do disco
**e** do banco. Sem ela, o disco cresce com lixo que ninguém vê e ninguém sabe
apagar.

---

## Upload sem multipart

**Não há analisador de `multipart/form-data` neste projeto**, e isso é
deliberado.

Analisar multipart à mão é escrever um parser de protocolo binário alimentado
pela internet — a mesma categoria de risco que fez o WebSocket usar `ws` em vez
de código próprio. E as bibliotecas de multipart trazem sua própria fila de CVEs
(travessia pelo nome do arquivo, exaustão de memória por parte sem fim, confusão
de fronteira).

Aqui o navegador manda o **arquivo cru** no corpo e os metadados em cabeçalho:

```js
fetch(`/chat/arquivos?conversa=${id}`, {
  method: "POST",
  body: arquivo,                      // o File, direto
  headers: {
    "Content-Type": arquivo.type,
    "X-Arquivo-Nome": btoa(unescape(encodeURIComponent(arquivo.name))),
  },
});
```

Não há fronteira para analisar, não há parte sem fim, não há nome interpretado
como caminho. O nome vai em **base64** porque cabeçalho HTTP não aceita acento
nem quebra de linha — e um nome com `\r\n` permitiria **injetar cabeçalhos**.

---

## Trocar por S3, R2 ou MinIO

Escreva um módulo com os cinco métodos e registre no `switch`:

```js
// src/infra/storage/armazenamento.js
switch (driver) {
  case "local": return criarLocal({ pasta: conf.pasta });
  case "s3":    return criarS3(conf);        // ← aqui
  default:      throw new Error(...);
}
```

O `default` **recusa** em vez de cair no local: um `CHAT_STORAGE=s3` digitado por
engano tem de parar o serviço, e não gravar silenciosamente no disco de um
servidor que o operador acha que está usando a nuvem.

Nenhuma outra camada muda — o repositório de anexos guarda a string opaca que
`gravar()` devolveu.

**Ao migrar:** o download continua passando pela rota autenticada. Não gere URL
pré-assinada pública sem antes decidir o prazo — uma URL de S3 sem expiração é o
mesmo que ter deixado a pasta aberta no nginx, com o agravante de que ninguém
percebe.

---

## Backup

Três coisas, e as três importam:

| O quê | Sem ele |
|---|---|
| `dados/chat.db` (ou o dump do Postgres) | não há mensagens |
| `dados/arquivos/` | as mensagens apontam para anexos que não existem |
| `CHAT_DADOS_CHAVE` | o banco restaura, e **todo o conteúdo sai `[protegido]`** |

Guarde a chave junto do backup, mas **nunca dentro dele** — senão o backup
cifrado carrega a própria chave, e a cifragem deixa de proteger exatamente no
cenário para o qual ela existe.
