# VIDEO.md — reunião por vídeo

Ligada por `CHAT_VIDEO=1`. **Vem desligada**: uma instalação existente não deve
ganhar botão de câmera num deploy sem que alguém tenha decidido isso.

---

## A decisão: malha P2P, não SFU

### O que foi escolhido

Cada participante abre uma conexão WebRTC com **cada** um dos outros. A mídia
vai direto de navegador a navegador. **O servidor nunca a vê** — ele é só a
telefonista que repassa envelopes fechados.

### A conta que define o teto

Com N pessoas, cada uma **sobe** (N−1) fluxos:

| Pessoas | Subida de cada um (720p) | |
|---|---|---|
| 2 | ~1,5 Mbps | tranquilo |
| 4 | ~4,5 Mbps | ok |
| 6 | ~7,5 Mbps | dói em 4G e ADSL |
| 8 | ~10,5 Mbps | quebra |

Daí o teto de **6**, aplicado no servidor (`dominio/chamadas.js`). Ele existe
para a reunião **falhar na porta** em vez de degradar no meio: a sétima pessoa
entrando não deixa a chamada "um pouco pior" — ela derruba o áudio de todo
mundo, e ninguém entende por quê.

`CHAT_VIDEO_TETO` só desce. Subir daqui não melhora nada.

### A alternativa não escolhida: SFU

Um servidor de mídia (mediasoup, LiveKit, Janus) recebe **um** fluxo por pessoa
e reencaminha. A subida fica em 1,5 Mbps com qualquer número de participantes, e
escala para 50+. É o que o Teams faz.

O que ele custa aqui:

- **uma dependência pesada** — mediasoup exige compilação nativa no servidor
  (o `better-sqlite3` já causou `ERR_DLOPEN_FAILED` neste parque); LiveKit é um
  binário Go à parte, com a própria operação;
- **banda de servidor** — 10 pessoas numa reunião são ~150 Mbps de repasse, numa
  máquina que hospeda 20 sites;
- **a mídia passa a existir no servidor** — para uma clínica, "as conversas da
  equipe passam pela sua máquina" deixa de ser uma frase confortável.

**A decisão foi tomada com o tamanho real das reuniões destes clientes:** equipe
de clínica, oficina, academia — 2 a 6 pessoas. Quando isso mudar, o caminho
está preparado: o cliente fala com o servidor por uma interface de sinalização
que não pressupõe topologia, e trocar a malha por um SFU não toca em domínio,
banco nem autorização.

---

## Segurança

### A mídia é ponta a ponta, e não por escolha nossa

**DTLS-SRTP é obrigatório no WebRTC.** Não é opção, não é configuração, não há
modo inseguro. Em malha, isso significa que a conversa por vídeo é de fato
ponta a ponta — melhor do que o texto, que é cifrado em repouso mas o servidor
consegue ler.

> Isto é uma propriedade da topologia, não uma promessa de marketing. Com SFU,
> o servidor passaria a ver a mídia (salvo E2EE por *insertable streams*, que é
> outro projeto).

### Quem pode entrar

**Quem é membro da conversa.** Nada mais.

A autorização não é nova: é a mesma `exigirMembro` que já protege mensagens e
anexos, já vive dentro do SQL e já tem suíte de segurança em cima. Não há sala
com link, convite para gente de fora nem sala de espera — cada um desses seria
um lugar novo para errar.

### O sinal — a rota mais sensível

O repasse de SDP e candidatos ICE é conteúdo arbitrário indo de uma pessoa a
outra. As quatro travas, em `aplicacao/chamadas.js`:

1. **Forma** — tipo de lista fechada (`oferta`, `resposta`, `candidato`,
   `renegociar`) e teto de tamanho.
2. **Quem manda** — é membro da conversa **e** está dentro da chamada.
3. **Quem recebe** — está dentro da mesma chamada.
4. **A origem é carimbada pelo servidor.** O campo `de` que vier do cliente é
   descartado; quem diz de quem é o sinal é a sessão do socket. Sem isso,
   qualquer participante injetaria uma oferta de mídia em nome de outro.

Testado em `testes/video.cjs`, inclusive a tentativa de falsificação.

> **O teto do sinal (32 KB) fica abaixo do teto do quadro WebSocket (64 KB) de
> propósito.** Eram iguais, e o teste mostrou o que isso causava: um sinal
> grande demais estourava o `maxPayload` do `ws`, que **fecha a conexão** — a
> pessoa perdia o socket inteiro em vez de receber uma recusa. Uma trava não
> pode ser mais destrutiva que o abuso que ela impede.

### Exposição de IP — leia antes de instalar

**Numa conexão WebRTC direta, os participantes veem o endereço IP uns dos
outros.** É como o protocolo funciona: os candidatos ICE carregam endereços.

Numa equipe interna isso costuma ser irrelevante. Se não for — pessoas em casa,
trabalho sensível — existe a saída:

