# DATABASE.md — esquema, índices e o porquê de cada um

Um SQL, dois motores. **SQLite é o padrão** (16 dos 20 sites do parque só têm
ele, e exigir servidor de banco mataria a instalação); **PostgreSQL** entra
quando houver volume ou mais de um processo.

Esquema em [`src/infra/dados/migracoes/001-inicial.js`](../src/infra/dados/migracoes/001-inicial.js) —
com o raciocínio de cada tabela escrito ali dentro.

---

## As três decisões que moldam tudo

### 1. `seq` — um contador por conversa, vindo do banco

Cada mensagem recebe um inteiro sequencial **dentro da conversa**, atribuído na
mesma transação que a grava. Ele resolve quatro problemas de uma vez:

| Problema | Como `seq` resolve |
|---|---|
| **Ordem** | a tela ordena por `seq`, não por relógio (relógio de servidor pula; de cliente é mentira do usuário) |
| **Retomada** | "me dê tudo com `seq > 830`" — uma comparação, com índice |
| **Não lidas** | `ultima_seq - ultima_lida_seq` |
| **Buraco** | recebeu 831 e 833 → o cliente **sabe** que perdeu a 832 e pede |

Vem do **banco**, e não da memória, porque com dois processos a memória de cada
um daria a mesma numeração para mensagens diferentes.

E é atribuído **dentro da transação**. A forma errada:

```js
const c = await ler(conversa);   // ultima_seq = 830
const seq = c.ultima_seq + 1;    // 831
await gravar(seq);
```

Entre a leitura e a gravação cabe outra mensagem. As duas calculam 831 e o
índice único `(conversa_id, seq)` faz uma estourar. **Sem o índice seria pior**:
duas mensagens com o mesmo número, e a retomada entregaria só uma — a outra
some para sempre, sem erro nenhum.

### 2. Estado de leitura por marca d'água — e não uma linha por mensagem

O §21 do briefing pede uma tabela `message_status`. **Ela não existe aqui**, e a
troca é deliberada.

Uma linha por (mensagem × destinatário) num grupo de 30 pessoas com 100.000
mensagens são **três milhões de linhas** que só dizem "li" — escritas em rajada
toda vez que alguém abre uma conversa antiga.

Como `seq` é contíguo, **dois inteiros por membro** dizem a mesma coisa com
exatidão total:

```
ultima_entregue_seq = 831   → tudo até 831 chegou no aparelho
ultima_lida_seq     = 824   → tudo até 824 foi visto
```

O estado de UMA mensagem sai daí: para o autor, a `seq=800` está **lida** quando
todos os outros membros têm `ultima_lida_seq >= 800`. Uma consulta sobre
`conversa_membros`, que tem **uma linha por pessoa**.

O que se perde: o instante exato em que cada pessoa leu cada mensagem. Guarda-se
o instante da marca, que é o que a tela mostra ("visto às 09:41"). Auditoria de
leitura mensagem a mensagem, se um dia for exigida por contrato, entra como
tabela **própria e opcional** — não como peso permanente no caminho quente.

### 3. `contexto_id` em tudo (§22)

Está em usuários, conversas e mensagens — **inclusive onde é redundante** (a
conversa já diz o contexto). A redundância é a defesa: toda consulta filtra por
contexto, e uma que esqueça o filtro devolve **vazio** em vez de devolver dados
de outra empresa.

---

## Tabelas

| Tabela | Papel | Observação |
|---|---|---|
| `contextos` | inquilino | criado na primeira entrada; não há tela para isso |
| `usuarios` | **reflexo** do cadastro do hospedeiro | **não há coluna de senha** |
| `usuario_preferencias` | som, notificação, tema | |
| `usuario_status` | presença | o status **efetivo é calculado**, nunca gravado |
| `sessoes` | sessão persistida | token em **hash**, nunca em claro |
| `passes_usados` | trava de repetição | minúscula por construção (só 60 s cabem) |
| `conversas` | direta ou grupo | `chave_direta` única impede conversa duplicada |
| `conversa_membros` | quem participa + **as duas marcas d'água** | |
| `mensagens` | corpo **cifrado** + `seq` | colunas de expansão já existem, vazias |
| `mensagem_tokens` | **índice cego** da busca | guarda HMAC, nunca a palavra |
| `anexos` | registro do arquivo | nome **cifrado**; caminho é ULID |
| `notificacoes` | avisos pendentes | |
| `auditoria` | eventos | **sem conteúdo**; IP em hash |
| `migracoes` | controle de versão do esquema | |

### Por que `usuario_status.efetivo` não existe como coluna

```
expira_em > agora  →  o que a pessoa escolheu (online/ocupado/ausente)
senão              →  OFFLINE
```

