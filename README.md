# LA Chat

**Módulo de comunicação corporativa em tempo real**, instalável nos sites do
gerador com duas linhas — sem framework, sem passo de build, sem tocar no banco
do hospedeiro.

```
                     PROJETO HOSPEDEIRO
                            │
              ┌─────────────┴─────────────┐
              │                           │
      aplicação principal          conector (1 arquivo)
                                          │
                                    ┌─────┴─────┐
                                    │  LA Chat  │
                                    ├───────────┤
                                    │ interface │  Web Components
                                    │ WebSocket │  ws
                                    │ banco     │  SQLite ou PostgreSQL
                                    │ storage   │  local (S3 preparado)
                                    │ segurança │  passe HMAC + sessão própria
                                    └───────────┘
```

---

## Recursos

- **Tempo real por WebSocket** — mensagens, presença, "digitando", confirmação
  de leitura, com reconexão e **retomada sem perder nem duplicar**.
- **Três modos de exibição** — modal, painel lateral e tela cheia; um atributo.
- **Mensagens cifradas em repouso** (AES-256-GCM) com **busca que continua
  funcionando**, por índice cego.
- **Anexos e imagens** com validação de conteúdo real (não só da extensão),
  fora da pasta pública, com download autorizado por participação na conversa.
- **Conversas diretas e grupos** desde o primeiro dia.
- **Reunião por vídeo** (WebRTC em malha, até 6 pessoas) — a mídia vai direto
  de um navegador ao outro, cifrada, **sem passar pelo servidor**. Câmera,
  microfone, compartilhamento de tela e quem-está-falando. Desligada por padrão.
- **Sem cadastro próprio de pessoas** — quem autentica é o site hospedeiro.
- **Claro e escuro**, responsivo, teclado e leitor de tela (WCAG 2.1 AA).
- **473 testes automatizados**, incluindo uma suíte que ataca o próprio sistema.

## Requisitos

| | |
|---|---|
| Node.js | ≥ 20 (testado em 24) |
| Banco | SQLite (padrão, sem servidor) ou PostgreSQL |
| Dependências | `ws`. `better-sqlite3` e `pg` são opcionais |
| Build | **nenhum** |

---

## Instalação rápida (desenvolvimento)

```bash
npm ci
cp .env.exemplo .env
npm run chave        # gere um valor para cada segredo do .env
npm run migrar
npm start
```

Em outro terminal, o hospedeiro de demonstração:

```bash
npm run exemplo
```

Abra <http://127.0.0.1:5199> em duas janelas anônimas, entre como pessoas
diferentes e converse.

Para instalar num site de verdade: **[conector/INSTALAR.md](conector/INSTALAR.md)**.

---

## Integração — o contrato inteiro

O hospedeiro responde a **uma** pergunta. Nada além disso.

```js
const chat = require("./lachat")({
  url: "http://127.0.0.1:5197",
  segredo: process.env.CHAT_SEGREDO_PASSE,
  usuario: (req) => sessaoDe(req),     // ← quem está logado?
});

if (chat.rota(req, res)) return;        // linha 1
chat.conectarUpgrade(servidor);         // linha 2
```

O chat **não conhece** o model `User` do hospedeiro, não lê o banco dele e não
grava nada nele.

---

## Configuração

Tudo num lugar só: [`config.js`](config.js), alimentado por
[`.env.exemplo`](.env.exemplo). Os que mais importam:

| Variável | Padrão | O que é |
|---|---|---|
| `CHAT_ORIGENS` | *(vazio)* | **Obrigatória em produção.** Sites autorizados a abrir o chat |
| `CHAT_SEGREDO_PASSE` | — | Assina o passe. O mesmo valor no conector |
| `CHAT_SEGREDO_BUSCA` | — | Deriva os tokens do índice cego |
| `CHAT_DADOS_CHAVE` | — | Cifra o corpo das mensagens |
| `CHAT_BANCO` | `sqlite` | `sqlite` ou `pg` |
| `CHAT_PROXIES` | `1` | Quantos proxies há na frente — **leia o comentário** |
| `CHAT_ARQUIVO_MAX` | 10 MB | Teto de anexo |

---

## Arquitetura

```
server.js            monta as peças e liga a porta. Nenhuma regra aqui.
config.js            o único lugar com número mágico
src/
  dominio/           regras puras — sem banco, sem HTTP, sem navegador
  aplicacao/         casos de uso: a ORDEM das coisas
  infra/
    dados/           repositórios · SQLite | PostgreSQL
    realtime/        transporte (WebSocket) · presença
    seguranca/       passe · sessão · CSRF · origem · limites · cifragem · IP
    storage/         armazenamento (local hoje, S3 preparado)
    eventos/         barramento
  http/              roteamento e resposta
publico/la-chat.js   o cliente — Web Component, Shadow DOM, sem build
conector/lachat.js   o que se copia para o site hospedeiro
exemplo/             hospedeiro de demonstração (é o que o E2E usa)
```

