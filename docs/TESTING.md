# TESTING.md

```bash
npm test                 # todas, em ordem
npm run test:unidade     # rápido, sem subir nada
npm run test:seguranca   # os ataques
node testes/rodar.cjs seguranca      # uma só
```

**Sem framework**, como o resto do parque: Node puro, contadores na mão, HTTP de
verdade com cookie de verdade. É o que faz o teste provar o **sistema**, e não a
fachada.

---

## As suítes

| Suíte | Sobe | O que prova | Testes |
|---|---|---|---|
| `unidade.cjs` | nada | regras puras: texto, arquivos, ULID, índice cego, cifragem, limites, origem, passe, IP, tradução de SQL | 106 |
| `integracao.cjs` | o chat | o sistema por HTTP: sessão, conversas, paginação, busca, grupos, anexos | 83 |
| `realtime.cjs` | o chat | WebSocket, presença, **queda de conexão e retomada** | 31 |
| `seguranca.cjs` | o chat | que o **abuso falha** | 96 |
| `e2e.cjs` | o chat **e** o hospedeiro | a **instalação**, atravessando o conector | 29 |

**345 no total.**

Cada suíte roda em **processo próprio, porta própria, banco descartável**.
Rodá-las no mesmo processo faria uma herdar o estado da outra — e um teste que
só passa quando roda depois de outro é pior que teste nenhum, porque mente com
aparência de prova.

---

## As regras que vêm de incidente

### 1. Dado de teste leva prefixo `ZZ QA` e é apagado **por id**

Nunca por `LIKE`, nunca por nome. Um `DELETE ... LIKE '%'` já apagou uma tabela
inteira num projeto deste parque.

Aqui as suítes sobem contra banco descartável, então nem isso é preciso — mas o
prefixo fica, porque no dia em que alguém apontar a suíte para outro banco por
engano, os restos serão reconhecíveis.

### 2. A resposta denuncia a si mesma

O modo clássico de uma suíte morrer: a rota devolve erro, o teste lê
`r.dados.conversas.length`, e o que aparece é

```
TypeError: Cannot read properties of undefined (reading 'length')
```

apontando para uma linha que não tem defeito nenhum. Por isso `pedir()` guarda
status **e** corpo, e `ok()` mostra os dois quando falha.

### 3. Esperar por condição, nunca por relógio

`await esperar("msg")` em vez de `sleep(2000)`. Sleep fixo é como se ganha um
teste que passa na máquina rápida e falha na integração contínua.

### 4. Matar processo pelo **PID que a suíte criou**

Nunca `pkill node`. Todos os projetos do parque rodam `node server.js` com o
mesmo usuário — `pkill` derrubaria os sites vizinhos. Já aconteceu.

### 5. O teste de segurança e o atacante compartilham IP

A suíte martela `/entrar` de propósito, para provar que a força bruta é freada.
O freio é por IP, e a suíte inteira sai de `127.0.0.1` — então **todo login
feito depois daquele teste toma 429**.

A solução foi criar todas as sessões **antes** do teste de limite. A solução
errada teria sido baixar o limite para o teste passar: isso é enfraquecer a
defesa para agradar o teste.

---

## O que a suíte de segurança ataca

Cada teste ali **é um ataque**. Não confere se a funcionalidade funciona —
confere se o abuso **falha**.

```
IDOR          ler, escrever, apagar e baixar em conversa alheia
enumeração    404 idêntico para "não existe" e "não é seu"
CSRF          sem token · token inventado · token de outra sessão
origem        escrita de origem não autorizada · CORS nunca "*"
passe         assinatura adulterada · papel trocado · expirado ·
              outro segredo · repetição (replay) · emitido no futuro
upload        MZ · ELF · shebang · MIME que não bate · HTML · SVG ·
              travessia no nome · acima do teto · travessia na URL
injeção       5 cargas de SQL · curinga `%` que listaria a empresa
XSS           5 cargas que voltam como texto · Trojan Source
limites       rajada de mensagens · martelo de passes forjados
privilégio    auditoria e bloqueio negados a membro comum ·
              bloquear derruba a sessão já aberta
sessão        HttpOnly · SameSite · token em hash no banco ·
              corpo cifrado no banco · índice guarda HMAC
IP            trocar X-Forwarded-For não escapa do limitador
WebSocket     sem bilhete · origem má (CSWSH) · bilhete reusado · inventado
erros         sem pilha, sem caminho de arquivo, sem SQL na resposta
```

Três desses conferem o **banco em disco** diretamente (abrindo o SQLite em modo
leitura), porque "está cifrado" é afirmação que só vale se for verificada nos
bytes.

---

## O E2E é o único que prova a instalação

As outras suítes falam direto com o chat. O E2E fala com o **hospedeiro**:

```
navegador → site (5299) → conector → chat (5295)
```

Se o repasse de rotas, o repasse do WebSocket ou a emissão do passe quebrarem,
quebra ali. Nas outras suítes tudo continuaria verde, porque elas pulam o
conector.

Ele também prova que **o site sobrevive ao chat**: derruba o chat no meio e
confere que o site continua no ar e que as rotas `/chat/*` respondem 503 com
educação, sem vazar `ECONNREFUSED`.

---

## Escrever um teste novo

```js
const { criarPlacar, subirChat, entrar } = require("./ajuda.cjs");

const P = criarPlacar("Minha suíte");
const chat = await subirChat({ porta: 5290 });
try {
  const ana = await entrar(chat, { id: "func-001", nome: "ZZ QA Ana" });
  P.eq((await ana.vai("/eu")).status, 200, "o que se espera, em português");
} finally {
  await chat.derrubar();
}
return P.fim();
```

- `P.eq(a, b, nome)` — igualdade, mostrando os dois valores quando falha;
- `P.recusa(resposta, 403, nome)` — o formato da maioria dos testes de
  segurança: "isto **tem** de ser recusado";
- `P.secao(nome)` — separa os blocos na saída.

**O nome do teste é a especificação.** `"estranho NÃO baixa anexo de conversa
alheia"` diz o que o sistema promete; `"testa download"` não diz nada.

---

## O que ainda não é testado automaticamente

- **Renderização visual** — conferida no navegador durante a construção
  (isolamento do Shadow DOM, tema escuro, celular com botão voltar, os três
  modos), mas não há teste automatizado de tela.
- **PostgreSQL** — as suítes rodam em SQLite. O adaptador tem teste de unidade
  (tradução de `?` e `LIKE`), mas o caminho completo contra um Postgres real
  ainda não foi exercitado.
- **Carga** — não há teste de mil conexões simultâneas.
