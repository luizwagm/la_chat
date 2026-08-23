# Parecer de segurança — LA Chat 0.12.0

**23 de agosto de 2026 · 2ª emissão · revisão de código e leitura da suíte**

O sistema estava fechado: toda rota exigia sessão de funcionário. A reunião por
link abriu a primeira porta que responde a quem não tem credencial nenhuma. Este
parecer avalia o conjunto e, principalmente, o que essa porta mudou.

---

## Grau: **A−** — firme, com uma pendência real

A base é forte e incomum: **uma dependência de produção**, zero vulnerabilidades
conhecidas, cifra autenticada em repouso, e defesas escritas contra ataques
nomeados — não genéricas. **597 testes**, dos quais 96 são de segurança e 97
cercam a sala por link.

Desde a 1ª emissão: os **anexos passaram a ser cifrados em disco** (A3) e **toda
reunião por link vai pelo relay** (A2), de modo que ninguém descobre o endereço
de ninguém. No caminho apareceu um quarto defeito (A7), também corrigido.

Sobra **uma pendência de verdade**, e ela não é de código: **o TURN continua sem
existir**. Enquanto isso, o vídeo não deve ser ligado — sem relay a reunião falha
em rede corporativa; com relay mal configurado, vira túnel para dentro do servidor.

| Área | Grau | Fundamento |
|---|---|---|
| Autorização | Alto | Lista branca com padrão RECUSAR. Rota nova nasce proibida para convidado. |
| Tempo real | Alto | Bilhete de uso único, 30 s. Cookie não autentica socket. |
| XSS | Alto | Impossível por construção: nenhum `innerHTML` recebe texto de pessoa. |
| Superfície de código | Alto | 1 dependência de produção (`ws`), 2 opcionais de banco. `npm audit`: 0. |
| Dados em repouso | Alto | Banco **e anexos** em AES-256-GCM, com selo que preserva o que já estava no disco. |
| Privacidade da mídia | Alto | Reunião por link vai pelo relay: nem o convidado vê o IP de dentro, nem o contrário. |
| Prazo da reunião | Alto | Decidido pelo relógio do servidor, igual para os dois lados. Encerrada não reabre. |
| Infraestrutura de mídia | **Pendente** | TURN não instalado. Ao instalar, torna-se o item mais sensível. |
| Confidencialidade fim a fim | Por decisão | Sem E2EE (ver D2). O servidor pode ler as mensagens. |

---

## Superfície de ataque — o que responde sem credencial

São seis rotas, e três nasceram com a reunião por link.

| Rota | Quem alcança | Freio |
|---|---|---|
| `GET /call/<código>` | Qualquer um, com o link | — (HTML constante) |
| `GET /call/<código>/info` | Qualquer um | 20/min por IP |
| `POST /call/<código>/entrar` | Qualquer um | 10/min por IP |
| `POST /entrar` | Só com passe assinado | HMAC + `jti` único |
| `POST /elenco` | Só o servidor do site | HMAC + `jti` único |
| `GET /saude` | Qualquer um | Sem versão em produção |

O espaço de códigos é de 58^11 — cerca de 2^64 combinações, em base58 sem os
caracteres que se confundem. Com o freio de 20 por minuto, varrer é inviável.
**Adivinhar não é um caminho. Vazar o link é.**

As três recusas — inexistente, revogada, expirada — são **a mesma frase, no mesmo
caminho, gastando o mesmo freio**. Distinguir confirmaria ao curioso que ele
acertou um código, e é assim que tentativa e erro vira mapa.

---

## Achados

Cada um verificado no código. Nenhum é suspeita.

### A1 · O TURN é a peça mais perigosa, e ainda não existe — **grave ao ligar**

Hoje `CHAT_TURN` está vazio: de 15% a 20% das chamadas vão falhar, concentradas
em rede corporativa. Isso é qualidade. O problema de *segurança* nasce no dia em
que o TURN subir — porque **todo portador de um link passa a receber credencial de
relay**, e um relay mal configurado encaminha para onde mandarem. Sem as travas de
rede, quem tem um convite ganha um túnel para dentro da rede privada do servidor.

> `src/aplicacao/salas.js` → `chamadas.entrar()` → `turn.credenciais()`
> o convidado recebe `iceServers` ao entrar — por desenho, ele precisa deles.