```bash
CHAT_VIDEO_SO_RELAY=1
```

Toda a mídia passa a ir pelo TURN. Custa banda do servidor e um pouco de
latência; em troca, ninguém vê o IP de ninguém.

**Desde a 0.12.0 esta chave não é mais necessária para a reunião por link.**
Toda chamada nascida de um `/call/<código>` já força `relay` sozinha, com ou
sem a chave — e a decisão é tomada na **abertura** da sala, não quando o
primeiro convidado chega. Se só um lado estivesse em relay, o outro continuaria
anunciando os próprios candidatos, e o endereço vazaria assim mesmo.

A chave continua existindo para quem quiser o mesmo comportamento nas chamadas
**internas**, entre colegas.

> **Sem TURN configurado, o relay NÃO é pedido** — nem pela chave, nem pela
> sala. Pedir `relay` sem servidor de relay não deixa a chamada mais privada:
> deixa a chamada **impossível**, porque o navegador descarta todo candidato que
> não seja de relay e não sobra nenhum. Falharia em silêncio, com cara de
> problema de rede.

### O que NÃO existe

- **Gravação.** Exigiria consentimento explícito (LGPD), aviso visível a todos,
  guarda cifrada, prazo de retenção e política de acesso — e, em malha, exigiria
  um servidor recebendo a mídia só para gravar, que é metade de um SFU.
- **Transcrição, legenda, resumo por IA.** Mesma razão, com o agravante de
  mandar conteúdo para fora.
> Até a 0.10.0 esta lista trazia também **"sala com link para gente de fora"**.
> Ela existe desde então — ver a seção *A reunião por link*, mais abaixo, e
> `docs/PARECER-SEGURANCA.md` para o que ela mudou na superfície de ataque.

---

## TURN — obrigatório, e o porquê

Entre **15% e 20%** das conexões não fecham direto: NAT simétrico, firewall
corporativo bloqueando UDP, operadora de celular com CGNAT.

Essa fatia **não é aleatória** — concentra-se em rede de empresa, que é o
público deste chat. Sem TURN, o sintoma é *"às vezes a chamada não conecta"*:
intermitente, concentrado no cliente que mais importa, e quase impossível de
diagnosticar por telefone.

### Instalar o coturn

```bash
apt install coturn
```

`/etc/turnserver.conf`:

```conf
listening-port=3478
tls-listening-port=5349

# O IP público da máquina. Sem ele o coturn anuncia o IP interno e o relay
# não funciona de fora — é o erro de instalação número um.
external-ip=SEU.IP.PUBLICO

realm=chat.seudominio.com

# ==========================================================================
#  CREDENCIAL TEMPORÁRIA — nunca usuário e senha fixos.
#
#  A credencial VAI para o navegador: ela aparece no DevTools de qualquer
#  funcionário. Fixa e vazada, o seu servidor vira relay de graça para
#  estranhos — e a conta de banda é sua. Acontece o tempo todo com coturn.
#
#  Com `use-auth-secret`, o chat deriva credenciais de curta duração do mesmo
#  segredo, e o coturn refaz a conta. Vazou? Expira em duas horas.
# ==========================================================================
use-auth-secret
static-auth-secret=O_MESMO_VALOR_DE_CHAT_TURN_SEGREDO

# TLS, para atravessar firewall que só deixa passar 443.
cert=/etc/letsencrypt/live/chat.seudominio.com/fullchain.pem
pkey=/etc/letsencrypt/live/chat.seudominio.com/privkey.pem

# ==========================================================================
#  NÃO SEJA UM RELAY ABERTO PARA A REDE INTERNA.
#
#  Sem estas linhas, quem obtiver uma credencial pode usar o TURN para
#  alcançar 127.0.0.1 e a rede local do servidor — inclusive os OUTROS sites
#  do parque, que escutam no loopback. É Server-Side Request Forgery com
#  ajuda do seu próprio relay.
# ==========================================================================
no-loopback-peers
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=169.254.0.0-169.254.255.255

# Teto de banda por sessão (kbps). Uma reunião de 720p usa ~1500.
user-quota=12
total-quota=200
```

E no `/etc/lachat-<cliente>.env`:

```bash
CHAT_VIDEO=1
CHAT_TURN=turn:chat.seudominio.com:3478,turns:chat.seudominio.com:5349
CHAT_TURN_SEGREDO=<o mesmo static-auth-secret>
CHAT_STUN=stun:chat.seudominio.com:3478
```

> **O STUN padrão é o do Google** (`stun.l.google.com`). Ele só responde "o teu
> IP público é este" — não vê mídia e não custa banda. Ainda assim, quem quiser
> autonomia total aponta para o próprio coturn, que também faz STUN.

### A reunião por link, e o que ela cobra do TURN

A partir da 0.10.0 o anfitrião gera `/call/<11 caracteres>` e manda para quem
quiser; quem recebe digita um nome e entra, sem conta. Isso muda o peso desta
seção inteira:

