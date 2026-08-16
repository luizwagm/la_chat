# CHAT_ARCHITECTURE.md — LA Chat

**Fase 2 do processo.** Decisões de arquitetura, cada uma com o problema, a
alternativa, o benefício, o risco e a escolha — na forma que o §64 do briefing
exige. O terreno está medido em [`PROJECT_ANALYSIS.md`](PROJECT_ANALYSIS.md).

Prioridade declarada, e usada como critério de desempate em todo este
documento:

> **SEGURANÇA > CORREÇÃO > MANUTENIBILIDADE > PERFORMANCE > UX > VELOCIDADE**

---

## 0. Resumo das decisões

| # | Decisão | Contra o briefing? |
|---|---|---|
| D1 | **WebSocket** (`ws`), atrás de uma interface `Transporte` trocável | Não — §12 |
| D2 | **Sem E2EE.** Corpo cifrado em repouso (AES-256-GCM) + busca por índice cego | **Sim** — §20 pede análise; a resposta é "não" |
| D3 | Repositório com **dois motores**: SQLite (padrão) e PostgreSQL (volume) | Não |
| D4 | Hospedeiro **assina um passe HMAC**; o chat mantém sessão própria | Não |
| D5 | **Web Components** com Shadow DOM, sem build | Não |
| D6 | Storage atrás de `Armazenamento`, arquivos **fora** da pasta pública | Não |
| D7 | **Sem Redis** no MVP; saída documentada é `LISTEN/NOTIFY` | Não |
| D8 | Instalação por **conector de um arquivo**, no padrão LA-Sentinela | §38 sugeria npm |

---

## D1 — Transporte de tempo real: **WebSocket**

> **Registro da decisão.** Minha recomendação técnica foi SSE + POST, pelos
> motivos abaixo, que continuam valendo e continuam escritos aqui. **O dono do
> produto escolheu WebSocket**, e é a escolha dele que está implementada. O
> texto original fica preservado porque o custo que ele descreve é real e
> precisa estar visível para quem for instalar — não para reabrir a discussão.

### O problema

O briefing (§12) diz: *"Para chat bidirecional, priorize uma arquitetura
baseada em WebSocket **quando apropriado**"*. E "aqui" são 20 sites em
produção, com nginx configurado, sem nenhum `Upgrade` em lugar nenhum.

### A alternativa não escolhida (SSE + POST)

Descida por `EventSource`, subida por POST. Latência de descida idêntica,
reconexão nativa, nenhuma mexida em nginx.

### O que o WebSocket custa neste terreno — e como cada custo foi pago

1. **Configuração de nginx em cada site instalado.** WebSocket exige
   `proxy_http_version 1.1`, `Upgrade`, `Connection` e `proxy_read_timeout`
   alongado em **todo** servidor onde o chat entrar. São servidores com cliente
   em produção. É a diferença entre "copie um arquivo e reinicie" e "mexa no
   nginx de 20 sites".
2. **Reconexão à mão.** É código que só é exercitado quando a rede cai — ou
   seja, o código menos testado a rodar no pior momento.
3. **Ping/pong à mão**, porque WebSocket não tem batimento embutido do lado do
   servidor.
4. **Análise de quadros RFC 6455** — ou uma dependência a mais (`ws`) num
   ecossistema com uma a três dependências por projeto.
5. Este ecossistema **já rejeitou WebSocket** por escrito, em produção, na
   seção 1c do `restrito.js`, e a decisão está de pé há meses.

1. **Configuração de nginx em cada site instalado.** WebSocket exige
   `proxy_http_version 1.1`, `Upgrade`, `Connection` e `proxy_read_timeout`
   alongado em **todo** servidor onde o chat entrar.
   → **Pago com** `nginx/lachat-upgrade.conf`: um trecho pronto, para incluir,
   mais a conferência automática no `verificar.sh`. Instalar deixa de ser
   "mexa no nginx" e vira "inclua uma linha".

2. **Reconexão à mão** — código que só é exercitado quando a rede cai, ou seja,
   o menos testado a rodar no pior momento.
   → **Pago com** recuo exponencial com ruído (1s→30s), retomada por
   `desde_seq` e **suíte de realtime que derruba a conexão de propósito** e
   confere que nada se perdeu nem duplicou. É teste obrigatório, não opcional.