**Fazer:** em `/etc/turnserver.conf`, `use-auth-secret`, `no-loopback-peers` e as
quatro linhas de `denied-peer-ip` (10/8, 172.16/12, 192.168/16, 169.254/16). Já
estão escritas em `docs/VIDEO.md`. **Não são opcionais.** A credencial expira em
2 h e é derivada por HMAC — vazou, morre sozinha.

### A2 · Numa sala anônima, os dois lados veem o IP um do outro — **corrigido (0.12.0)**

A malha é direta: a mídia não passa pelo servidor, ótimo para confidencialidade e
custo. O preço é que cada participante descobre o IP dos outros. No chat interno é
irrelevante — são colegas. **Numa reunião com estranho, deixa de ser.**

> `config.js:282` → `soRelay: bool(process.env.CHAT_VIDEO_SO_RELAY, false)`
> `turn.js:108` → `iceTransportPolicy: soRelay && temTurn ? "relay" : "all"`

**Feito:** a política deixou de ser só global. Toda chamada nascida de um link usa
`relay`, com ou sem a chave de instalação — e a decisão é tomada na **abertura**,
não quando o primeiro convidado chega: se só um lado estivesse em relay, o outro
continuaria anunciando os próprios candidatos e o endereço vazaria assim mesmo.
Sem TURN configurado, **não** se pede relay: seria chamada impossível, não
chamada privada.

### A3 · O banco é cifrado; os anexos, não — **corrigido (0.12.0)**

Mensagens, e-mails, nomes de convidado, títulos e códigos de sala vão para o banco
em AES-256-GCM. Os **arquivos enviados vão para o disco em claro**, protegidos só
por permissão de arquivo. Quem levar um backup lê os anexos e não lê as conversas
— uma assimetria que ninguém espera, e que importa quando o anexo é um exame ou um
contrato.

> `src/infra/storage/armazenamento.js:83` → `await fsp.writeFile(tmp, bytes, { mode: 0o600 })`
> ocorrências de `cripto` no arquivo: **0**

**Feito:** formato binário próprio — `LAC1` + versão + IV + dados + tag, 33 bytes
de sobrecarga. **O selo no começo é o que torna isto seguro para quem já tem
anexos no disco**: arquivo sem selo é conteúdo antigo e sai como está. O download
continua por fluxo — a tag do GCM mora no fim, então os 16 bytes finais são
buscados **antes** de começar a entregar. Arquivo adulterado interrompe o
download em vez de ser entregue.

### A4 · A chave mora ao lado do que ela protege — **atenção**

`CHAT_DADOS_CHAVE` vive em `/etc/lachat-<instância>.env`, modo 640,
`root:deploy`. Protege muito bem o cenário provável — backup roubado, banco
exfiltrado, disco descartado — e **não protege nada** contra comprometimento total
da máquina. É a limitação inerente de cifra em repouso sem HSM, e vale dizê-la em
voz alta em vez de deixar a palavra "criptografado" sugerir mais do que entrega.

A chave é **por instância**: o vazamento de um cliente não alcança os outros.

**Fazer:** guardar cópia dos `.env` **fora do servidor**. Perder a chave torna o
histórico ilegível, e o backup não salva.

### A7 · O prazo valia para o convidado e não para o anfitrião — **corrigido (0.12.0)**

Encontrado *depois* da 1ª emissão, ao endurecer o tempo da reunião. O convidado
sempre foi julgado pelo **relógio**; o anfitrião era julgado pelo **estado**, que
só vira `encerrada` quando a faxina roda — até 20 segundos depois. Nessa janela,
quem criou a sala reabria uma reunião com prazo vencido enquanto os convidados
batiam na porta ouvindo que o tempo tinha acabado. **Duas verdades sobre a mesma
sala, dependendo de quem perguntava.**

Ao lado dele, um segundo: reabrir uma sala *viva* era recusado em silêncio pelo
`WHERE estado = 'aberta'`. A aplicação criava uma chamada nova e a sala continuava
apontando para a **morta** — o anfitrião entrava numa reunião que a sala não
conhecia, e todo convidado ia parar na chamada velha, vendo "aguarde o anfitrião"
para sempre.

**Feito:** o prazo é do **relógio**; a faxina apenas o registra. Encerrada, a
reunião não volta por porta nenhuma — nem reabrindo a sala, nem entrando direto na
chamada, nem pelo link. E reabrir **nunca** adia a hora de acabar.

### A5 · Sem E2EE, e isso é escolha registrada — **por decisão**

