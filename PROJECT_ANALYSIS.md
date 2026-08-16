# PROJECT_ANALYSIS.md — o terreno onde o chat vai ser instalado

**Fase 1 do processo.** Este documento não propõe nada: ele registra o que
**existe**, medido no código, para que as decisões da Fase 2
(`CHAT_ARCHITECTURE.md`) possam ser cobradas contra fatos e não contra gosto.

Data da leitura: 14/08/2026.
Escopo lido: `C:\Projects\SitesProjects` — 20 projetos, ~1.300 arquivos.

---

## 1. O que é este workspace

Não é *um* projeto com uma aplicação hospedeira. São **20 projetos irmãos**,
quase todos sites de clientes reais em produção, gerados a partir de um mesmo
molde que foi evoluindo. Isso muda a pergunta central do briefing:

> *"analise a stack do projeto onde você está trabalhando"*

Não existe **o** projeto hospedeiro. Existe uma **família** de hospedeiros com a
mesma anatomia. O chat não deve ser escrito para um deles — deve ser escrito
para o **molde**. Essa é a diferença entre entregar um chat e entregar o
componente reutilizável que o briefing pede (§2, §38, §39).

| Projeto | Papel | Porta | Banco |
|---|---|---|---|
| BemEstarClinic | clínica — **em produção** | 5185 | SQLite + PostgreSQL |
| Borda-Tudo | bordados — /restrito ativo | 5193 | SQLite + PostgreSQL |
| Imobiliaria-Caruaru | imóveis | 5188 | SQLite + PostgreSQL |
| Instituto-Kenosis | OSC | 5189 | SQLite + PostgreSQL |
| Forms-Fitness | academia | 5186 | SQLite |
| CW-Mendes | oficina | 5192 | SQLite |
| NYC / Óticas / Troféu / Daniel's / Esatto / LA-Software-House | sites e lojas | 5180–5187 | SQLite |
| LA-Publisher | **módulo** de publicação em redes | 5190 | SQLite |
| LA-Sentinela | **módulo** de monitoramento | 5191 | SQLite |
| LA-Miner / LA-Fiscal / Riacho-Solar / Innovar / LA-Backup / Eleições | diversos | 5194–5196 | vários |

**Portas 5180–5196 estão tomadas. A primeira livre é a 5197.**

---

## 2. A stack, medida (não suposta)

### 2.1 Runtime e dependências

```
Node.js >= 20 (LA-Fiscal exige 24; LA-Sentinela, 22.5)
CommonJS ("use strict", require) — exceto LA-Fiscal, que é ESM + TypeScript
Sem passo de build. `npm start` é literalmente `node server.js`.
```

O `package.json` inteiro de um site típico tem **uma a três dependências**:

| Pacote | Onde | Para quê |
|---|---|---|
| `better-sqlite3` | quase todos | banco do site/painel |
| `pg` | os quatro com /restrito | banco de gestão |
| `sharp` | BemEstar | tratamento de imagem |
| `qrcode` | Borda-Tudo | QR das máquinas |

**Não há Express, Fastify, Socket.IO, React, Vue, Webpack, Vite, Prisma,
Sequelize, Jest ou Vitest em lugar nenhum.** O servidor HTTP é o `node:http`
cru. Isso não é descuido — é uma decisão sustentada por anos e documentada
dentro dos arquivos. Qualquer coisa que eu traga precisa justificar o próprio
peso contra esse padrão.

### 2.2 Anatomia de um site

```
Projeto/
├── server.js              # node:http cru, roteamento à mão (~1.000 linhas)
├── db.js                  # abre SQLite, com desvio para node:sqlite
├── pg.js                  # adaptador PostgreSQL (Q.get/Q.all/Q.run)
├── restrito.js            # sistema de gestão (~3.400 linhas)
├── cripto.js              # AES-256-GCM para dados pessoais
├── limitador.js           # freio de força bruta (idêntico nos sites)
├── html-seguro.js         # sanitizador de HTML por lista branca
├── backup.js              # backup agendado
├── src/molde-*.html       # onde se mexe no layout
├── index.html, ...        # HTML GERADO — mexer aqui é trabalho perdido
├── admin/app.html         # painel do site (SQLite)
├── restrito/app.html      # sistema de gestão — 270 KB, um arquivo só
├── nginx/, ci/, .github/  # deploy
└── testar-*.cjs           # suítes, em Node puro
```

