# SECURITY.md — o que protege o quê

Este documento não lista boas práticas: lista **onde cada ataque morre**, com o
arquivo e a linha de raciocínio. Se uma defesa não puder ser apontada num
arquivo, ela não existe.

Prioridade declarada do projeto: **SEGURANÇA > CORREÇÃO > MANUTENIBILIDADE >
PERFORMANCE > UX > VELOCIDADE**.

---

## 1. As três decisões que mais importam

### 1.1 O WebSocket não é autenticado por cookie

**O navegador não aplica same-origin a WebSocket.** Tudo que se sabe sobre
segurança de navegador — "outro site não lê a resposta da minha API" — vale
para `fetch`. **Não vale** para `new WebSocket(...)`: qualquer página, de
qualquer domínio, pode abrir um socket para o chat, e o navegador **anexa os
cookies da vítima**.

O ataque completo (*Cross-Site WebSocket Hijacking*):

1. o funcionário está logado no chat;
2. visita qualquer página — um anúncio, um link de e-mail;
3. essa página roda `new WebSocket("wss://chat.empresa.com/chat/ws")`;
4. o navegador manda o cookie, o servidor autentica — e o atacante lê e
   escreve mensagens em nome dele, ao vivo.

Nenhuma senha foi roubada. Do lado do servidor parece uma conexão normal.

**A defesa:** o socket exige um **bilhete de 30 segundos, de uso único**,
obtido antes por uma requisição HTTP que passou por cookie, CSRF e Origin
(`src/infra/seguranca/sessao.js`). A página maliciosa até abre o socket com o
cookie da vítima, mas não tem bilhete — e não consegue obter um, porque obter
exigiria **ler** a resposta de uma requisição entre sites, o que o navegador
impede.

A conferência de `Origin` (`src/infra/seguranca/origem.js`) continua existindo,
como segunda tranca. Coberto por teste: *"socket SEM bilhete é recusado, mesmo
com cookie válido"*, *"socket de ORIGEM não autorizada é recusado"*, *"o MESMO
bilhete NÃO abre um segundo socket"*.

### 1.2 XSS é impossível por construção, não por filtragem

O caminho comum é sanitizar HTML com lista branca e jogar no `innerHTML`. Este
projeto **tem** um sanitizador desses (`html-seguro.js`, herdado do parque) e
ele é bom — mas não é o caminho principal, porque:

- sanitizar é uma corrida: cada navegador novo traz uma forma nova de executar
  script;
- sanitizar depende de o filtro rodar em **todos** os caminhos, e basta uma
  rota nova (uma prévia, uma exportação) esquecer.

Aqui a mensagem é guardada como **texto**, e a tela a transforma em elementos
com `createElement` + `textContent` (`publico/la-chat.js`). Não há o que
sanitizar porque **não há HTML sendo construído a partir do texto**.

Provado no navegador: `<img src=x onerror=...>` não cria elemento `<img>`
nenhum e não executa.

### 1.3 Sem E2EE — e o motivo é técnico

Ver [CHAT_ARCHITECTURE.md](../CHAT_ARCHITECTURE.md), decisão D2. Resumo: E2EE é
incompatível com busca no servidor, auditoria, notificação com conteúdo,
multi-dispositivo e recuperação de histórico — todos exigidos pelo próprio
briefing. E a chave viveria no `IndexedDB`, onde qualquer XSS em **qualquer
página do site hospedeiro** a rouba.

No lugar: TLS em trânsito, **AES-256-GCM em repouso** com chave em
`/etc/lachat.env` (fora do banco e do git), e busca por índice cego.

---

## 2. OWASP Top 10, item a item

### A01 — Quebra de controle de acesso

| Defesa | Onde |
|---|---|
| `exigirMembro()` é a **primeira** linha de todo caso de uso de conversa | `src/aplicacao/chat.js` |
| A autorização do download está **dentro do SQL**, não num `if` depois | `repositorios/anexos.js` → `paraDownload` |
| `contexto_id` em toda consulta — consulta que o esqueça devolve vazio | esquema inteiro |
| **404, nunca 403**, para recurso alheio | `src/dominio/erros.js` |
| Bloquear alguém **derruba a sessão já aberta** | `chat.js` → `bloquearUsuario` |
| A sessão do socket vem do aperto de mão, **nunca de campo da mensagem** | `realtime/websocket.js` |

> **Por que 404 e não 403:** responder "existe, mas você não pode" confirma a
> existência do id. Com isso um atacante mapeia o que existe variando a URL.
> Testado: *"alheia e inexistente devolvem a MESMA mensagem"*.

### A02 — Falhas criptográficas

- **AES-256-GCM** por valor, IV aleatório, cifra **autenticada**: adulterar o
  banco faz a leitura falhar em vez de devolver lixo (`seguranca/cripto.js`).
- Chave **fora do banco**, em `/etc/lachat.env` modo 640.
- Formato versionado (`enc:1:…`) — permite rotação sem parar o sistema.
- Cifrados: corpo da mensagem, título de grupo, e-mail, nome de anexo.
- **Não** cifrados: ids, datas, `seq` — são o que o banco indexa, e cifrá-los
  custaria toda a performance sem esconder conteúdo.