A regra que sustenta tudo: **`dominio/` não importa nada de `infra/`**. É o que
permite testar regra de negócio sem subir banco nenhum.

Decisões e o porquê de cada uma: **[CHAT_ARCHITECTURE.md](CHAT_ARCHITECTURE.md)**.
O terreno em que foram tomadas: **[PROJECT_ANALYSIS.md](PROJECT_ANALYSIS.md)**.

---

## Segurança

Detalhe item a item em **[docs/SECURITY.md](docs/SECURITY.md)**. O resumo:

- **Sem E2EE, e o motivo é técnico** — ela é incompatível com busca, auditoria,
  notificação com conteúdo e multi-dispositivo, e a chave viveria no
  `IndexedDB`, onde qualquer XSS do site hospedeiro a rouba. No lugar: TLS em
  trânsito, **AES-256-GCM em repouso** com a chave fora do banco, e busca por
  índice cego. Um `pg_dump` vazado sai inerte.
- **O WebSocket não é autenticado por cookie**, e sim por um **bilhete de 30 s,
  de uso único**. É isso que mata o *Cross-Site WebSocket Hijacking* na raiz —
  o navegador anexa cookies a qualquer WebSocket, inclusive um aberto por
  página maliciosa.
- **XSS é estruturalmente impossível no cliente**: nenhum conteúdo de usuário
  vira HTML. A tela monta com `createElement` e `textContent`.
- **404, nunca 403**, para recurso alheio — 403 confirmaria que o id existe.
- **A auditoria não guarda conteúdo.** Nem mensagem, nem nome de arquivo.

---

## Testes

```bash
npm test                 # todas as suítes
npm run test:unidade     # rápido, sem subir nada
npm run test:seguranca   # os ataques
```

| Suíte | O que prova | Testes |
|---|---|---|
| unidade | regras puras, sem infraestrutura | 106 |
| integração | o sistema por HTTP, com cookie e CSRF | 83 |
| tempo real | WebSocket, **queda de conexão e retomada** | 31 |
| segurança | que o **abuso falha** | 96 |
| e2e | a **instalação**, atravessando o conector | 29 |

Cada suíte sobe o servidor em porta própria, com banco descartável.

---

## Produção

```bash
sudo ./deploy.sh
./verificar.sh https://chat.exemplo.com
```

Passo a passo em **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. Duas armadilhas
que valem a leitura antes da primeira subida:

- o **`map` de Upgrade no nginx** é obrigatório — sem ele o chat funciona em
  tudo, menos em tempo real, e nada parece quebrado;
- **nunca** `MemoryDenyWriteExecute` na unit do systemd — ele mata o V8 com
  `status=5/TRAP` segundos depois de subir, e parece erro de rede.

---

## Documentação

| Arquivo | Assunto |
|---|---|
| [PROJECT_ANALYSIS.md](PROJECT_ANALYSIS.md) | o terreno, medido no código |
| [CHAT_ARCHITECTURE.md](CHAT_ARCHITECTURE.md) | as decisões e o porquê |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | os dois arranjos de instalação |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | o contrato com o hospedeiro |
| [docs/SECURITY.md](docs/SECURITY.md) | OWASP item a item |
| [docs/DATABASE.md](docs/DATABASE.md) | esquema, índices e o porquê de cada um |
| [docs/REALTIME.md](docs/REALTIME.md) | protocolo, presença, reconexão |
| [docs/VIDEO.md](docs/VIDEO.md) | reunião: malha, teto, TURN e o que não existe |
| [docs/STORAGE.md](docs/STORAGE.md) | anexos e a troca por S3 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | systemd, nginx, TLS |
| [docs/TESTING.md](docs/TESTING.md) | como as suítes são escritas |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | sintoma → causa |

---

## O que NÃO está no MVP

Dito agora para não virar promessa silenciosa. O esquema já está preparado para
todos, e nenhum exige migração de dados:

GIF · áudio · vídeo · reações · menções · mensagens fixadas · encaminhamento ·
notificação por e-mail · push nativo · Redis para múltiplos processos.

Grupos, respostas, edição e exclusão **estão** implementados.

---

## Versão

`0.9.1` — ver [CHANGELOG.md](CHANGELOG.md).

LA Software House · <https://luizaugust.me>