Gravar "offline" exigiria que **alguém** rodasse para gravá-lo. No dia em que o
processo morre de repente — deploy, `pkill`, OOM — ninguém roda, e o banco fica
dizendo que doze pessoas estão online **para sempre**. Com o cálculo, um
processo morto faz todo mundo virar offline sozinho em 60 s, sem faxina nenhuma.

### Por que `chave_direta` é índice único

João e Maria clicam em "conversar" no mesmo segundo. Os dois códigos leem "não
existe" e os dois criam. A partir daí João escreve na conversa A e Maria na B —
cada um vendo metade do assunto, os dois achando que o outro não responde, e
**nenhum erro em lugar nenhum**.

A chave é o par de ids **ordenado** (hash), então `(joão, maria)` e
`(maria, joão)` produzem o mesmo valor. O segundo `INSERT` perde **no banco** —
o único lugar onde a corrida pode ser arbitrada. Um `if` na aplicação não
resolve: entre o `if` e o `INSERT` cabe a outra requisição.

---

## Índices, e o que cada um serve

| Índice | Caminho que ele torna barato |
|---|---|
| `ix_mensagens_conversa_seq` **(único)** | abrir conversa, paginar para trás, retomar, contar não lidas — **o índice mais importante** |
| `ix_mensagens_id_cliente` **(único)** | deduplicação do reenvio: dois POSTs iguais perdem no banco, não num `if` |
| `ix_membros_usuario` | "quais conversas eu tenho?" — a consulta mais quente |
| `ix_tokens_busca (token, conversa_id)` | busca; `conversa_id` está repetido aqui de propósito, para o filtro de autorização entrar **antes** e não depois |
| `ix_usuarios_externo` **(único)** | impede que duas abas abrindo juntas criem duas identidades para a mesma pessoa |
| `ix_conversas_direta` **(único)** | a corrida acima |
| `ix_sessoes_token` **(único)** | percorrido em **toda** requisição autenticada |
| `ix_status_expira`, `ix_sessoes_expira`, `ix_passes_expira` | a faxina periódica |
| `ix_auditoria_*` | investigação por tempo, por pessoa e por evento |

**Não lidas são contadas, nunca acumuladas.** Um contador dessincroniza — falha
no meio da transação, `saiu_em` retroativo, mensagem apagada — e fica errado
**para sempre**, porque nada sabe recalculá-lo. Um "3" que nunca some é o
defeito mais reclamado que um chat pode ter. Contar cai no índice e é exato por
construção.

---

## Tipos

- **Ids: ULID (TEXT).** Os 48 bits da frente são o relógio → ids criados em
  seguida ficam vizinhos no índice e `ORDER BY id` já é ordem cronológica. Os
  80 de trás são aleatórios → não se adivinha o próximo (autoincremento
  entregaria o mapa para enumeração).
- **Tempo: `BIGINT` de milissegundos.** Nem `DATETIME` do SQLite (que é texto)
  nem `timestamptz`: os dois motores formatam diferente, e comparar
  `"2026-08-14 09:00"` com `"2026-08-14T09:00Z"` falha **sem erro** — ordena
  errado o histórico e a paginação passa a pular mensagens.

> **Armadilha do PostgreSQL:** o driver `pg` entrega `BIGINT` como **string**.
> Sem conversão, `"1000" > "830"` é `false` — a retomada pararia de entregar
> mensagens assim que o `seq` passasse de 999, **em silêncio**. Resolvido em
> `banco.js` com `setTypeParser(20, Number)`.

---

## Escolher o motor

```bash
CHAT_BANCO=sqlite          # padrão; arquivo em dados/chat.db
CHAT_BANCO=pg              # PGHOST, PGDATABASE, PGUSER, PGPASSWORD
```

**Fique no SQLite** se: uma instalação por empresa, um processo, até algumas
centenas de pessoas. Com WAL ligado, leitura e escrita não esperam uma pela
outra.

**Vá para o PostgreSQL** se: mais de um processo, milhões de mensagens, ou o
cliente já tem Postgres e quer backup unificado.

A migração de um para o outro **não está automatizada** — é exportar e importar.
Escolha antes de subir.

---

## Migrações

```bash
npm run migrar          # aplica o que falta
npm run migrar:status   # mostra em que versão este servidor está
```

Cada migração roda **uma vez**, registrada no próprio banco, **dentro de uma
transação**. Uma que falhe no meio deixaria metade das tabelas e nenhum registro
— o pior estado possível, porque a próxima tentativa esbarraria em tabela
existente e pararia. Os dois motores aceitam DDL em transação; é o que faz
falhar significar **"nada mudou"**.

A ordem é a do array em `migrar.js`, **não** a ordem alfabética de arquivos numa
pasta: listagem de diretório muda entre sistemas de arquivos, e uma migração
fora de ordem cria tabela antes da que ela referencia.