O servidor pode ler as mensagens. A decisão está em `CHAT_ARCHITECTURE.md` (D2) e
o motivo é técnico: busca por índice cego, histórico que sobrevive à troca de
aparelho e moderação são incompatíveis com E2EE de verdade. **E2EE só no rótulo
seria pior que a ausência dela.**

**Fazer:** dizer isso ao cliente antes que ele pergunte. "Cifrado em repouso e em
trânsito, legível pelo servidor" é defensável; "criptografado", sozinho, não é.

### A6 · A força do chat é a força do login do site — **informativo**

O chat não tem senha própria: quem diz "esta pessoa é a Ana" é o site hospedeiro,
por passe assinado de 60 s, uso único. O desenho está certo — não duplicar
credencial evita duas fontes de verdade divergindo. A consequência é que o chat
**herda a qualidade do login do hospedeiro**, incluindo a ausência de segundo fator.

> `passe.js` — HMAC-SHA256, 60 s, `jti` de uso único, `timingSafeEqual`.
> Recusa passe do futuro, expirado, repetido ou assinado com outro segredo.

---

## O que está genuinamente bem-feito

Um parecer que só lista problemas não ajuda a decidir onde **não** gastar tempo.

- **O socket não confia em cookie.** O navegador não aplica same-origin a
  WebSocket — qualquer site poderia abrir um e o navegador anexaria o cookie da
  vítima. Aqui a autenticação é por bilhete de uso único somada à conferência de
  `Origin`. É *a* defesa, não "defesa em profundidade".
- **Sessão e convidado são coisas diferentes.** Cookies separados (`cid`, `cvd`),
  validades diferentes (30 dias, 4 horas), e um portão que pergunta *"quem é, e
  para onde essa identidade vale?"* — não "há sessão?".
- **Revogar e remover valem na hora**, não na próxima recarga: o cookie morre e o
  socket cai junto.
- **Upload conferido pelos bytes**, não pela extensão. Executável do Windows
  disfarçado de PNG, shebang, HTML e SVG são recusados.
- **O código da sala não fica em claro no banco.** SHA-256 para achar, cópia
  cifrada para o anfitrião reler.
- **A página do convidado não interpola nada.** HTML constante, código vindo do
  endereço, CSP sem `unsafe-inline` para script, `frame-ancestors 'none'`,
  `noindex`.
- **O processo é contido pelo systemd.** `ProtectSystem=strict`, só
  `/var/lib/lachat/<instância>` gravável, sem novos privilégios. O chat escuta em
  `127.0.0.1` — nunca é alcançado direto da internet.
- **Uma instância por cliente.** Processo, banco e chave próprios: o vazamento
  entre clientes deixa de depender de o código estar certo.

---

## Antes de expor — a ordem importa

1. **Certificado antes de tudo.** Sem HTTPS o navegador não entrega câmera
   nenhuma, e sob `*.projetos.luizaugust.me` o HSTS já recusa `http://`.
   Pré-requisito, não etapa posterior.
2. **coturn instalado e endurecido** — `no-loopback-peers` e os quatro
   `denied-peer-ip`. Confira com cliente de TURN externo que o relay recusa
   destino privado.
3. **O `CHAT_VIDEO_SO_RELAY` virou opcional.** A reunião por link já força relay
   sozinha desde a 0.12.0. A chave continua existindo para quem quiser o mesmo
   nas chamadas internas.
4. **Estreie longe do cliente.** Instância de trabalho, duas máquinas de verdade,
   câmera de verdade. Não estreie a primeira rota sem credencial ao lado de
   conversa sobre paciente.
5. **Rode o `verificar.sh`.** Ele acusa `CHAT_BASE` no loopback e vídeo ligado sem
   TURN — os dois defeitos que só apareceriam na mão de quem recebe o convite.

---

## Limites deste parecer

- **Não houve pentest externo.** Isto é revisão de código somada à leitura da
  suíte. Um atacante real tenta o que nenhum teste escrito pelo autor tenta.
- **O caminho da mídia não foi exercitado com câmeras reais.** A sinalização foi
  verificada nos dois lados; a negociação completa exige duas máquinas.
- **O servidor não foi auditado** — nginx, firewall, sistema operacional e o site
  hospedeiro estão fora do escopo.
- **Não há prova de que a lista de achados seja completa.** Ela é o que a revisão
  encontrou, não o que existe.