3. **Ping/pong à mão**, porque o navegador não expõe controle de batimento.
   → **Pago com** ping do servidor a cada 25 s e derrubada de quem não devolve
   pong em 60 s. É isso que detecta o cabo arrancado, que não fecha o socket.

4. **Análise de quadros RFC 6455** — mascaramento, fragmentação, tamanho de
   carga, validação de UTF-8, quadro gigante como negação de serviço.
   → **Pago com a dependência `ws`**, e essa escolha é deliberada: escrever
   analisador de quadros à mão seria assumir a segurança de um parser binário
   exposto à internet, e a prioridade declarada é SEGURANÇA acima de tudo. O
   `ws` é **JavaScript puro, sem dependências e sem compilação nativa** — não
   exige compilador no servidor, ao contrário do `better-sqlite3`, que já
   causou incidente aqui (`ERR_DLOPEN_FAILED`).

5. **Autorização por mensagem.** O POST herdava sessão, limitador e CSRF de
   graça; o WebSocket não herda nada.
   → **Pago com** autenticação **no aperto de mão** (antes de aceitar o
   socket), limitador por conexão *e* por conta, e verificação de `Origin`
   contra a lista de hospedeiros — porque **o navegador não aplica
   same-origin a WebSocket**, e sem essa checagem qualquer site consegue abrir
   um socket autenticado com o cookie da vítima (*Cross-Site WebSocket
   Hijacking*). Esta é a armadilha número um do WebSocket e está coberta por
   teste de segurança próprio.

### O que se ganha

- **Um canal só, nos dois sentidos**, com ~6 bytes de moldura por mensagem
  contra um POST inteiro com cabeçalhos.
- **Digitando, presença e confirmação de leitura ficam baratos** — são os
  eventos de subida frequentes, e são exatamente onde o WebSocket paga.
- Não consome uma das 6 conexões por origem do HTTP/1.1.
- Espaço para crescer sem trocar de transporte: áudio, colaboração ao vivo.

### A escolha

**WebSocket (`ws`), atrás de uma interface `Transporte`.**

A interface continua existindo — não por indecisão, mas porque é ela que
tornará possível o modo degradado no dia em que ele for necessário: rede
corporativa que bloqueia `Upgrade` existe (proxy antigo, antivírus que
inspeciona HTTP).

> **Estado real: o modo degradado NÃO está implementado.** Hoje, se o aperto
> de mão falhar, o cliente fica em "Reconectando…" tentando de novo, com recuo
> exponencial. O que existe é o *ponto de extensão* — `TransporteLongPolling`
> implementaria a mesma interface e nada acima mudaria.
>
> Esta linha já esteve escrita como se o modo degradado existisse. Foi
> corrigida na auditoria de segurança: documentação que promete uma defesa
> inexistente é pior que documentação nenhuma, porque impede que alguém a
> construa.

```js
// realtime/transporte.js — o resto do sistema só conhece esta forma
//   aceitar(req, socket, cabeca)   abre o canal (aperto de mão + autenticação)
//   publicar(usuarioIds, evento)   empurra um evento para quem estiver ligado
//   encerrar(usuarioId)            derruba as conexões de um usuário
//   ligados()                      quem está com canal aberto (presença)
```

`TransporteWS` é a única implementação hoje. Nenhuma camada acima conhece o
transporte: `aplicacao/` chama `publicar()` e não sabe se o outro lado é um
socket ou uma requisição pendurada.

### O que o evento carrega

Herdado do `restrito.js`, e por dois motivos: **só o assunto, nunca o dado**.

```json
{"t":"mensagem","c":"<id da conversa>","m":"<id da mensagem>","seq":8421}
```

- **Custo:** cinquenta bytes por evento, e não a mensagem inteira multiplicada
  pelo número de abas abertas.
- **Autorização num lugar só:** cada tela busca pela rota normal e recebe o que
  o papel dela permite. Empurrar o conteúdo pelo evento significaria
  reimplementar "quem pode ver o quê" no caminho do *push* — e é sempre esse
  segundo caminho que esquece um caso.

> **Exceção medida:** o corpo da mensagem *é* empurrado quando o destinatário é
> membro confirmado da conversa e a mensagem não tem anexo. Sem isso, cada
> mensagem custaria um POST de volta e o chat pareceria lento. A autorização
> nesse caso é decidida **no momento do fan-out**, sobre a lista de membros
> lida do banco — nunca sobre a lista de conexões abertas.