### 2.3 O front-end

**Não há framework e não há bundler.** O `/restrito` da Borda Tudo é **um único
`app.html` de 270 KB** com três blocos: `<style>`, marcação e `<script>`.
Vanilla JS, sem módulos ES, sem transpilação. O navegador recebe um arquivo e
funciona.

O site público é **estático de verdade**: o painel grava no banco e o comando
`publicar` reescreve o HTML entre marcadores `<!--#CHAVE-->…<!--/CHAVE-->`.
Quem visita não encosta no banco.

> **Consequência para o chat:** o chat é a primeira coisa neste ecossistema que
> é *interativa e autenticada dentro da página*. Ele não pode ser publicado
> como HTML estático, e não pode assumir um framework que não existe.

### 2.4 Autenticação — o padrão real

Lido em `Borda-Tudo/restrito.js`:

- Sessão **em memória do processo** (`Map` de `rid → {usuarioId, papel, visto}`).
  Reiniciar o serviço derruba as sessões, e isso é aceito conscientemente.
- Cookie `rid` (48 hex), `HttpOnly`, `SameSite=Strict`, `Secure` quando
  `x-forwarded-proto: https`, `Path=/restrito`.
- Cookies **diferentes por área**: `sid` no /admin, `rid` no /restrito — entrar
  num não é entrar no outro.
- Senha: **`scrypt`** com salt individual, formato
  `scrypt$N$r$p$salt$dk`. Não é Argon2id, mas é KDF lento e adequado — e é
  nativo do Node, sem dependência.
- Papéis: `operador`, `admin`, `dono`. Uma única função `ehAdmin()` decide, de
  propósito, porque comparação literal espalhada já causou incidente.
- CSRF: mitigado por `SameSite=Strict` + JSON via `fetch`. Não há token CSRF
  explícito.

### 2.5 Tempo real — **já existe, e a decisão já foi tomada**

Esta foi a descoberta que mais pesa na arquitetura do chat.
`Borda-Tudo/restrito.js`, seção 1c, já implementa **Server-Sent Events**, e
documenta por que não escolheu WebSocket:

- tráfego de mão única (servidor avisa, navegador ouve);
- o que o navegador manda já vai por POST — que tem sessão e tem limitador;
- WebSocket exigiria `Upgrade` no nginx, ping/pong à mão, reconexão à mão;
- `EventSource` é nativo, **reconecta sozinho** e atravessa qualquer proxy.

E dois detalhes que só quem já apanhou escreve:

- `X-Accel-Buffering: no` — sem isso o nginx segura os eventos em buffer e o
  tempo real "às vezes funciona";
- batimento a cada 25 s, porque conexão parada é fechada por NAT e proxy.

Há também uma regra de ouro explícita: **o evento carrega só o assunto, nunca o
dado** — porque o preço do desenho não pode chegar ao navegador do operador.
Cada tela busca pela rota normal e recebe o que o papel dela permite.

> **Consequência para o chat:** existe transporte de tempo real testado em
> produção, com o nginx já configurado, e uma regra de autorização que o chat
> deve herdar. Trocá-lo por WebSocket precisa de justificativa forte — não o
> contrário. Isso é analisado na Fase 2.

### 2.6 Segurança já resolvida (e reaproveitável)

