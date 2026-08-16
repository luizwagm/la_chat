# REALTIME.md — o protocolo, a presença e a reconexão

Transporte: **WebSocket** (`ws`), atrás da interface `Transporte`
(`src/infra/realtime/`). A decisão e o que ela custou estão em
[CHAT_ARCHITECTURE.md](../CHAT_ARCHITECTURE.md#d1).

---

## O aperto de mão

```
navegador                          chat
   │                                │
   │  POST /chat/bilhete            │   (cookie + CSRF + Origin conferidos)
   │──────────────────────────────► │
   │  ◄──── { bilhete, 30s }        │
   │                                │
   │  WS /chat/ws?t=<bilhete>       │
   │──────────────────────────────► │   1. Origin na lista branca?
   │                                │   2. bilhete válido e inédito?
   │                                │   3. abaixo do teto por pessoa?
   │  ◄──── 101 + {"t":"pronto"}    │   4. quadro dentro do tamanho?
```

**O socket não é autenticado por cookie.** O bilhete é o que mata o
*Cross-Site WebSocket Hijacking* — ver [SECURITY.md](SECURITY.md#11-o-websocket-não-é-autenticado-por-cookie).

> **Não há modo degradado hoje.** Se o aperto de mão falhar, o cliente fica em
> "Reconectando…" com recuo exponencial, e o chat não funciona em tempo real
> naquela rede. Rede corporativa que bloqueia `Upgrade` existe (proxy antigo,
> antivírus que inspeciona HTTP); para ela a saída seria um
> `TransporteLongPolling` sobre a mesma interface `Transporte` — **ponto de
> extensão preparado, código não escrito**.

---

## Mensagens

Campos curtos de propósito: um chat movimentado empurra milhares de eventos por
minuto, e cada byte é multiplicado pelo número de abas abertas.

### Do servidor para o navegador

| `t` | Quando | Carga |
|---|---|---|
| `pronto` | logo após conectar | `u` (meu id), `agora` |
| `msg` | mensagem nova | `c` (conversa), `m` (a mensagem **já decifrada**) |
| `apagada` | mensagem apagada | `c`, `id`, `seq` |
| `editada` | mensagem editada | `c`, `m` |
| `lida` | alguém leu | `c`, `u`, `seq` |
| `digit` | alguém digitando | `c`, `u`, `n` (nome) |
| `status` | presença mudou | `u`, `s` |
| `conversa` | conversa criada | `c` |
| `sinc` | resposta da retomada | `c`, `mensagens[]`, `marcas`, `recarregar` |
| `erro` | recusa educada | `m` (texto amigável) |

### Do navegador para o servidor

| `t` | Para quê |
|---|---|
| `ping` | batimento voluntário |
| `digit` | "estou digitando" (com *throttle* de 3 s no cliente) |
| `lida` | confirmar leitura até um `seq` |
| `sinc` | **retomada**: "me dê tudo desde o `seq` X" |

**Tipo desconhecido é ignorado em silêncio.** Responder daria ao atacante um
oráculo para descobrir, por tentativa, quais tipos existem.

Tudo que **muda dados de verdade** (enviar mensagem, enviar arquivo) continua
indo por **HTTP**, onde já existem CSRF, limitador e tratamento de erro. Pelo
socket passam só avisos leves e de alta frequência — que é exatamente onde o
WebSocket paga.

---

## O que o evento carrega

Regra herdada do `restrito.js` deste parque: **só o assunto, nunca o dado** —
por custo e por segredo (o evento não pode entregar a quem não podia ver).

**A exceção medida:** o corpo da mensagem **viaja junto** no evento `msg`. Sem
isso, cada mensagem custaria uma volta ao servidor antes de aparecer, e o chat
pareceria lento justamente na ação mais comum.

O que torna a exceção segura: a autorização é feita sobre a **lista de membros
lida do banco**, no momento do fan-out — nunca sobre a lista de conexões
abertas. Quem está conectado não é a mesma coisa que quem tem direito.

---

## Batimento

```
servidor → ping  a cada 25 s
cliente  → pong  (respondido pela camada do protocolo)
sem pong em 60 s → terminate()
```

**25 s** porque proxies e NAT fecham conexão parada por volta de 60 s.

**O pong é o que detecta cabo arrancado e notebook fechado.** Nesses casos o
socket continua "aberto" do lado do servidor por minutos — sem o batimento, a
pessoa ficaria eternamente online para todos os colegas.

E é o **pong**, não "recebi qualquer mensagem": uma aba congelada pelo navegador
(celular no bolso) pode ter o socket de pé sem executar JavaScript nenhum. O
pong é respondido pela camada do protocolo, então prova que o **canal** vive.

---

## Presença (§6)

Duas fontes que não se misturam:

- **`manual`** — o que a pessoa escolheu (`ocupado`). Sobrevive à desconexão:
  quem se marcou ocupado continua ocupado ao voltar.
- **`expira_em`** — o sinal de vida, renovado pelo pong. Não é renovado por
  nada que o cliente possa falsificar sem manter a conexão aberta.

O status efetivo é **calculado**, nunca gravado — ver
[DATABASE.md](DATABASE.md#por-que-usuario_statusefetivo-não-existe-como-coluna).

**Multi-sessão** (computador + celular + duas abas): `conexoes` conta os canais
abertos. Ele **não é a autoridade** — serve só para saber se a aba que fechou era
a última, e então aplicar a **carência de 30 s** antes de deixar o sinal expirar.
Sem carência, trocar de aba faria o status piscar na tela de todos os colegas.

`AUSENTE` é inatividade da aba (`visibilitychange`), não falta de conexão.

---

## Reconexão e retomada (§25) — a parte que importa

```
Internet caiu
      ↓
o pong falha (ou o socket fecha)
      ↓
"Reconectando…" na tela
      ↓
recuo exponencial com RUÍDO: 1s → 2s → 4s … até 30s
      ↓
reconectou → pede bilhete novo → abre socket
      ↓
{"t":"sinc","c":"…","desde":<último seq que eu tinha>}
      ↓
recebe só o que faltou, na ordem, sem duplicar
```

### Por que o ruído no recuo não é enfeite

Sem ele, um `systemctl restart` faz **todas** as abas de **toda** a empresa
reconectarem no mesmo milissegundo, repetidamente. O servidor mal sobe e leva
uma rajada — e cai de novo. O ruído (±30%) espalha as tentativas no tempo.

### Por que a retomada não duplica nem perde

- **não perde:** `seq` é contíguo. "Me dê tudo com `seq > 830`" não tem como
  pular nada;
- **não duplica:** a retomada é idempotente (pedir de novo do mesmo ponto traz
  zero), e o reenvio por precaução é reconhecido pelo `id_cliente` — o servidor
  devolve a mensagem que **já gravou** em vez de gravar outra.

Sem `id_cliente`, o §25 é impossível: quem reenvia por precaução duplica, e quem
não reenvia perde.

### O buraco grande demais

Ficou uma semana fora? Mandar 40.000 mensagens numa tacada derruba a aba e ocupa
o servidor. Acima de **500**, a resposta é `{"recarregar": true}` e a tela
recarrega pelo caminho normal, **paginado**.

---

## Estados da mensagem (§13)

```
ENVIANDO  🕐   otimista, já na tela
ENVIADA   ✓    o servidor confirmou e deu o seq
ENTREGUE  ✓✓   chegou ao aparelho do outro
LIDA      ✓✓   (azul) a marca d'água do outro passou desta mensagem
ERRO      ⚠    com botão "Tentar de novo" — nunca some sem explicação
```

A mensagem aparece **imediatamente**, antes da resposta do servidor. É o que faz
o chat parecer instantâneo numa rede ruim. Se falhar, vira `ERRO` com opção de
repetir — sumir sem explicação é o pior desfecho possível para quem escreveu.

---

## Limites

| Limite | Padrão | Por quê |
|---|---|---|
| Conexões por **pessoa** | 6 | por pessoa, não por IP: um escritório inteiro sai pelo mesmo IP |
| Quadro máximo | 64 KB | um quadro anunciando 500 MB faria o servidor alocar 500 MB a pedido |
| Mensagens do socket | 240/min por conexão | o cliente honesto manda um punhado |
| Apertos de mão | 60/min por IP | abrir e fechar em rajada custa caro ao servidor e nada ao atacante |

**Compressão desligada.** `permessage-deflate` aloca um contexto de zlib por
conexão (~300 KB): com 500 pessoas, 150 MB só de compressor. E mensagem de chat
é pequena — comprimir 80 bytes custa CPU e não economiza rede.

---

## O dia do segundo processo

Hoje `publicar()` varre as conexões locais. Com dois processos, cada um avisaria
só os seus.

A saída é a que o próprio `restrito.js` deste parque aponta: **`LISTEN`/`NOTIFY`
do PostgreSQL**, e não um servidor a mais. A troca acontece **dentro** de
`Transporte.publicar()` — nada acima percebe.

O que já está pronto para esse dia, porque depois é caro: `seq` vindo do banco,
presença por `expira_em` (e não "quem está no `Map`"), e **nenhum estado de
negócio na memória do processo**.