---

## D2 — Criptografia: **sem E2EE**, e o motivo é técnico

### O problema

O §20 manda analisar E2EE e proíbe implementá-la "apenas como marketing". A
análise honesta é que, **neste contexto**, E2EE é incompatível com requisitos
que o próprio briefing exige nos outros parágrafos.

### As incompatibilidades, uma a uma

| Requisito do briefing | Sob E2EE |
|---|---|
| §16 busca de mensagens | Impossível no servidor — ele nunca vê o texto |
| §31 auditoria corporativa | Impossível — não há o que auditar |
| §41 notificação por e-mail/push com conteúdo | Impossível — o servidor não pode montar a prévia |
| §30 administração | O admin corporativo não tem como cumprir obrigação nenhuma |
| §6 multi-dispositivo (PC + celular + 2 abas) | Exige troca de chaves entre dispositivos, com todo o protocolo |
| §26 histórico grande, aberto rápido | O cliente teria de decifrar o histórico inteiro localmente |
| §34 LGPD — direito de exclusão e portabilidade | O operador não consegue exportar nem apagar conteúdo que não lê |

E o problema que mata sozinho: **o cliente é um navegador dentro do site do
hospedeiro**. A chave privada teria de morar em `IndexedDB`. Qualquer XSS em
**qualquer página do site hospedeiro** rouba a chave — e aí a E2EE não protege
nada, só dá a impressão de proteger. Escrever "ponta a ponta" nessa condição é
exatamente o marketing que o §20 proíbe.

Além disso: E2EE de verdade é X3DH + Double Ratchet, com gestão de chaves
pré-publicadas, dispositivos, revogação e recuperação. Implementar isso à mão é
pior do que não ter — criptografia caseira falha em silêncio.

### O que é implementado no lugar

Três camadas, todas verificáveis:

**1. Em trânsito — TLS/HTTPS/WSS.** Já é o padrão do ecossistema (certbot no
`criar_site.sh`). O chat recusa cookie sem `Secure` quando está atrás de HTTPS.

**2. Em repouso — AES-256-GCM na aplicação**, exatamente no molde do
`cripto.js` que já roda aqui:

```
enc:1:<iv base64>:<tag base64>:<cifrado base64>
```

- IV aleatório por valor — duas mensagens idênticas produzem textos cifrados
  diferentes;
- GCM é cifra **autenticada**: adulterar o banco faz a leitura falhar em vez de
  devolver lixo;
- a chave mora em `/etc/lachat.env` (modo 640), **fora do banco e fora do
  git** — um `pg_dump` vazado sai inerte;
- o `1` é a versão da chave, para permitir rotação sem parar o sistema.

O que é cifrado: **corpo da mensagem**, nome original de arquivo, e os campos
pessoais do perfil (e-mail, telefone). O que **não** é cifrado: ids, datas,
`conversa_id`, `autor_id`, estado — porque são o que o banco precisa indexar, e
cifrá-los custaria toda a performance sem esconder conteúdo nenhum.

**3. Busca sobre conteúdo cifrado — índice cego.**

Aqui está a tensão real: cifrar o corpo mata o `LIKE`. A saída é não buscar no
corpo, e sim num índice de **tokens embaralhados**:

```
token normalizado ("orçamento" → "orcamento")
        ↓  HMAC-SHA256 com CHAVE_BUSCA (≠ chave dos dados)
   8 bytes guardados em mensagens_tokens
```

Buscar "orçamento" gera o mesmo HMAC e casa por igualdade — **com índice**, sem
nunca guardar o texto. O que isso custa, dito sem enfeite:

- **só casa palavra inteira** — não há busca por prefixo nem por trecho;
- **quem tiver o banco pode fazer análise de frequência** dos tokens (ver que
  um token aparece muito, sem saber qual é). Aceitável: esse atacante já teria
  de ter o banco, e mesmo assim não lê nenhuma mensagem;
- truncar o HMAC em 8 bytes gera colisão eventual — por isso o resultado é
  **sempre reconferido decifrando** as poucas linhas candidatas antes de voltar
  para a tela. Colisão vira trabalho a mais, nunca resultado errado.

### A escolha

**Sem E2EE. Cifragem em repouso + TLS + índice cego para busca.** O que isso
entrega de concreto, e que é o que o cliente corporativo realmente quer: backup
vazado é inútil, leitura direta do banco é inútil, e o sistema continua podendo
buscar, auditar, notificar e cumprir a LGPD.