- Token de sessão gravado em **hash SHA-256**, nunca em claro.
- Comparação de assinatura com `timingSafeEqual` — `===` vaza o segredo byte a
  byte pelo tempo de resposta.

### A03 — Injeção

- **Todo** valor vai por parâmetro. Não há concatenação de SQL em lugar nenhum.
- Os `?` dos `IN (...)` são gerados pelo **tamanho da lista**; os valores
  seguem parametrizados.
- `%` e `_` são escapados nas buscas por `LIKE` — não é injeção, mas buscar `%`
  listaria a empresa inteira, que é **enumeração**.
- O tradutor para PostgreSQL reconhece comentários **antes** de aspas: um
  apóstrofo em comentário abriria uma string falsa e embaralharia os
  parâmetros (`infra/dados/banco.js`).

### A04 — Design inseguro

- Sem cadastro de senha: **não há coluna de senha no esquema**.
- Conversa é N membros desde o primeiro dia — virar grupo não é migração.
- `seq` monotônico vindo do banco resolve ordem, retomada, não lidas e
  detecção de buraco de uma vez.
- Barramento de eventos: um ouvinte que falha não derruba quem anunciou.

### A05 — Configuração incorreta

- O serviço **recusa-se a subir** em produção sem segredo ou sem
  `CHAT_ORIGENS` (`config.js` → `conferir()`).