| Arquivo | O que resolve | Reaproveitável no chat? |
|---|---|---|
| `limitador.js` | força bruta: balde por **IP** *e* por **conta**, espera exponencial, persistido em JSON | **Sim, direto** |
| `html-seguro.js` | XSS: sanitização por **lista branca**, no servidor, **na gravação** | **Sim, é a base da formatação de mensagem** |
| `cripto.js` | AES-256-GCM por valor, IV aleatório, chave fora do banco, prefixo `enc:1:` versionado | **Sim, é a base da cifragem de mensagens** |
| `pg.js` | pool que religa sozinho, `?`→`$n`, `LIKE`→`ILIKE` | **Sim** |
| systemd | `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths` restrito | **Sim** |
| nginx | `limit_req_zone` de login em `conf.d` | **Sim** |

Três decisões dessas merecem destaque porque o chat teria errado igual:

1. **Sanitizar na gravação, não na exibição.** Assim o banco só guarda conteúdo
   já seguro, e nenhuma outra rota (API, backup, relatório) vaza o perigoso.
2. **Lista branca, nunca lista negra.** Proibir `<script>` é jogo perdido.
3. **O balde por conta não vale para IP que já acertou a senha antes** — senão
   o atacante para de tentar entrar e passa a trancar o dono do lado de fora.

### 2.7 Testes

Suítes em **Node puro**, sem framework: `testar-restrito.cjs` sobe o servidor
numa porta própria e conversa com ele por **HTTP de verdade** (cookie, sessão,
JSON). Contadores `passou`/`falhou` na mão.

Duas regras vindas de incidente, que valem como lei aqui:

- todo dado de teste leva o prefixo **`ZZ QA`** e é apagado **por id**, nunca
  por `LIKE` — um `DELETE … LIKE '%'` já apagou uma tabela inteira;
- a resposta denuncia a si mesma: erro de rota tem de estourar ali, não sessenta
  linhas depois com `Cannot read properties of undefined`.

### 2.8 Deploy

`systemd` + `nginx` + `deploy.sh` + GitHub Actions. O serviço escuta **só no
loopback** (`HOST=127.0.0.1`); quem fala com a internet é o nginx. Segredos em
`/etc/<app>.env`, modo `640`, fora do projeto e fora do git — porque o conteúdo
de uma unit é legível por qualquer um com `systemctl cat`.

Duas armadilhas gravadas no molde do serviço:

- **`After=`, não `Requires=`, para o Postgres** — a unit `postgresql.service`
  é uma fachada que termina com sucesso quase imediatamente;
- **nunca `MemoryDenyWriteExecute`** — mata o V8 com `status=5/TRAP` segundos
  depois de subir, e parece erro de rede.

---

## 3. O padrão de módulo instalável — **já existe duas vezes**

Este ecossistema já respondeu à pergunta do briefing §38/§39. LA-Sentinela e
LA-Publisher são módulos instalados nos sites, e ambos usam a **mesma forma**:

```
LA-Modulo/
├── server.js, banco.js, ...      # o serviço central, roda sozinho
└── conector/
    ├── lamodulo.js               # UM arquivo, copiado para a raiz do site
    └── INSTALAR.md               # "2 linhas no server.js do site"
```

O conector do Sentinela, lido em `BemEstarClinic/lasentinela.js`, é exemplar:

- **sem nenhuma dependência** além do Node;
- assina cada envio com **HMAC-SHA256 de (timestamp + corpo)**;
- **só escreve para fora** — "não abre porta nova de ataque";
- instalação declarada como **2 linhas no `server.js`**.

> Este é o contrato de instalação que o chat deve imitar. Não preciso inventar
> um formato de plugin: preciso seguir o que já funciona aqui, e que o cliente
> já sabe instalar.

**Ponto de atenção herdado:** o conector lê o IP com
`String(req.headers["x-forwarded-for"]).split(",")[0]` — o **primeiro** item do
cabeçalho, que é **texto escrito pelo atacante**. Essa exata falha já foi
corrigida no ecossistema e a cópia do BemEstar ainda está com a forma antiga. O
chat **não pode repetir isso**: identidade de IP para limitador e auditoria tem
de vir do último salto confiável.