> **Ponto para validação jurídica.** Retenção, exclusão e a base legal para
> registrar IP em auditoria são decisões que devem ser confirmadas por
> profissional competente. A arquitetura torna as três **configuráveis**
> (§37) em vez de gravadas no código.

---

## D3 — Banco: um repositório, dois motores

**SQLite é o padrão** — 16 dos 20 sites só têm ele, e o chat precisa instalar
sem exigir servidor de banco. **PostgreSQL é a opção** para volume alto ou
mais de um processo.

O ecossistema já provou esse padrão em `pg.js`: `?`→`$n` e `LIKE`→`ILIKE`
traduzidos numa camada só. Mas aqui a lição do próprio `pg.js` é levada mais a
sério: a API é **assíncrona nos dois motores** (`Q.get`/`Q.all`/`Q.run`), mesmo
com SQLite sendo síncrono. Um `await` esquecido numa API híbrida não estoura —
`if (linha)` passa, `linha.id` vira `undefined`, e o sistema grava errado em
silêncio. Uma forma só elimina a classe inteira de erro.

Esquema, índices e a razão de cada um ficam em [`DATABASE.md`](docs/DATABASE.md).
As tabelas do §21 estão todas contempladas, com `ULID` para id (ordenável por
tempo, o que faz a paginação por cursor cair no índice primário) e `seq`
monotônico por conversa — que é o que resolve ordenação, deduplicação e o
`Last-Event-ID` da reconexão de uma vez só.

---

## D4 — Autenticação: o hospedeiro assina um passe, o chat mantém a sessão

### O problema

O §18 proíbe duplicar login sem necessidade. O hospedeiro **já sabe** quem é o
usuário — tem a própria sessão. O chat precisa saber o mesmo, sem virar um
segundo lugar onde se digita senha, e sem confiar em nada que o navegador diga.

### A escolha

O padrão HMAC que o conector do LA-Sentinela já usa em produção:

```
1. navegador pede /chat/passe ao HOSPEDEIRO (rota do conector)
2. hospedeiro consulta a PRÓPRIA sessão e chama:
       chat.emitirPasse({ id, nome, email, avatar, papel, contexto })
3. conector devolve  passe = base64(corpo) + "." + HMAC-SHA256(corpo, SEGREDO)
       corpo = { sub, nome, ..., iat, exp: iat+60s, jti: aleatório }
4. navegador entrega o passe ao CHAT, uma única vez
5. chat confere HMAC, validade e ineditismo do jti → cria sessão própria
       cookie  cid  HttpOnly; SameSite=Strict; Secure; Path=/chat
```

**Por que passe curto + sessão própria, e não um JWT a cada requisição:**

- o passe vive **60 segundos** e é **de uso único** (`jti` guardado até
  expirar) — interceptar não serve de nada, e replay não funciona;
- o segredo **nunca vai ao navegador** — mora em `/etc/lachat.env` dos dois
  lados;
- a sessão do chat é **independente**: o chat continua funcionando se o
  hospedeiro reiniciar, e derrubar a sessão do chat não desloga a pessoa do
  sistema do cliente;
- comparação de assinatura com `crypto.timingSafeEqual` — comparar com `===`
  vaza o segredo byte a byte pelo tempo de resposta.

**O contrato** (§39) — o hospedeiro implementa isto, e nada mais:

```js
// O chat NUNCA conhece o model User do hospedeiro.
provedorDeUsuario: (req) => ({
  id: "...",            // obrigatório, estável
  nome: "...",          // obrigatório
  email, avatar, cargo, departamento,   // opcionais
  papel: "membro" | "admin",
  contexto: "empresa-1", // tenant (§22)
})
```

**Sessão que sobrevive ao deploy.** Diferente do `/restrito`, a sessão do chat
é gravada (tabela `sessoes`), com o token guardado como **hash** — quem ler o
banco não rouba sessão. O motivo está no risco 1 da análise: um painel pode
pedir login de novo depois do deploy; um chat aberto o dia inteiro não pode.

**CSRF.** `SameSite=Strict` (como no ecossistema) **mais** um token
`double-submit` em toda escrita — porque o chat, ao contrário do `/restrito`,
é embutido em página de terceiro, e a origem passa a importar. `Origin` é
conferido contra a lista de hospedeiros autorizados.