- Lista de origens vazia = **recusa todo mundo**, nunca "aceita todo mundo".
- CORS devolve a origem **exata**, nunca `*`, e sempre com `Vary: Origin`.
- Cabeçalhos em toda resposta: `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- systemd com `ProtectSystem=strict` e `ReadWritePaths` só na pasta de dados.

### A06 — Componentes vulneráveis

Uma dependência de execução: **`ws`** — JavaScript puro, sem dependências, sem
compilação nativa. `better-sqlite3` e `pg` são **opcionais**.

A escolha de usar `ws` em vez de escrever o analisador de quadros à mão é
deliberada: um parser binário exposto à internet (mascaramento, fragmentação,
tamanho de carga, validação de UTF-8) é exatamente o tipo de código em que a
prioridade declarada manda **não** improvisar.

### A07 — Falhas de identificação e autenticação

- O chat **não autentica ninguém**: quem autentica é o hospedeiro.
- O passe vive **60 s**, é de **uso único** (`jti` guardado até expirar), e a
  assinatura cobre nome, papel e contexto.
- Passe emitido "no futuro" é recusado (relógio dessincronizado ≠ passe eterno).
- Papel inventado vira `membro` — sem escalonamento pela borda.
- **Não é JWT**, de propósito: o formato traz `alg:none`, confusão HS256/RS256
  e bibliotecas que aceitam o algoritmo escrito pelo atacante. Aqui o algoritmo
  é fixo no código e não viaja no token.

### A08 — Integridade de software e dados

- Anexo tem `hash` SHA-256 gravado; o arquivo no disco recebe **ULID**, nunca o
  nome enviado.
- Gravação em temporário + `rename`: falta de energia deixa um `.tmp` órfão em
  vez de um anexo pela metade que o banco jura estar inteiro.
- Migrações versionadas, em transação: falhar significa "nada mudou".

### A09 — Falhas de registro e monitoramento

- Auditoria com lista **fechada** de eventos (`repositorios/auditoria.js`).
- **A auditoria não guarda conteúdo** — nem mensagem, nem nome de arquivo, nem
  e-mail. Um log que copia o conteúdo vira uma segunda cópia não cifrada de
  tudo, num lugar que ninguém lembra de proteger. Testado.
- IP em **hash** com sal da instalação: responde "400 tentativas do mesmo
  lugar" sem manter cadastro de onde cada funcionário estava.
- `detalhe` limitado a 200 caracteres — é a peneira que impede o campo livre de
  virar o lugar onde alguém cola a mensagem inteira.
- Health check que **não vaza** caminho, versão de biblioteca nem contagem.

### A10 — SSRF

O chat **não busca URL nenhuma** informada por usuário. Não há prévia de link,
não há avatar por URL remota, não há webhook. A superfície não existe.

---

## 3. Ataques específicos de chat

| Ataque | Defesa |
|---|---|
| **CSWSH** | bilhete de uso único + `Origin` (§1.1) |
| **CSRF** | `SameSite=Strict` (arranjo A) + token de dupla submissão amarrado por HMAC à sessão |
| **Travessia de diretório** | nome no disco é ULID; `path.resolve` conferido contra a raiz **depois** de normalizar |
| **Upload malicioso** | extensão + MIME + **bytes iniciais** têm de concordar; executável e SVG recusados; `attachment` + `nosniff` no download |
| **IDOR em anexo** | autorização dentro do SQL do download |
| **Repetição (replay)** | `jti` do passe e bilhete de uso único |
| **Falsificação de IP** | `X-Forwarded-For` lido **do fim para trás** (`seguranca/ip.js`) |
| **Força bruta** | balde por IP **e** por conta, espera exponencial (`limitador.js`) + freio por rota (`limites.js`) |
| **Inundação de mensagens** | janela deslizante, não janela fixa — 30 às 10:00:59 e 30 às 10:01:00 seriam 60 num segundo |
| **Negação de serviço por quadro** | `maxPayload` no `ws`; teto de conexões **por pessoa**, não por IP (um escritório sai pelo mesmo IP) |
| **Trojan Source** | marcas de direção Unicode removidas na gravação |
| **Enumeração de pessoas** | busca exige 2 caracteres; `%` escapado; a lista não inclui você |
| **Clickjacking** | `X-Frame-Options: DENY` — o chat é embutido por script, nunca por iframe |

---

## 4. Privacidade (LGPD) — §34

O que a arquitetura entrega, e o que **precisa de validação jurídica**.

**Entregue:**

- minimização: a auditoria guarda o mínimo; o evento de tempo real carrega o
  mínimo;
- dado pessoal cifrado em repouso (mensagem, e-mail, nome de arquivo);
- IP em hash, nunca em claro;
- controle de acesso por participação, verificado no banco;
- exclusão: soft delete que **sobrescreve o corpo** — o conteúdo some de fato,
  fica o esqueleto (quem, quando, que foi apagada);
- retenção configurável, **desligada por padrão**.

**Para validar com profissional competente:**

- prazo de retenção de mensagens e de auditoria;
- base legal para registrar IP (mesmo em hash);
- política de acesso do administrador ao conteúdo — hoje o admin **não** lê
  conversa alheia; ele apaga e audita, e a ação fica registrada;
- exportação de dados a pedido do titular.

A arquitetura torna os quatro **configuráveis** em vez de gravados no código.

---

## 4b. Achados da auditoria (0.3.0) — o que estava errado

Registrados aqui porque **a lista de falhas encontradas vale mais que a de
defesas prometidas**. Todas foram provadas com sonda, corrigidas, e cada uma
tem teste de regressão em `testes/seguranca.cjs`.

| # | Falha | Impacto | Onde estava |
|---|---|---|---|
| 1 | **Bloqueio não fechava o WebSocket** | pessoa bloqueada continuava **recebendo mensagens em tempo real** | `chat.js` → `bloquearUsuario` |
| 2 | **Presença atravessava contextos** | status de uma empresa aparecia na outra (§22) | fan-out em `websocket.js` |
| 3 | **Anexo cruzava conversa** | mensagem exibia anexo que ninguém do grupo baixava | `anexos.amarrarNaMensagem` |
| 4 | **Tipo da mensagem vinha do cliente** | PDF anunciado como imagem | `chat.js` → `enviarMensagem` |
| 5 | **Marca de leitura sem teto** | "✓✓ lida" falso, inclusive para mensagens futuras | `chat.js` → `marcarLida` |
| 6 | **`CHAT_PROXIES` documentado errado** | todo visitante virava 127.0.0.1: limitador trancava a empresa junto, auditoria inútil | docs + `deploy.sh` |
| 7 | **Health check entregava a versão** | reconhecimento gratuito | `server.js` → `saude` |

Mais dois endurecimentos sem falha correspondente: cookie de sessão restrito a
`/chat` (antes ia em toda requisição do site do cliente) e validação da URL de
avatar por lista branca de esquema.

**Duas lições que valem além deste projeto:**

1. **Autenticação de socket é um evento, não um estado.** O aperto de mão
   autentica UMA vez; nada depois disso reconsulta a sessão. Toda revogação —
   bloqueio, logout, expiração — precisa de um caminho explícito até o
   transporte, senão ela só vale para o HTTP.

2. **Isolamento de inquilino falha no fan-out, não na consulta.** Todas as
   consultas ao banco filtravam por contexto corretamente. O vazamento
   aconteceu no único lugar que não passa pelo banco: a lista de conexões
   abertas em memória.

---

## 5. O que ainda não está resolvido

Dito na cara, porque a lista de limitações conhecidas vale mais que a de
recursos:

1. **Um processo.** Presença e fan-out vivem na memória do processo. Com dois
   processos, cada um avisaria só os seus. A saída documentada é
   `LISTEN/NOTIFY` do PostgreSQL — o ponto de extensão é `Transporte.publicar()`.
2. **Índice cego vaza frequência.** Quem tiver o banco vê que certo token
   aparece 4.000 vezes. Não sabe qual palavra é, e continua sem ler mensagem
   nenhuma — mas a informação existe.
3. **Sem varredura de malware** nos anexos. A validação recusa executável e
   confere o tipo real, mas não substitui antivírus. Para ambiente que exija,
   o ponto de entrada é `aplicacao/chat.js` → `enviarArquivo`.
4. **Sem 2FA própria** — e de propósito: quem autentica é o hospedeiro, e é lá
   que o segundo fator pertence.
5. **`confirm()` do navegador** na exclusão de mensagem. Funciona e é acessível,
   mas não segue o design system.