---

## 4. Conflitos entre o briefing e o terreno

Onde o pedido literal do briefing bate de frente com o que existe. A Fase 2
decide cada um; aqui eles só ficam nomeados.

| # | Briefing pede | O terreno diz | Tensão |
|---|---|---|---|
| C1 | WebSocket para o tempo real (§12) | SSE + POST já roda, com nginx pronto e reconexão nativa | **Alta** — §12 admite análise, e §64 manda escolher o melhor |
| C2 | `composer/npm/pnpm` para instalar (§38) | não há registry privado; módulo se instala **copiando um arquivo** | Média — a forma local é mais simples e já é praticada |
| C3 | Argon2id para senhas (§19) | `scrypt` nativo, sem dependência | Baixa — §19 admite "alternativa equivalente"; módulo nativo exigiria compilador no servidor |
| C4 | Chat com banco próprio (§1) | sites têm SQLite; só quatro têm PostgreSQL | Média — precisa funcionar nos dois |
| C5 | E2EE a analisar (§20) | contexto **corporativo**, com auditoria (§31) e busca (§16) | **Alta** — E2EE e busca no servidor são mutuamente exclusivas |
| C6 | Componentização React-like (§36) | não há framework nem build | Média — componentização tem de ser em JS puro |
| C7 | Redis para escala (§24) | uma máquina, um processo por site | Baixa — §24 diz "não adicione se não houver necessidade imediata" |

---

## 5. Riscos identificados

1. **Sessão em memória.** O padrão atual derruba sessões a cada deploy. Para um
   painel de gestão isso é aceitável ("entra de novo"). Para um chat aberto o
   dia inteiro, cair a cada deploy é sentido como defeito. O chat precisa de
   sessão que sobreviva a reinício **ou** de reconexão silenciosa que não peça
   senha de novo.

2. **Um processo por site.** Presença e eventos vivem na memória do processo —
   limite já documentado no `restrito.js`. Enquanto for um processo, funciona;
   a arquitetura tem de deixar a saída pronta (o próprio `restrito.js` aponta
   `LISTEN/NOTIFY` do PostgreSQL como caminho, "não um servidor a mais").

3. **`pkill` derruba vizinhos.** Todos os sites rodam `node server.js` com o
   mesmo usuário. Já houve incidente. Scripts do chat têm de matar processo
   **pelo caminho do projeto**, nunca pelo nome.

4. **Arquivo único de 270 KB.** É o padrão do front-end aqui, e funciona — mas
   o chat somado a isso empurraria o `app.html` para além do razoável. O chat
   precisa ser servido como recurso próprio, com cache, não colado dentro do
   HTML do hospedeiro.

5. **Nenhum site tem `Upgrade` configurado no nginx.** Adotar WebSocket
   significa mexer na configuração de nginx de **cada** site instalado — em
   servidores com cliente em produção. É custo real, não teórico.

---

## 6. Conclusões que a Fase 2 herda

1. O alvo não é um projeto: é **o molde**. O chat será um projeto irmão
   (`LA-Chat`), na porta **5197**, com um **conector de um arquivo** — a forma
   que LA-Sentinela e LA-Publisher já provaram.
2. **Node puro, CommonJS, sem build, dependências contadas nos dedos.** Fugir
   disso quebra a instalação em 20 servidores.
3. `limitador.js`, `html-seguro.js`, `cripto.js` e `pg.js` **não serão
   reescritos** — serão a fundação, porque já são código de produção com
   cicatriz.
4. O transporte de tempo real **precisa ser decidido, não presumido** (C1), e a
   decisão precisa aguentar a pergunta "vale mexer no nginx de 20 sites?".
5. **E2EE precisa de resposta técnica, não de marketing** (C5): ou há busca,
   notificação e auditoria no servidor, ou há E2EE. Não os dois.
6. O chat tem de rodar **com SQLite e com PostgreSQL** (C4), porque a base
   instalada tem os dois.