**Todo portador de um link passa a receber credencial de relay.** É por desenho
— sem ela não há reunião. E é o que torna `no-loopback-peers` e as quatro linhas
de `denied-peer-ip` **obrigatórias**, e não recomendadas: sem elas, um convite
de reunião vira um túnel para dentro da rede privada do servidor, onde escutam
todos os outros sites do parque.

A credencial dura 2 h, é derivada por HMAC do `static-auth-secret` e não dá
acesso a dado nenhum — só a relay. Vazou, morre sozinha.

> **Um coturn serve TODAS as instâncias do chat.** O `static-auth-secret` é do
> servidor, não do cliente: o mesmo valor vai no `/etc/lachat-<cliente>.env` de
> cada instância que usar vídeo. A consequência a conhecer é o raio de alcance —
> vazando o env de um cliente, vaza o segredo do relay de todos. Não vaza
> conversa nem arquivo de ninguém: as chaves de dados (`CHAT_DADOS_CHAVE`)
> continuam sendo uma por instância.

### Firewall

```bash
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 5349/tcp
ufw allow 49152:65535/udp    # a faixa de relay do coturn
```

---

## O protocolo

Sinalização sobre o **mesmo WebSocket** do chat. Nada novo a configurar no
nginx além do que o chat já exige.

| Evento | Direção | Quando |
|---|---|---|
| `cham.toca` | → cliente | alguém está chamando |
| `cham.entrou` | → cliente | alguém entrou (com a lista de participantes) |
| `cham.saiu` | → cliente | alguém saiu |
| `cham.fim` | → cliente | a reunião acabou |
| `cham.disp` | ↔ | mudo, câmera, tela |
| `cham.sinal` | ↔ | SDP e candidatos ICE |

**Só o `sinal` vai pelo socket.** Iniciar, entrar, sair e mudo vão por HTTP,
onde já existem CSRF, limitador e tratamento de erro. O sinal é a exceção
porque é o único de alta frequência: montar uma malha de seis pessoas troca
centenas de candidatos em poucos segundos.

### Quem faz a oferta

**Quem já estava na sala oferece ao recém-chegado.** Determinístico, sem
negociação sobre quem começa, e elimina a colisão no caso comum.

A colisão sobra na **renegociação** (duas pessoas compartilhando tela no mesmo
instante), e aí vale o padrão de *negociação perfeita*: um lado é **educado** e
cede, o outro ignora a oferta fora de hora. O papel sai da comparação dos ids —
sem combinar nada, os dois lados chegam a conclusões opostas, que é exatamente
o necessário.

---

## Operação

### Reuniões fantasma

Uma chamada que ninguém encerrou (aba fechada no susto, servidor reiniciado no
meio) travaria a conversa para sempre: o índice único `ix_chamada_viva` impede
uma segunda, e o sintoma seria *"o botão de chamar parou de funcionar"*.

A faxina (a cada 30 min) encerra:
- as que estão **tocando** há mais de 45 s;
- as **ativas sem ninguém dentro** há mais de 5 min.

E a queda do socket já tira a pessoa da reunião na hora.

### O que a auditoria registra

`CHAMADA_INICIADA` e `CHAMADA_ENCERRADA`, com duração e pico de participantes.
**Nenhum conteúdo** — não existe conteúdo a registrar.

### Diagnóstico

| Sintoma | Causa quase certa |
|---|---|
| O botão 🎥 não aparece | `CHAT_VIDEO` desligado — o código do vídeo nem é servido |
| "As chamadas de vídeo não estão ativadas" | idem, do lado do servidor |
| Conecta entre colegas do mesmo escritório, falha de casa | **falta TURN** |
| Conecta para uns e não para outros, sem padrão | TURN configurado sem `external-ip` |
| A chamada cai depois de ~2 h | credencial TURN expirada e não renovada |
| Reunião não abre naquela conversa | chamada fantasma — veja a faxina |
| Conversa maior que o teto | é a recusa na porta, e é intencional |

```bash
# O coturn está recebendo?
journalctl -u coturn -f

# A credencial que o chat emite bate com a do coturn?
curl -s https://site/chat/chamadas/<id>/credenciais -H "Cookie: ..." | jq
```

---

## Limitações conhecidas

1. **Teto de 6.** É a malha, não uma escolha de produto.
2. **Sem SFU**, portanto sem reunião grande, sem simulcast e sem escolha de
   qualidade por participante.
3. **Sem gravação.**
4. **Sem sala com link** — só membros de conversa.
5. **Sem desfoque de fundo** (exigiria modelo de visão no navegador).
6. **Compartilhar tela não existe em celular** — `getDisplayMedia` não é
   suportado, e o botão não aparece em vez de aparecer sem funcionar.
7. **Não há teste automatizado de mídia.** A sinalização inteira é testada
   (`testes/video.cjs`, 65 casos); o que passa pela câmera é conferido no
   navegador, à mão.