---

## D5 — Front-end: Web Components, sem build

### O problema

O §36 pede componentização. Não há framework nem bundler, e o chat é **injetado
na página do hospedeiro** — cujo CSS eu não controlo e não posso quebrar.

### A escolha

**Custom Elements + Shadow DOM**, JS puro, servido como um recurso só.

O Shadow DOM é o argumento decisivo, e não é estética: ele é o **único
isolamento de CSS real sem passo de build**. Sem ele, o `.btn` do site do
cliente repinta o botão de enviar, e o `input` do chat herda a fonte do
formulário de orçamento. Com ele, o chat entra em qualquer página sem vazar
estilo nos dois sentidos.

```
<la-chat modo="drawer"></la-chat>     ← §3: modal | drawer | fullpage
```

Os modos (§3) são **um atributo**, não três construções. A árvore de
componentes é a do §36 (`ConversationList`, `MessageComposer`, …), em arquivos
separados, concatenados na entrega — o mesmo que o ecossistema já faz ao gerar
o `app.html`.

**Tema (§50):** variáveis CSS atravessam o Shadow DOM de propósito. É por elas
que o hospedeiro personaliza sem tocar no código do módulo:

```css
la-chat { --chat-primaria: #1e275f; --chat-raio: 10px; }
```

Claro e escuro por `prefers-color-scheme`, com sobreposição explícita.

---

## D6 — Arquivos: fora da pasta pública, sempre

Interface `Armazenamento` (`gravar`/`ler`/`remover`/`url`), com o driver
`local` no MVP e o caminho aberto para S3/R2/MinIO (§23).

As regras que fecham o §10, §11 e §23:

- arquivos vão para `dados/arquivos/`, **fora de `assets/`** — nunca servidos
  pelo nginx direto;
- nome no disco é **gerado** (`ULID`), nunca o nome enviado — mata *path
  traversal* na origem, e o nome original vai cifrado para o banco;
- download passa por rota que **confere se quem pede é membro da conversa** —
  é o que fecha o IDOR do §11 ("não deve conseguir acessar trocando o ID");
- validação em três camadas: extensão, MIME declarado e **os bytes iniciais do
  arquivo** (*magic number*) — porque o `.jpg` do §10 pode ser qualquer coisa;
- `Content-Disposition: attachment` e `X-Content-Type-Options: nosniff` em todo
  download, para o navegador nunca executar o que baixou;
- imagem passa por reprocessamento (`sharp`, quando presente), o que remove
  EXIF e destrói *payload* embutido de brinde.

---

## D7 — Escala: sem Redis agora, com a saída pronta

O §24 diz para não adicionar Redis sem necessidade imediata. Não há: um
processo por site, dezenas de pessoas por instalação.

A saída, quando houver, é a que o próprio `restrito.js` aponta — **`LISTEN` /
`NOTIFY` do PostgreSQL**, e não um servidor a mais. O ponto de extensão é o
mesmo `Transporte.publicar()` do D1: hoje ele varre as conexões locais; amanhã
ele publica num canal e cada processo entrega às suas. Nada acima dele muda.

O que **já** fica pronto no MVP, porque depois é caro: `seq` monotônico por
conversa vindo do banco (e não da memória), presença com `expira_em` (e não
"quem está no `Map`"), e nenhum estado de negócio na memória do processo.

---

## D8 — Instalação: conector de um arquivo

O §38 sugeriu npm. Não há registry privado aqui, e o ecossistema já resolveu
isso **duas vezes** (LA-Sentinela, LA-Publisher) com uma forma mais simples e
que o cliente já sabe operar:

```
1. copie  conector/lachat.js  para a raiz do site
2. duas linhas no server.js do hospedeiro:

       const chat = require("./lachat")({ url, siteId, segredo, usuario: ... });
       if (chat.rota(req, res)) return;        // no topo do handler

3. uma linha no HTML:  <script src="https://chat.../la-chat.js" defer></script>
4. npm run migrar
```

O conector **não abre porta nova**: ele só assina passes e faz proxy das rotas
`/chat/*` para o serviço. `INSTALLATION.md` traz o passo a passo verificável.

---

## 1. Camadas

```
navegador
   │  <la-chat>  (Web Components, Shadow DOM)
   │      ↕ WebSocket (eventos)     ↓ HTTP (histórico, upload, busca)
   ├───────────────────────────────────────────────
   │  ui/            componentes, estados, tema
   ├───────────────────────────────────────────────
   │  aplicacao/     casos de uso — enviarMensagem, marcarLida, entrarNaConversa
   ├───────────────────────────────────────────────
   │  dominio/       regras puras, SEM banco e SEM http (é o que os testes de
   │                 unidade exercitam)
   ├───────────────────────────────────────────────
   │  infra/
   │     dados/      repositórios · SQLite | PostgreSQL
   │     realtime/   Transporte (SSE hoje, WS amanhã) · presença
   │     seguranca/  passe HMAC · sessão · limitador · sanitização · CSRF
   │     storage/    Armazenamento (local hoje, S3 amanhã)
   │     eventos/    barramento — MessageSent, UserOnline, … (§40)
   │     notificacoes/ navegador hoje; e-mail/push pelo mesmo barramento (§41)
   └───────────────────────────────────────────────
```

A regra que mantém isso de pé: **`dominio/` não importa nada de `infra/`**. É
o que permite testar regra de negócio sem subir banco — e é o que o LA-Fiscal
já faz com 42 testes que rodam sem banco nenhum.

## 2. Presença (§6), sem polling

`ONLINE` / `OCUPADO` / `AUSENTE` / `OFFLINE`, com duas fontes que não se
confundem:

- **manual** — o que a pessoa escolheu (`ocupado`);
- **real** — derivada das conexões: cada socket aberto renova `expira_em`, e o
  **pong** de 25 s serve de sinal de vida. É o pong, e não o socket "parecer
  aberto", que decide: cabo arrancado e notebook fechado deixam o socket em pé
  do lado do servidor por minutos, e sem o batimento a pessoa fica eternamente
  "online".

Multi-sessão (§6: PC + celular + duas abas) resolvido por **contagem de
conexões por usuário**: fica `OFFLINE` quando a **última** cai, com carência de
30 s para trocar de aba não piscar o status do lado de todo mundo. `AUSENTE` é
inatividade da aba (`visibilitychange`), não falta de conexão.

## 3. Estados da mensagem (§13)

`ENVIANDO → ENVIADA → ENTREGUE → LIDA`, com `ERRO` fora da linha.

Deduplicação por **`id_cliente`** (ULID gerado no navegador, único por
mensagem): reenviar depois de reconectar não duplica, porque o servidor
reconhece o id e devolve a mensagem que já gravou. Sem isso, o §25 ("não perder
mensagens, evitar duplicação") é impossível — quem reenvia por precaução
duplica, e quem não reenvia perde.

## 4. Onde cada exigência do briefing foi parar

| §  | Exigência | Onde |
|----|---|---|
| 9  | Formatação sem HTML arbitrário | Markdown restrito → `html-seguro.js` (lista branca, na gravação) |
| 12 | Tempo real | D1 |
| 16 | Busca | índice cego (D2) + `debounce` de 250 ms |
| 17 | OWASP | [`SECURITY.md`](docs/SECURITY.md), item a item |
| 20 | E2EE | D2 |
| 22 | Isolamento por contexto | `contexto_id` obrigatório em toda consulta, aplicado no repositório |
| 26 | Paginação | cursor sobre `(conversa_id, seq)` |
| 29 | Acessibilidade | WCAG 2.1 AA — foco visível, `aria-live` nas mensagens novas, navegação por teclado |
| 32 | Rate limiting | `limitador.js` reaproveitado, com baldes por rota |
| 42 | Testes | unidade · integração · realtime · **segurança** · E2E |

---

## 3. O que NÃO entra no MVP (e por quê)

Dito agora para não virar promessa silenciosa: **GIF, áudio, vídeo, reações,
menções, mensagens fixadas e encaminhamento não entram** (§8 autoriza:
*"não implemente funcionalidades desnecessárias apenas para aumentar o
projeto"*). O que entra é o **esquema preparado** para eles — `reply_to`,
`forwarded_from`, `edited_at`, `deleted_at` já existem nas tabelas, e o tipo da
mensagem já é uma coluna, não um booleano de "é arquivo".

Grupos: o modelo de conversa já é **N membros** desde o primeiro dia (tabela
`conversa_membros`), porque transformar 1‑para‑1 em grupo depois é migração de
dados; nascer com N e usar 2 não custa nada.
