# CHANGELOG

Formato: `MAIOR.MENOR.CORREÇÃO`. Toda alteração sobe a versão — 2ª casa para
recurso, 3ª para correção. Nenhuma casa para no 9.

---

## 0.16.1 — 23/08/2026 · os dois cookies no mesmo navegador

O segundo defeito do "conectando…", e só apareceu ao reproduzir o arranjo REAL:
o convidado entrando **pelo conector**, no mesmo navegador em que já havia um
funcionário logado.

Os dois cookies convivem na mesma origem, e é o caso **normal**: alguém logado
no sistema recebe um link de reunião e o abre ali mesmo. A partir daí a origem
tem `cid` (funcionário) e `cvd` (convidado).

A regra do roteador era *funcionário primeiro, convidado depois*. O pedido da
página do convidado levava o CSRF do CONVIDADO e era conferido contra a sessão
do FUNCIONÁRIO — **403, sempre**. Sem bilhete, sem socket, sem sinalização.

Agora o pedido diz com qual identidade fala (`X-Chat-Como: convidado`). O
cabeçalho **rebaixa**, nunca eleva: continua exigindo o cookie `cvd` e o CSRF
que combina com ele, e quem não tem sessão de convidado não ganha nada com ele —
há teste dos três casos.

### O que a reprodução ensinou

A correção anterior (0.16.0) foi verificada com o cliente real, mas **direto no
serviço do chat**. A produção passa pelo conector, e foi só ali que este segundo
defeito apareceu.

Verificar no arranjo certo não é detalhe: os dois defeitos produziam o MESMO
sintoma, e o primeiro escondia o segundo.

---

## 0.16.0 — 23/08/2026 · o convidado procurava o cookie do funcionário

**Era este o defeito.** Não o TURN, não o firewall, não a rede, não o relay —
todos foram investigados a fundo e estavam certos.

O convidado tem sessão própria: cookie `cvd`, token `cvd_csrf`. O componente
procurava sempre `cid_csrf`, o do funcionário. Para um convidado esse cookie não
existe, então o CSRF ia **vazio**, o `POST /bilhete` era recusado, e ele
**nunca abria o WebSocket**.

Sem socket não há troca de sinais WebRTC. O sintoma: a reunião abre, as pessoas
aparecem com nome na tela, e todos os retratos ficam eternamente em
"conectando…" — com cara de problema de rede. E a chamada interna funcionava,
porque ali o cookie é `cid`. **"O chat funciona, só o link não."**

Verificado com o cliente real, no navegador: o convidado passou a ler um token
de 43 caracteres, o socket abre, e o estado ICE entre anfitrião e convidado
chega a `connected`. Com `cid`, o mesmo teste devolve string vazia.

### Por que 660 testes não pegaram

Porque o cliente de teste monta o cabeçalho CSRF sozinho, lendo o cookie certo.
**A suíte provava o servidor e emulava um cliente correto** — exatamente o que o
cliente de verdade não era.

As travas novas olham o CÓDIGO DO CLIENTE, que é onde o defeito morava: o nome
do cookie tem de depender do modo, e o `csrf()` não pode trazer o `"cid"` de
volta escrito à mão. Uma delas se auto-verifica. E há um caso no servidor
fixando a consequência: CSRF vazio não tira bilhete.

### Investigação: o que não era

Ficam registrados, porque custaram caro e podem voltar a ser suspeitos:

* **O relay estava perfeito** — provado da máquina de quem reclamava: TCP e UDP
  chegam, o coturn desafia com o realm certo e concede alocação nos dois
  transportes. Nenhum firewall de nuvem era necessário.
* **A política de transporte não era o problema** — `CHAT_VIDEO_SALA_RELAY=0`
  não mudou nada, e foi essa informação que descartou a mídia e apontou para a
  sinalização.

### Também

**Recuo automático do relay.** Se uma conexão falha de verdade e estávamos em
`relay`, a malha é refeita em conexão direta, com aviso na tela do que isso
custa. Uma reunião que não acontece não protege o IP de ninguém: as pessoas
desligam e usam outro aplicativo, onde o IP também aparece.

---

## 0.15.2 — 23/08/2026 · o aviso que alarmava sem motivo

A frase **"Não foi possível falar com o servidor de relay"** apareceu durante uma
reunião numa instalação onde o relay estava **perfeito**. Provado de fora, da
máquina de quem reclamava: TCP chega, UDP chega, o coturn desafia com o realm
certo e **concede a alocação** — por UDP e por TCP.

O defeito era do aviso. `onicecandidateerror` dispara **por servidor e por
tentativa**: numa lista com STUN e TURN, UDP e TCP, é normal que uma entrada
falhe enquanto outra funciona e a chamada conecta. Pôr isso na tela na hora
transformou ruído de negociação em alarme — e custou horas de investigação num
lugar onde não havia defeito.

**Aviso na tela é para FALHA, não para tentativa frustrada.** Agora o erro de
candidato é apenas registrado (`video.errosIce`), e quem fala com o usuário é o
estado da conexão: só quando ele vira `failed` aparece uma mensagem — e ela traz
o resumo do que foi tentado, para diagnosticar sem abrir o console.

A lição vale além daqui: um alarme que dispara durante o funcionamento normal
não é excesso de zelo. Ele gasta o tempo de quem confia nele, e ensina a ignorar
o painel.

---

## 0.15.1 — 23/08/2026 · o erro de ICE diz QUAL servidor falhou

A frase "Não foi possível falar com o servidor de relay" apareceu numa
instalação onde o relay estava **perfeito** — provado de fora, com a mesma
credencial que o chat emite: TCP e UDP chegam, o coturn autentica e concede
alocação.

O problema da mensagem era não dizer **de qual endereço** ela falava. A lista de
`iceServers` tem mais de um, e o erro de um deles produzia uma frase que mandava
investigar o outro.

Agora a URL entra na frase, e o erro bruto — código, texto, endereço, porta,
horário — fica guardado no componente para quem for consertar:

    document.querySelector("la-chat").video.errosIce

A tradução continua para quem está na reunião; o detalhe fica para quem
diagnostica. São públicos diferentes, e antes os dois recebiam a mesma frase
curta demais para um e técnica demais para o outro.

---

## 0.15.0 — 23/08/2026 · só administrador cria link, e o relay é testado de verdade

### Criar reunião por link virou ato de administrador

Todo funcionário pode LIGAR para um colega — é conversa entre quem já está
dentro. Criar um link é abrir uma porta que responde a quem não tem credencial
nenhuma, com a banda e o nome da empresa atrás dela. **Essa decisão não pertence
a cada pessoa**, e esta é a única rota do chat que precisa desse degrau,
justamente porque é a única que fabrica acesso externo.

Revogar e remover continuam com quem CRIOU a sala: tirar alguém de uma reunião
não pode depender de achar um administrador.

Na tela, a aba "Reuniões" só aparece para quem pode criar — uma aba que só sabe
dizer "você não pode" ocupa espaço e ensina a ignorar o menu. A tranca de
verdade é a do servidor.

### O verificar.sh EXERCITA o relay em vez de ler configuração

Ler o `turnserver.conf` responde *"está escrito certo?"*. Não responde
*"funciona?"* — e as duas perguntas se separam em silêncio: segredo com espaço
no fim, coturn que subiu antes do certificado, porta ocupada.

Agora o relatório faz a MESMA conta que o chat (HMAC-SHA1 sobre
`<validade>:<usuário>`) e pede uma alocação de verdade, pelo `turnutils_uclient`.
Passou, relay e credencial estão provados.

E ele diz o que **não** alcança: tudo é medido de dentro do servidor. Um relay
que aceita a credencial localmente e não recebe pacote nenhum da internet passa
por todas as conferências — e é o caso mais comum de "o chat funciona e o link
não", porque há um firewall de NUVEM, no painel do provedor, além do ufw.

Uma sessão inteira de investigação virou essa seção.

### Migração 005 — arquivar e remover

Base para o menu de conversas. `arquivada_em` fica em `conversa_membros`
(é de quem arquivou, e de mais ninguém); `apagada_por` fica em `conversas`
(é da conversa, e só o administrador remove).

**Remover não apaga linha nenhuma.** É uma marca: a conversa e as mensagens
continuam no banco, invisíveis. Remoção de conversa é ato de administrador sobre
o histórico dos OUTROS, e um clique errado ali não pode ser definitivo.

---

## 0.14.0 — 23/08/2026 · a reunião por link, usada de verdade

Quatro problemas relatados por quem estava usando, e a causa do quinto.

### "Saí da reunião e não consigo voltar"

`estado = 'ativa'` diz que a sala foi **aberta**, não que há reunião
acontecendo. Quando o anfitrião sai e era o último, a CHAMADA encerra e a SALA
continua ativa, apontando para ela — e a tela oferecia "Entrar", que levava à
chamada morta e respondia *"Esta chamada já terminou"*.

**O dono ficava trancado do lado de fora da própria reunião, com o link já
distribuído.** A lista passou a informar `chamadaViva`, e o botão vira "Reabrir
sala". O prazo não muda: reabrir não estica a reunião.

### "Recarreguei no celular e ele pediu o nome de novo"

Pior que o incômodo: entrar de novo criava um convidado **novo**, com id novo,
gastando mais uma vaga do teto. Uma sala de cinco lugares se esgotava com uma
pessoa e quatro recargas — e o anfitrião via cinco desconhecidos com o mesmo
nome.

O cookie do convidado vale 4 h justamente para isto. `GET /call/<codigo>/eu`
retoma a identidade que já existe. Sem cookie não se retoma nada (o link
sozinho não basta), e quem foi removido não volta recarregando.

### "Preciso do link durante a reunião"

Ele vivia só na aba "Reuniões", e a reunião cobre a tela — então, no momento em
que o anfitrião mais precisa dele, era preciso sair para buscá-lo. Agora há um
botão **🔗 Link** no topo da reunião, e só quando a chamada é de uma sala.

### A causa do "conectando…" — e ela é nossa

O relato que resolveu: **"entre funcionários funciona, só o link não"**.

Chamada interna usa `iceTransportPolicy: "all"`; reunião por link usa `relay`
desde a 0.12.0, para o convidado não descobrir o IP de quem está dentro. Com o
relay **quebrado**, o navegador descarta todo candidato que não seja de relay e
não sobra nenhum: a interna conecta, a do link nunca.

O sintoma engana — "o chat funciona, só o link não" manda procurar defeito na
sala, e o defeito está no coturn.

Duas respostas. **`CHAT_VIDEO_SALA_RELAY=0`** desata o nó enquanto o relay é
consertado (não é neutro: os IPs voltam a ser visíveis, e o serviço avisa isso
na subida). E o cliente passou a **traduzir o erro de ICE**: código 401/403 vira
*"O servidor de relay recusou a credencial"*; 701 vira *"Não foi possível falar
com o servidor de relay"*. O navegador sempre soube a resposta; ela só não
estava chegando à tela.

### Também

O freio de entrada na sala virou configurável (`CHAT_SALA_FREIO_ENTRAR`, padrão
10/min por IP). A suíte precisou: todos os casos saem do mesmo 127.0.0.1, e a
partir de certa quantidade passaram a esbarrar num limite que existe para barrar
varredura de códigos — um teste vermelho que não denunciava defeito nenhum.

**20 casos novos** para a retomada e a volta do anfitrião, incluindo o que prova
que quatro recargas continuam sendo uma pessoa na sala.

---

## 0.13.5 — 23/08/2026 · o script que mandava apontar o DNS para o Docker

Três defeitos do `criar-relay.sh`, todos vindos de um uso real.

### Aceitava qualquer coisa como domínio

Chamado com `bemestar` — que é nome de INSTÂNCIA, do script vizinho — ele
seguia adiante procurando o DNS de uma palavra solta e terminava mandando criar
um registro A para ela.

A confusão era previsível, porque os dois scripts recebem coisas diferentes:

    ./deploy.sh       <instancia> <porta> <origens>   ← por CLIENTE
    ./criar-relay.sh  <dominio>   [email]             ← por SERVIDOR

Agora ele recusa na entrada. E, se o nome corresponder a uma instância que
existe, diz qual das duas coisas a pessoa provavelmente queria.

### Sugeria o IP errado — e o errado era privado

Para dizer "aponte o DNS para cá", ele pegava o primeiro endereço da lista que
tivesse um ponto. Num servidor com contêineres, esse é `172.17.0.1`: **a ponte
do Docker**, endereço privado desta máquina e de mais ninguém.

Sugestão errada num passo de infraestrutura é pior que sugestão nenhuma — tem
cara de autoridade, e o registro criado a partir dela demora a ser desconfiado.
Agora as faixas privadas (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 e o
CGNAT 100.64/10) são descartadas, e o IPv6 fica para o registro AAAA.

### O arquivo estava duplicado, e o ensaio não pegou

Uma edição anterior partiu uma linha ao meio e deixou os passos 2 a 8 em duas
cópias. **O ensaio passou 27/27 mesmo assim** — rodar o script duas vezes é
idempotente, e todas as asserções continuavam verdadeiras.

O arquivo foi remontado a partir das partes íntegras, com conferência de que
cada passo aparece uma única vez. A lição é sobre o ensaio: ele provava o
RESULTADO e não notava que o caminho até ele havia sido percorrido em dobro.

---

## 0.13.4 — 23/08/2026 · duas checagens que erravam

Ambas encontradas por um relatório de verificação rodado num servidor de
verdade — e ambas do mesmo tipo: **conferiam o mecanismo, não a propriedade.**

### O segredo do TURN era dado por bom só por estar preenchido

O chat assina a credencial com `CHAT_TURN_SEGREDO`; o coturn refaz a conta com o
`static-auth-secret` dele. Diferentes, **toda alocação é recusada** — e o sintoma
na tela é idêntico ao de não haver TURN nenhum: todo mundo preso em
"conectando…".

A checagem aprovou uma instalação onde o valor era o **texto de exemplo copiado
do passo a passo**. Conferir a existência de um segredo não é conferir o segredo.

Agora ela compara os dois lados de verdade, reconhece texto de exemplo
(`cole`, `aqui`, `exemplo`, `seu_`, `<`, `>`) e, quando diferem, imprime o
comando que corrige. Entraram junto as travas de rede do relay:
`no-loopback-peers` e a contagem de `denied-peer-ip` — sem elas, um convite de
reunião alcança a rede interna do servidor.

### O WebSocket era julgado pelo `map`, não pelo cabeçalho

A checagem exigia um `map` chamado `connection_upgrade`. Essa é **uma** forma de
fazer o WebSocket atravessar o nginx, e é a nossa — mas um site que já servia
WebSocket antes do chat costuma ter `Connection "upgrade"` escrito à mão na
`location`, e funciona igual.

O resultado era **acusar de quebrado um servidor onde o tempo real estava
funcionando**. Num relatório de verificação, um erro falso gasta o mesmo tempo
que um erro verdadeiro — e ensina a ignorar o relatório.

Agora ela confere o que importa: o cabeçalho `Upgrade` sendo repassado. A prova
definitiva continua vindo de fora, mais adiante: o `/ws` responder 401 significa
que o aperto de mão atravessou o nginx e foi recusado pelo CHAT.

---

## 0.13.3 — 23/08/2026 · o relay órfão

O `verificar.sh` passou a notar o caso que custou uma investigação de rede: um
**coturn no ar na máquina** e a instância sem saber que ele existe.

A instalação do vídeo tem duas partes, e a segunda é fácil de esquecer porque a
primeira termina com tudo parecendo pronto — o coturn sobe, escuta na 3478,
`systemctl is-active` responde `active`. Falta ligar `CHAT_TURN` no
`/etc/lachat-<cliente>.env`, que é outro arquivo.

**O sintoma disso não se parece com configuração faltando. Parece defeito de
rede:** a reunião abre, as pessoas aparecem, e todos os retratos ficam
eternamente em "conectando…", porque cada navegador tenta conexão direta com um
STUN público e nada mais — o que falha quase sempre entre celulares em rede
móvel, onde o CGNAT impede o caminho direto.

Perguntar "há um coturn nesta máquina?" custa um `ss` e transforma meia hora de
investigação numa linha de configuração.

Entrou também a conferência do par: `CHAT_TURN` sem `CHAT_TURN_SEGREDO` faz o
coturn **recusar** as credenciais — os dois têm de existir, e o segredo tem de
bater com o `static-auth-secret`.

---

## 0.13.2 — 23/08/2026 · o nome que sumia e o vídeo que piscava

Dois defeitos vistos na tela de uma reunião real, com quatro pessoas. Nenhum
dos dois quebrava teste nenhum.

### Todos os retratos escritos "…"

O evento `cham.entrou` mandava a lista de participantes **sem o campo `nome`**.
Essa lista é gravada por cima da que o cliente já tinha — então a primeira
pessoa a entrar apagava a identificação de **todo mundo** de uma vez, inclusive
de quem já estava lá havia meia hora com o nome certo na tela.

A consulta já trazia o campo (é um JOIN com `usuarios`); ele só não estava sendo
copiado para o evento. Passou despercebido porque a suíte conferia QUEM entrou
(`u`) e nunca o conteúdo da lista — e porque, com duas pessoas em teste, um "…"
a mais não chama atenção. Com quatro, na tela do cliente, chama.

Duas trancas: o servidor manda `nome` e `avatar`, e o cliente passou a
**mesclar** em vez de substituir — um campo ausente no evento não apaga mais o
que já se sabia.

### O vídeo piscando

`pintarChamada()` reconstrói a tela inteira, e é chamada de dentro do
`oniceconnectionstatechange` — que dispara muitas vezes por segundo enquanto a
conexão não fecha. Cada chamada **recriava os elementos `<video>`** e reatribuía
as streams.

Os dois sintomas do relato eram a mesma cadeia: conexão travada → rajada de
eventos de ICE → rajada de repinturas → piscar. Quem estivesse com a reunião
funcionando não veria nada; quem estivesse com problema de rede via o problema
em dobro.

Agora os elementos são guardados antes de limpar e devolvidos aos quadros novos
— mover um `<video>` de lugar no DOM não interrompe a mídia, recriá-lo sim. E as
repinturas passaram a ser agendadas por `requestAnimationFrame`: uma rajada de
vinte eventos vira **uma** pintura.

### Nota sobre o relay

O sintoma "conectando…" que revelou os dois é de REDE, não destes defeitos.
Desde a 0.12.0 toda reunião por link usa `iceTransportPolicy: relay` — o que
significa que, com `CHAT_TURN` configurado mas o coturn inacessível, **nenhum
candidato sobra e a chamada nunca fecha**. Sem `CHAT_TURN`, a política volta a
`all` e a conexão tenta o caminho direto.

---

## 0.13.1 — 23/08/2026 · o relatório acusava uma instalação correta

O `verificar.sh` dizia **"CHAT_BASE não está no ambiente"** em instâncias onde
ele estava configurado. A causa: no bloco acrescentado na 0.12.0, a barra
invertida do `\K` foi comida pelo shell na hora de escrever o arquivo, e o
padrão virou `^CHAT_BASE=K.*` — procurando a letra K.

**Um relatório que acusa o que está certo é pior que um que não confere**: manda
a pessoa procurar defeito onde não há. O mesmo valia para `CHAT_VIDEO`, que
sempre voltava vazio e fazia o relatório dizer "vídeo desligado nesta instância"
mesmo com o vídeo ligado.

### A leitura do ambiente virou uma função só

Havia um `grep -oP` repetido em cada ponto de leitura — e foi assim que um deles
saiu diferente dos outros. Agora é `valor_de`, e ela tolera o que uma pessoa
escreve de verdade num `.env`: `export VAR=`, espaço antes do nome, aspas em
volta do valor e o `\r` de quem editou no Windows.

### Três causas, três mensagens

"Não está no ambiente" cobria o arquivo **inexistente**, o arquivo **sem
permissão de leitura** e a variável **realmente ausente**. São problemas
distintos com soluções distintas.

O da permissão é o mais traiçoeiro: o `/etc/lachat-<cliente>.env` é 640
`root:deploy`, então rodar o `verificar.sh` como outro usuário faz **toda**
leitura voltar vazia — e o relatório acusa uma instalação correta de estar pela
metade. Agora ele diz qual arquivo tentou ler e com que usuário.

### Duas travas

* **No ensaio do deploy**: sete casos que extraem a `valor_de` do
  `verificar.sh` de verdade — não uma cópia, que divergiria do original
  exatamente no dia em que importasse — e a exercitam contra o `.env` que o
  `deploy.sh` acabou de escrever. O ensaio foi de 19 para **26**.
* **No portão do CI**: um lint para a classe inteira do defeito, que recusa
  qualquer `grep -oP` com `=K` sem a barra invertida.

---

## 0.13.0 — 23/08/2026 · o relay de vídeo tem instalador

`criar-relay.sh` — roda **uma vez por servidor** e deixa o coturn pronto:

    sudo ./criar-relay.sh chat.luizaugust.me

DNS, IP público, segredo, vhost, certificado, coturn endurecido, permissões,
gancho de renovação, firewall e conferência final. **27 asserções** no
`ci/ensaiar-relay.sh`, que roda o script inteiro num diretório temporário com
dublês de certbot, nginx, systemctl e apt — e entrou no portão do CI.

### O vhost que não serve nada, e por que existe

O coturn **não passa pelo nginx**: escuta direto nas portas 3478 e 5349. O vhost
existe por um motivo só — permitir ao certbot emitir e **renovar** o certificado
que o coturn usa no `turns:`. Sem TLS, o relay não atravessa firewall corporativo
que só deixa passar 443, que é exatamente a rede onde o TURN mais faz falta.

Por isso ele responde `404` a tudo que não seja o desafio da ACME, e não repassa
para lugar nenhum. Está escrito no cabeçalho do arquivo gerado, para ninguém
removê-lo achando que sobrou.

### A armadilha de 90 dias

**O coturn lê o certificado ao subir e não o relê nunca mais.** O certbot renova
sozinho e escreve arquivos novos; sem gancho, o relay continuaria servindo o
antigo, já vencido, até alguém reiniciá-lo.

O sintoma chegaria três meses depois da instalação, sumiria assim que alguém
reiniciasse para investigar, e voltaria noventa dias depois. O script instala
`/etc/letsencrypt/renewal-hooks/deploy/10-coturn.sh`, e o ensaio confere que ele
existe, é executável e reinicia o serviço.

### O que o endurecimento cobre

Além do que `docs/VIDEO.md` já pedia:

* **`no-cli`** — o coturn abre, por padrão, um console telnet em
  `127.0.0.1:5766`. Num servidor com vinte sites, "só o loopback" não é
  isolamento: é exatamente o alcance que uma falha em qualquer um dos vinte
  concede.
* **As faixas privadas de IPv6** (`::1`, `fc00::/7`, `fe80::/10`) — estavam
  faltando. Numa máquina com IPv6, que é toda máquina em nuvem hoje, esquecê-las
  reabria o buraco inteiro.
* **`no-tlsv1` / `no-tlsv1_1`**, `fingerprint`, `stale-nonce`, e a faixa de relay
  explícita, para bater com a regra do firewall.

### O segredo é do SERVIDOR, não do cliente

Um coturn atende todas as instâncias, então o mesmo `static-auth-secret` vai no
env de cada uma. O raio de alcance ficou escrito no script e na documentação:
vazando o env de um cliente, vaza o relay de todos — e **nada além disso**, porque
`CHAT_DADOS_CHAVE` continua sendo uma por instância.

Gerado uma vez e **nunca** regerado: trocá-lo sem trocar nos clientes derrubaria
o vídeo de todos ao mesmo tempo, com um erro que o navegador reporta como "falha
de rede". O ensaio roda o script duas vezes para provar isso.

---

## 0.12.1 — 23/08/2026 · a documentação que mentia, e o aviso que faltava

`docs/VIDEO.md` listava **"sala com link para gente de fora"** entre o que o
sistema NÃO faz — e ela existe desde a 0.10.0. Documentação que contradiz o
código é pior que documentação faltando: manda a pessoa procurar noutro lugar
uma coisa que já está pronta.

Corrigido, e a seção do relay passou a dizer que a reunião por link já o força
sozinha desde a 0.12.0. Entrou também a nota sobre o **raio de alcance do
`static-auth-secret`**: um coturn serve todas as instâncias, então o segredo do
relay é do servidor e não do cliente. Vazando o env de um cliente, vaza o relay
de todos — mas nenhuma conversa nem arquivo, porque `CHAT_DADOS_CHAVE` continua
sendo uma por instância.

**O serviço passou a avisar ao subir** quando o vídeo está ligado e o TURN não
está configurado. Ele sobe assim mesmo — uma instalação em rede local, para
testar, é legítima —, mas ninguém deve descobrir isso pelo cliente reclamando
que "às vezes a chamada não conecta".

---

## 0.12.0 — 23/08/2026 · o que o parecer de segurança mandou fazer

Três achados do `docs/PARECER-SEGURANCA.md` fechados, e o prazo da reunião
passou a valer para os dois lados.

### O tempo acabou para todo mundo, não só para o convidado

O convidado sempre foi julgado pelo **relógio**: `podeEntrar` confere
`tempo().acabou`. O anfitrião era julgado pelo **estado**, que só vira
`encerrada` quando a faxina roda — até 20 segundos depois.

Nessa janela havia duas verdades sobre a mesma sala. Quem criou a reunião
reabria uma cujo prazo tinha vencido, enquanto os convidados batiam na porta
recebendo "o tempo desta reunião terminou". **O prazo é do relógio; a faxina
apenas o registra.**

Encerrada a reunião, ela não volta por porta nenhuma — nem reabrindo a sala,
nem entrando direto na chamada, nem pelo link. São 12 casos novos, e eles
viajam no tempo mexendo em `encerra_em` para provar em segundos o que levaria
meia hora.

### Reabrir uma sala VIVA deixou de quebrá-la em silêncio

`UPDATE … WHERE estado = 'aberta'` recusava, sem dizer nada, a reabertura de
uma sala já ativa: a aplicação criava uma chamada nova e a sala continuava
apontando para a **morta**. O anfitrião entrava numa reunião que a sala não
conhecia, e todo convidado que chegasse pelo link ia parar na chamada velha —
vendo "aguarde o anfitrião" para sempre, com o anfitrião a postos do outro lado.

Os dois `COALESCE` continuam garantindo o que importa: **reabrir não adia a
hora de acabar**. É o que faz "dura 30 minutos" ser afirmação sobre o tempo, e
não sobre o número de aberturas.

### A3 · Os anexos passaram a ser cifrados em disco

O banco era cifrado e o arquivo não — uma assimetria que ninguém espera: quem
levasse um backup lia o exame, o contrato e a foto, e não lia as conversas.

Formato novo, binário: `LAC1` + versão + IV + dados + tag, 33 bytes de
sobrecarga. **O selo no começo é o que torna isto seguro para quem já tem
anexos no disco** — arquivo sem selo é conteúdo antigo e sai como está. Sem
essa marca, ligar a cifra tornaria ilegível todo anexo já enviado, e o backup
não ajudaria, porque o backup também está em claro.

O download continua por fluxo. A tag do GCM mora no fim do arquivo, então a
leitura busca os 16 bytes finais **antes** de começar a entregar: bytes não
autenticados no navegador seriam abrir mão justamente do que o GCM oferece.
Arquivo adulterado no disco interrompe o download em vez de ser entregue.

`tamanho` e `hash` continuam sendo os do conteúdo em claro — trocá-los faria o
`Content-Length` mentir e a conferência de integridade acusar corrupção em
todo anexo.

### A2 · Reunião por link vai pelo relay

Na malha direta, quem recebe um convite descobre de onde o funcionário está
falando — casa, escritório, celular — e vice-versa. **É a única coisa que um
estranho leva embora sem pedir.**

`CHAT_VIDEO_SO_RELAY` continua valendo para tudo, mas a decisão passou a ser
também por chamada: toda reunião nascida de um link usa `iceTransportPolicy:
relay`. E a decisão é tomada na **abertura**, não quando o primeiro convidado
chega — se só um lado estivesse em relay, o outro continuaria anunciando os
próprios candidatos e o endereço vazaria assim mesmo.

Sem TURN configurado, **não** se pede relay: seria chamada impossível, não
chamada privada — o navegador descarta todo candidato que não seja de relay e
não sobra nenhum. Falharia em silêncio, com cara de problema de rede.

### Na tela

Uma sala encerrada ou revogada oferecia **"Abrir sala"** e **"Revogar"**. Os
botões levavam a uma recusa do servidor, que é o pior tipo de botão: o que
promete e o sistema desmente. Agora são três estados, não dois — e numa sala
morta não sobra ação nenhuma, nem copiar: link encerrado copiado é link
encerrado **enviado**.

### Números

597 testes (eram 565). A suíte de unidade passou a ser assíncrona — continua
sem subir servidor nenhum; assíncrono ali é leitura de disco.

---

## 0.11.0 — 23/08/2026 · a reunião em janela própria

A gaveta do chat tem 380 px. Para conduzir uma reunião — ver rosto, notar
quem quer falar — isso é pouco. Agora o topo da reunião tem dois botões:

* **⧉ Abrir em outra janela** — a reunião vai para uma janela flutuante,
  redimensionável, que se arrasta para o segundo monitor e fica acima das
  outras. Volta com um clique, ou fechando a janela.
* **⛶ Tela cheia** — funciona em qualquer navegador, inclusive no celular.

### Por que NÃO foi `window.open`

O caminho óbvio seria abrir uma página nova com a reunião dentro. Ele está
errado por um motivo que não aparece até a terceira pessoa entrar: **na malha
WebRTC cada participante é identificado pelo ID do usuário**. A mesma pessoa
em duas janelas vira dois pares com o mesmo id, e os outros passam a receber
duas ofertas da mesma pessoa e a negociar com um par que é o próprio.

Contornar exigiria desmontar a chamada aqui e remontar lá — uma entrega com
buraco: se o bloqueador de pop-up recusasse a janela **depois** de já termos
saído, o anfitrião perderia a reunião que estava conduzindo.

### O que foi feito

`documentPictureInPicture` dá uma janela de verdade **e** permite mudar os
nós do DOM de lugar. O painel da reunião muda de janela levando consigo os
mesmos `<video>`, as mesmas `RTCPeerConnection` e o mesmo socket. Nada é
remontado, nada é renegociado, ninguém entra duas vezes.

Verificado no navegador: um `<video>` tocando uma `MediaStream` atravessa a
mudança de documento mantendo **o mesmo objeto de stream**, a trilha `live` e
o tempo correndo.

Na janela nova o painel entra num Shadow Root próprio. Isso resolve de graça o
que custaria uma tarde: as regras são escritas com `:host` e classes curtas
(`.grade`, `.quadro`), e fora de um shadow root não casariam nada — ou
casariam demais. Dentro de um shadow root novo, `:host` passa a ser o palco e
o CSS vale sem uma linha reescrita.

### As garantias

* **Nada é desfeito antes de a janela existir.** Recusa do navegador deixa a
  reunião inteira onde estava. Há teste da ordem, e ele acusa se alguém
  inverter.
* **Um caminho de volta só.** Fechar pelo X e clicar em "voltar" terminam na
  mesma função — não podem divergir com o tempo.
* **A aba de origem não fica vazia.** No lugar da reunião aparece "A reunião
  está em outra janela", com o botão de trazer de volta. Sem isso, quem
  perdesse a janela de vista acharia que a reunião caiu.
* **Acabar a reunião fecha a janela.** Não sobra janela flutuante com reunião
  morta dentro.
* **Fora do Chrome e do Edge o botão não aparece** — em vez de aparecer e
  fazer outra coisa. Tela cheia continua para todos.

### Também

Os dois invólucros de `desmontarChamada` viraram um. Espalhados por seções
diferentes do arquivo, faziam quem lesse o primeiro concluir que já tinha
visto tudo que acontece ao encerrar — e foi o próprio teste que tropeçou
nisso primeiro.

---

## 0.10.0 — 23/08/2026 · reunião por link, para quem não tem conta

O anfitrião cria um link, define quanto tempo a reunião dura e manda para
quem quiser. Quem recebe digita um nome e entra — **sem conta, sem senha,
sem cadastro**. O link é `/call/<11 caracteres>`.

### O que existe

* **Aba "Reuniões"** no chat: criar link, copiar, abrir a sala, ver quem
  entrou, remover alguém e revogar o link. Só aparece com `CHAT_VIDEO=1`.
* **Página do convidado** em `/call/<codigo>`: prévia da câmera, campo de
  nome, sala de espera enquanto o anfitrião não abre, e tela de encerramento
  que diz **por que** acabou (saiu, removido, revogado, tempo esgotado).
* **Tempo com hora marcada**: aviso nos últimos 5 minutos e encerramento pelo
  **servidor** — relógio de navegador não estende reunião.
* **Duração** de 5 minutos a 8 horas; o link vale 24 h por padrão.

### As decisões que importam

**O convidado tem sessão PRÓPRIA** (`seguranca/convidado.js`), cookie `cvd`,
separada da sessão de funcionário. E o roteador tem um **portão de lista
branca**: uma rota nova nasce PROIBIDA para convidado. A pergunta que o
sistema faz deixou de ser "há sessão?" e passou a ser "quem é, e para onde
essa identidade vale?".

**O código do link não é guardado em claro.** No banco fica o SHA-256 (para
achar) e uma cópia cifrada (para o anfitrião reler). Quem lê o banco não
descobre link nenhum.

**Inexistente, revogado e expirado dizem a MESMA frase.** Distinguir
confirmaria ao curioso que ele acertou um código — é assim que tentativa e
erro vira mapa. Com 58^11 (~2^64) combinações e freio de 20 tentativas por
minuto por IP, adivinhar é inviável.

**O convidado não existe para a empresa.** Não aparece no diretório, nem na
busca, não pode ser posto em grupo, não alcança conversas, mensagens, perfil
nem administração. São 83 testes, e mais da metade prova exatamente isso.

**A página do convidado não interpola nada.** O servidor entrega um HTML
constante; o código da sala vem do endereço. XSS ali é impossível por
construção, e a CSP daquela página não tem `unsafe-inline` para script.

**Revogar e remover matam o cookie na hora**, não na próxima recarga — e
derrubam o socket junto.

### Corrigido no caminho

* **O link ignorava o prefixo do chat.** Em qualquer instalação com o chat sob
  `/chat`, o convite apontava para um endereço que ninguém serve. O teste
  aprovava porque conferia só o fim do link; agora ele **abre** o link.
  `/call/<codigo>` curto passou a redirecionar para dentro do prefixo, no
  servidor e no conector.
* **O convidado aparecia na busca de pessoas.** O filtro tinha sido aplicado
  em duas das três consultas.
* **"Origem não autorizada" na própria página.** A página do convidado é
  servida por este serviço, e a defesa contra CSWSH — escrita para barrar site
  de terceiros — barrava a nossa própria página. A origem do próprio chat
  entrou na lista, e há teste dos dois lados.
* **O chat ficava SEM VÍDEO, em silêncio.** `CSS_SALA` foi declarado depois da
  varredura que chama `prepararVideo()` durante a avaliação do módulo:
  ReferenceError de zona morta temporal, dentro de um `catch { }` vazio. Tela
  perfeita, console limpo, suíte verde. O `catch` vazio virou `console.error`.
* **O anfitrião não via o próprio relógio.** Título da sala e contagem
  regressiva estavam presos ao modo do convidado; quem marcou a hora via
  "Chamada" e um relógio contando para cima.
* **Aba selecionada por texto do botão.** Funcionava com duas abas e por
  acaso; com a terceira, virou `data-aba`.

---

## 0.9.1 — 16/08/2026 · três defeitos da reunião, achados usando

### O áudio morria junto com a câmera

Desligar o vídeo derrubava o som da pessoa. A causa não estava no áudio em
lugar nenhum — `alternarCamera` só mexe nas trilhas de vídeo. Era a **pintura
da tela**: o elemento `<video>` só era criado quando havia imagem, e é ele que
toca o áudio do outro lado. Câmera desligada, elemento fora do DOM, voz sumida.

Agora o `<video>` fica **sempre**, e o retrato de quem está sem câmera é uma
camada por cima. Vale também para a tira do modo destaque: quem está lá
continua no DOM, e continua sendo ouvido.

### O JSON aparecendo na barra lateral

A prévia da conversa mostrava o corpo cru da mensagem de sistema:

```
{"ev":"chamada","id":"01M0JY1…
```

O corpo é JSON de propósito — a frase depende de quem lê ("ninguém atendeu" x
"chamada perdida"), e montá-la no servidor a congelaria no banco, cifrada, para
sempre. O que faltava era o outro lado do contrato: o servidor agora manda o
evento **estruturado** (`previa.evento`) e devolve texto vazio, e a tela monta a
frase sabendo quem está lendo.

`textoDaPrevia` virou ponto de extensão no cliente. Sem alguém que saiba
traduzir aquele evento, a linha fica **em branco** — nunca com o JSON.

### O vídeo pequeno, e sem como ampliar

A grade usava `align-content: center` com linhas do tamanho do conteúdo: numa
reunião de duas pessoas sobravam faixas escuras em cima e embaixo e o rosto
ficava do tamanho de um selo. Agora as linhas dividem a altura disponível
(`grid-auto-rows: 1fr`) — o mesmo vídeo passou de um quadrado pequeno para
364×628 numa janela de 720px.

E **clicar num vídeo o amplia**; clicar de novo volta. O escolhido ocupa a área
toda e os demais viram uma tira de 84px embaixo. Acessível por teclado
(`role="button"`, Enter e Espaço), com `aria-pressed` dizendo o estado.

Em tela alta e estreita, duas pessoas passam a ficar empilhadas em vez de lado
a lado — dois retratos espremidos numa tela de celular não ajudam ninguém.

---

## 0.9.0 — 16/08/2026 · reunião por vídeo

Chamada de vídeo e reunião de equipe, dentro da conversa. **Desligada por
padrão** (`CHAT_VIDEO=1` liga).

### A decisão: malha P2P, e não SFU

Cada participante abre uma conexão WebRTC com cada outro. **A mídia nunca passa
pelo servidor** — ele é a telefonista que repassa envelopes fechados.

Duas consequências, e as duas foram escolhidas:

- **o vídeo é ponta a ponta de verdade.** DTLS-SRTP é obrigatório no WebRTC;
  não há modo inseguro e o servidor não decifraria nem querendo. Para uma
  clínica, isso é argumento, não detalhe;
- **teto de 6 pessoas.** Em malha, cada um SOBE (N−1) fluxos: seis pessoas são
  ~7,5 Mbps de subida por cabeça, o que já dói em 4G. O teto recusa **na porta**
  em vez de deixar a sétima pessoa derrubar o áudio de todos.

A alternativa — SFU (mediasoup, LiveKit) — escala para 50, e custa compilação
nativa no servidor, ~150 Mbps de repasse por reunião de 10, e a mídia passando
a existir na sua máquina. Foi descartada **para o tamanho real destas equipes**,
com o caminho de volta preparado: trocar a topologia não toca em domínio, banco
nem autorização. Ver [docs/VIDEO.md](docs/VIDEO.md).

### O que entrou

- **Chamada direta e reunião de grupo**, iniciadas de dentro da conversa.
- **Toque, atender, recusar** — com som gerado (sem arquivo) e aviso visual que
  funciona mesmo quando o navegador bloqueia o áudio.
- **Câmera, microfone e compartilhamento de tela**, com o estado de cada pessoa
  gravado: quem entra no meio já vê quem está mudo.
- **Indicador de quem está falando**, por analisador de áudio — sem ele, uma
  reunião de seis é seis retratos parados e ninguém sabe de quem é a voz.
- **A reunião vira uma linha no histórico** da conversa, com duração; chamada
  não atendida aparece como perdida, com "Ligar de volta".
- **Quem chega depois vê "Reunião em andamento · Entrar"** ao abrir a conversa.
- **Entrar de novo é idempotente** — recarregar a aba não duplica ninguém.

### Segurança

- **A autorização não é nova.** Quem entra numa chamada é quem é membro da
  conversa — a mesma `exigirMembro` que já protege mensagens e anexos, já
  dentro do SQL e já com suíte em cima. Sem sala com link, sem convite externo,
  sem sala de espera: cada um seria um lugar novo para errar.
- **O `de` de cada sinal é carimbado pelo servidor**, a partir da sessão do
  socket. O campo que vem do cliente é descartado — senão qualquer participante
  injetaria uma oferta de mídia em nome de outro. Testado.
- **Sinal validado por forma**: tipo de lista fechada e teto de tamanho, antes
  de qualquer repasse.
- **Credenciais de TURN de vida curta** (HMAC do padrão `use-auth-secret`, 2 h).
  Usuário e senha fixos vazam pelo DevTools de qualquer funcionário e
  transformam o seu servidor em relay de graça para estranhos.
- **Exposição de IP documentada**, com `CHAT_VIDEO_SO_RELAY=1` para quem
  precisar escondê-la.
- **Sem gravação, sem transcrição.** Exigiriam consentimento, retenção e
  política de acesso — e, em malha, um servidor recebendo a mídia só para
  gravar, que é metade de um SFU.

### O código do vídeo só chega ao navegador quando o vídeo está ligado

`la-chat-video.js` é um arquivo separado que o servidor **concatena na entrega**
— e só concatena com `CHAT_VIDEO=1`. Numa instalação sem reunião, nada de WebRTC
é baixado ou avaliado: o recurso não existe, em vez de existir escondido atrás
de um `if`. O ETag cobre as duas partes, senão uma correção no vídeo não
invalidaria o cache.

Isso também cumpre o que a arquitetura já prometia (§36): componentes em
arquivos separados, concatenados na entrega, sem passo de build.

### Defeitos encontrados durante a construção

- **O teto do sinal era igual ao teto do quadro WebSocket** (64 KB). Um sinal
  grande demais estourava o `maxPayload` do `ws`, que **fecha a conexão**: em
  vez de uma recusa educada, a pessoa perdia o socket inteiro e caía do chat.
  Baixado para 32 KB. *Uma trava não pode ser mais destrutiva que o abuso que
  ela impede.*
- **A migração 002 nunca aplicou o índice do PostgreSQL.** A chave do bloco
  específico era `postgres`, e o `migrar.js` procura `pg`. No PostgreSQL, a
  trava contra pessoa duplicada simplesmente não existia — em silêncio.
  Corrigida.
- **A suíte herdava o `.env` da máquina.** Com `CHAT_VIDEO=1` no `.env` de
  desenvolvimento, o teste "com o vídeo DESLIGADO" subia um servidor com vídeo
  ligado e acusava o código. Uma suíte que mede o ambiente não é uma suíte:
  agora `subirChat` fixa explicitamente o que precisa controlar.

### Testes

**469** (eram 400). A suíte nova, `testes/video.cjs`, tem **65** casos e é onde
a segurança do vídeo mora — a mídia não passa pelo servidor, então o que dá
para atacar é a sinalização: falsificação de origem do sinal, injeção em
reunião alheia, sinal fora de forma, entrada sem convite, teto da malha,
chamada fantasma e queda de socket.

---

## 0.8.2 — 19/08/2026 · cada login apagava o retrato que o elenco acabara de pôr

O Kenósis ganhou foto no cadastro de usuário do sistema, o elenco sincronizou
o avatar… e ele sumia no login seguinte. Causa: o `/entrar` regrava o cadastro
com os dados do PASSE — e o passe vem da sessão do hospedeiro, que não carrega
foto. `avatar: ""` a cada login, por cima do que o elenco tinha gravado. No
BemEstar o defeito sempre existiu e ficou invisível: o reenvio periódico repõe
a foto em até 5 minutos.

Contrato novo no `garantir`: **avatar `undefined` mantém o que está; string
(mesmo vazia) vale**. O elenco continua sendo a verdade inteira — vazio ali
limpa de fato —, e o `/entrar` passa a tratar passe sem foto como "não sei",
apagando o campo antes de gravar. No SQL, `avatar = COALESCE(?, avatar)` com
`null` quando é para manter.

## 0.8.1 — 19/08/2026 · a unit lia o env duas vezes — e a segunda como o usuário errado

No systemd, quem lê o `EnvironmentFile=` é o PRÓPRIO systemd, como root; o
processo já nasce com o ambiente completo. Mas o `ExecStart` passa o mesmo
caminho ao `instancia.js`, que EXIGIA lê-lo de novo — agora como o usuário do
serviço, contra um arquivo `600 root:root`. Resultado: `EACCES` com o
ambiente inteiro já na mão.

Agora o lançador tenta ler o arquivo e, se não conseguir, confere se as
chaves obrigatórias JÁ ESTÃO no ambiente: estando, segue (o arquivo era só o
mensageiro); faltando, para com recado dizendo os dois caminhos. A conferência
de instância completa continua exatamente igual — o que mudou é de quem ela
aceita a resposta.

## 0.8.0 — 19/08/2026 · uma instância por cliente, do mesmo código

O Instituto Kenósis pediu chat com **conexão própria** — e a razão de fundo é
boa: o `contexto` já separa as conversas dentro de um serviço, mas o SEGREDO
do passe, o banco e a chave de cifragem eram um só. Quem comprometesse o
ambiente de um site conseguiria forjar passe para o contexto do outro.

**`instancia.js`**: `node instancia.js .env.kenosis` sobe o chat com o
ambiente daquele arquivo — porta, banco, anexos, os três segredos e as
origens próprios. O lançador **exige** as chaves que distinguem uma instância
da outra (PORT, CHAT_SQLITE, CHAT_ARQUIVOS, segredos, origens): chave
esquecida herdaria em silêncio o valor do `.env` padrão, e duas instâncias
dividindo o mesmo banco é exatamente o acidente que ele existe para impedir.

Em produção o lançador nem é usado: uma unit por instância com
`EnvironmentFile=/etc/lachat-<cliente>.env` faz o mesmo. O `.env.kenosis`
fica fora do git pelo padrão `.env.*` que já existia.

## 0.7.0 — 17/08/2026 · a pessoa deixou de ser a conta dela

O cliente do BemEstarClinic removeu o usuário de um profissional, reativou a
pessoa e criou uma conta NOVA para ela. O `profissional_id` era o mesmo; o id
da conta, não. A barra lateral passou a mostrar **duas conversas com o mesmo
nome** — uma com o histórico e outra vazia. Nenhum erro em lugar nenhum.

### `identidade`: uma coluna nova, e não o `externo_id` reescrito

O hospedeiro passa a poder mandar, além do id da conta, quem a pessoa **é** por
algo que sobrevive à troca de conta. No BemEstar isso é `prof-<profissional_id>`.
A busca prefere a identidade e cai no `externo_id`.

A primeira tentativa foi migrar o próprio `externo_id` para a identidade — e ela
funciona, criando uma armadilha de mão única: no dia em que o hospedeiro
parasse de mandar o campo (rollback, conector velho), ninguém casaria, a equipe
inteira nasceria duplicada e todo mundo que já estava seria desativado de
quebra. A suíte pegou na hora — as sessões abertas responderam 401. Com as
duas chaves lado a lado, voltar atrás continua encontrando as mesmas pessoas.

O campo é **opcional**: quem não manda segue funcionando exatamente como antes,
e existe teste provando isso — o elenco vai e volta sem o campo, e ninguém é
desativado nem duplicado.

### O PASSE também carrega a identidade

Entrar cria pessoa, exatamente como o elenco cria. Se só o elenco soubesse quem
a pessoa é, um login por uma conta que não fosse a última sincronizada abriria a
segunda ficha — o mesmo defeito entrando pela outra porta. A identidade viaja
dentro do corpo **assinado** do passe: fora da assinatura, ela seria um campo
pelo qual alguém escolhe de quem quer ser a conversa.

### `desativarAusentes` conta as DUAS chaves

O hospedeiro manda a lista com o id da conta; quem já tem identidade tem a
coluna própria preenchida. Olhar só uma das colunas desativa gente que está na
lista — e desativar é o que tira a pessoa de todas as telas e derruba a sessão
dela.

### `ferramentas/fundir-pessoas.cjs` — para o estrago que já existe

A identidade **previne** casos novos; ela não junta o que já se partiu. Fundir
move histórico de conversa entre pessoas e não tem volta, então a ferramenta é
de linha de comando e tem três cercas: sem argumento ela só **relata** os
candidatos, com dois ids ela **simula e para**, e só escreve com `--aplicar`
mais o nome de quem sai digitado por extenso.

Ela emenda as conversas diretas (renumerando `seq` pela hora, que é a única
linha do tempo comum aos dois lados), acerta o índice cego da busca, resolve os
grupos onde as duas fichas estavam dentro, e prefixa o `externo_id` da ficha
dissolvida — sem isso, a conta antiga voltando do hospedeiro ressuscitaria a
ficha vazia e desfaria a fusão na sincronização seguinte.

Um detalhe que só o teste mostrou: `id_cliente` é único por
(conversa, autor, id_cliente) e vem do **navegador** — as duas conversas sendo
juntadas têm um `c1` cada, do mesmo autor. Mover sem reescrevê-lo estoura o
índice no meio da fusão.

### Suíte nova: `testes/fusao.cjs` (25 verificações)

Banco de brinquedo próprio, criado e apagado ali. Com as quatro verificações
novas na integração, o total vai a **404 verificações**.

---

## 0.6.0 — 17/08/2026 · o aviso sonoro passou a ser um arquivo

Pedido do cliente do BemEstarClinic: o toque tinha de ser **o dele**, e **alto**.
A recepção da clínica é barulhenta e o bipe de dois tons passava despercebido.

### O arquivo entra, e o bipe gerado FICA como reserva

Até aqui o som era sintetizado no WebAudio, e o comentário no código defendia a
escolha: um `.mp3` seria mais um recurso para carregar e mais um caminho para o
CSP do hospedeiro bloquear. O argumento continua válido — por isso o oscilador
não foi removido, virou o caminho de volta.

Ele cobre três casos em que o arquivo não chega: CSP com `media-src` fechado (o
`/restrito` do BemEstar tem CSP), rede caída entre a página carregar e a
mensagem chegar, e serviço atualizado sem o `aviso.mp3` na pasta. Em nenhum
deles o aviso pode emudecer sem ninguém saber — um som ruim avisa, silêncio não.

### O toque é servido pelo próprio chat

`GET <prefixo>/aviso.mp3`, ao lado do cliente, e pelo mesmo motivo: trocar o som
chega a todas as instalações sem ninguém recopiar arquivo. Aqui o cache é
**longo** (`max-age` de 7 dias), ao contrário do `la-chat.js`, que usa
`no-cache` + ETag: o cliente precisa de correção imediata, o som não muda.

O arquivo é buscado **uma vez**, na liberação do áudio — que já acontece na
primeira interação com a página —, e fica decodificado na memória. A mensagem
que chega não espera download nenhum para soar.

### Volume

`gain` de 2.2 no arquivo, e não 1.0. O toque do cliente tem pico em 0,43 da
escala; com ganho unitário ele sairia em menos da metade do que o alto-falante
consegue. 2,2 aproxima o pico do teto (0,43 × 2,2 = 0,94) sem ceifar a onda —
acima disso o som chia, e mais volume que o material permite não existe. O bipe
de reserva subiu junto, de 0,06 para 0,35.

### O que o cliente mandou tinha 11 segundos

Eram **quatro repetições** do mesmo toque (a envolvente medida no navegador
mostra o padrão reiniciando a cada 2,30s). Um aviso de 11 segundos tocando a
cada mensagem faz a pessoa desligar o som no segundo dia — o oposto do pedido.
Ficou **um ciclo**, cortado em fronteira de frame MP3: sem recodificar, sem
perder um decibel, 73 KB.

---

## 0.5.1 — 16/08/2026 · três defeitos do próprio diagnóstico

A primeira verificação real no servidor devolveu cinco erros. **Três eram do
`verificar.sh`, não da instalação** — e um relatório que acusa o lugar errado é
pior que relatório nenhum, porque manda mexer no que estava certo.

### A URL pública substituía a checagem local

`./verificar.sh bemestar https://site.com` trocava o alvo: quando o externo
falhava, a seção 1 dizia "o chat não respondeu" — e o serviço estava de pé.
Agora são dois alvos que não se substituem: **local** responde "o serviço está
de pé?", **fora** responde "o nginx e o conector estão no caminho?".

### O caminho público não é `/chat`

Com o conector, o chat mora dentro do site — no BemEstarClinic, em
`/restrito/chat`. Conferir `https://site/chat/saude` devolve 404 e acusa um
problema que não existe. Agora o caminho do site é assumido por padrão, e pode
ser dito por inteiro na chamada. O 404 e o 502 ganharam mensagens que dizem o
que conferir em cada caso.

### Crase dentro de aspas duplas

`verde "o \`map\` de Upgrade está carregado"` — em shell, crase dentro de aspas
duplas é **execução de comando**. O relatório saiu com
`map: command not found` e a palavra sumiu da frase. As duas ocorrências eram as
únicas do arquivo; nas mensagens, marcação de texto e shell não se misturam.

### E um falso positivo no próprio serviço

O aviso de `CHAT_PROXIES` disparava no primeiro boot de todo servidor **bem
configurado**: a sincronização de elenco chega do próprio site, servidor a
servidor, em 127.0.0.1 e sem `X-Forwarded-For`. Ela é loopback porque É loopback
— não porque a configuração esteja errada.

Um alarme que dispara sozinho é um alarme que se aprende a ignorar, e aí o dia
em que ele estiver certo não vai adiantar. A pergunta correta é: **veio uma
cadeia de proxies e, mesmo assim, o IP saiu loopback?** Só isso é ter pulado
saltos demais.

---

## 0.5.0 — 16/08/2026 · uma instância por projeto

Decisão do dono, e ela está certa.

O chat sabe separar clientes por `contexto`, e há teste de segurança para isso
— inclusive no fan-out do tempo real, que é onde o isolamento costuma vazar.
Mas esse isolamento é **lógico**: um campo conferido em cada consulta. O que
trafega aqui é conversa de equipe de clínica, que fala de paciente. Para esse
conteúdo, "estão no mesmo arquivo, separadas por software" é uma frase que
ninguém quer ter de dizer ao cliente.

Agora cada projeto tem **processo, banco e chaves próprios**. O vazamento entre
clientes deixa de depender de o código estar certo.

### O que NÃO se multiplica é o código

Uma cópia do chat por cliente nos devolveria o problema que o módulo existe
para evitar: N lugares para corrigir o mesmo defeito. Então o código continua um
só, em `/var/www/projetos/LA-Chat`, e as instâncias são **unidades de molde do
systemd** (`lachat@bemestar`, `lachat@bordatudo`) apontando para ele com
ambientes diferentes. Um `git pull` e N restarts atualizam todo mundo.

Cada instância tem `/etc/lachat-<nome>.env` (porta, origens e as três chaves) e
`/var/lib/lachat/<nome>/` (banco e anexos) — **fora da árvore do código**, para
que a atualização não tenha como encostar neles.

### A porta é a do site + 1000

    BemEstarClinic  5185  →  chat 6185
    Borda Tudo      5193  →  chat 6193

Olhando o número, se sabe de quem é a instância. Numeração sequencial
(5197, 5198, 5199…) obriga a consultar uma tabela que sempre desatualiza.

### As instâncias são DESCOBERTAS, nunca listadas

Tanto o `deploy.sh --atualizar-todas` quanto a entrega automática varrem
`/etc/lachat-*.env`. Uma lista dentro do script desatualizaria — e a instância
esquecida seria justamente a que ficaria sem a correção, em silêncio, até um
cliente reclamar.

Na entrega, uma instância que falha **não impede as outras**: o cliente B não
fica sem correção porque o A tem problema. Mas a entrega termina vermelha.

- `nginx/lachat.service` (instância única) saiu; entrou `nginx/lachat@.service`.
  Nunca chegou a produção, então não há migração a fazer.
- O sudoers usa `lachat@*.service`. É seguro pelo motivo certo: o glob do
  sudoers não casa com `/`, então não há como escapar para outra unit.

### O deploy agora é ensaiado, e dois defeitos saíram disso

`ci/ensaiar.sh` roda o `deploy.sh` inteiro num diretório temporário, com dublês
de `systemctl`, `nginx`, `sudo` e `curl`. Ele instala duas instâncias, confere
o arquivo de ambiente, o banco criado pela migração, a descoberta em
`--atualizar-todas` e — o mais importante — que **reinstalar não regenera a
chave**, que é o pior estrago possível. Roda no portão do CI.

Existe porque a primeira versão do `deploy.sh` foi entregue sem nunca ter
rodado do começo ao fim, e o erro apareceu no servidor do cliente. Dois
defeitos que o ensaio pegou de imediato:

- **o código passava a ser do `root`.** A intenção era o serviço não conseguir
  reescrever o próprio código; o efeito seria a SEGUNDA entrega morrer, porque
  quem atualiza é o `deploy`, com `git pull` e `npm ci`, e num diretório do
  root os dois falham. A separação certa não é por dono: é o
  `ProtectSystem=strict` da unit, com só o diretório de dados em
  `ReadWritePaths`;
- **`verificar.sh` conferia "o chat"**, no singular, apontando para
  `/etc/lachat.env` e a porta 5197. Com uma instância por projeto isso não quer
  dizer nada — passou a receber o nome da instância, e sem argumento lista as
  instaladas.

---

## 0.4.1 — 16/08/2026 · entrega automática, e o conector que se atualiza sozinho

O chat passou a ter repositório e pipeline, no mesmo molde dos sites do parque:
portão de testes → entrega por SSH com chave presa a `command=`.

O que é novo em relação aos sites é o terceiro trabalho: **propagar o conector**.

O chat é um serviço; o conector é um arquivo COPIADO para dentro de cada site.
Atualizar o serviço não atualiza as cópias — foi assim que a 1.1 corrigiu o
repasse com prefixo e o BemEstar continuou com a 1.0 até alguém reparar.

A saída óbvia seria o servidor rodar `instalar-em.js --todos` depois de cada
entrega. **Ela quebra o deploy dos sites**: cada um é um repositório git com o
`lachat.js` commitado — e tem de estar, senão um clone novo não sobe, porque o
`require("./lachat")` acontece no boot. Sobrescrever o arquivo no servidor deixa
a árvore suja, e o `git pull` da entrega seguinte para com "local changes would
be overwritten".

Então o caminho é outro: quando `conector/lachat.js` muda, o workflow **commita
o arquivo novo no repositório de cada site** listado em `ci/hospedeiros.txt`.
Isso dispara o portão daquele site — que é quem sabe se o conector novo quebrou
algo lá — e a entrega dele leva o conector junto. De quebra, fica um commit com
data e diff em cada site: "quando o conector daquele cliente mudou?" passa a ter
resposta.

Duas guardas no portão, das que só se descobre errando:

- **o conector não muda sem subir a versão.** É a versão que faz
  `instalar-em.js --conferir` saber quem está atrasado; mudar o arquivo sem
  mexer nela deixa a conferência cega;
- **nenhum `.sh` com CRLF.** Fim de linha do Windows é invisível no editor e faz
  o shell do servidor reclamar de um comando que existe.

Arquivos novos: `.github/workflows/deploy.yml`, `ci/entregar.sh` (o único
comando que a chave alcança), `ci/sudoers-lachat` e `ci/hospedeiros.txt`.

### O `.gitignore` que engoliu a camada de dados

O primeiro push subiu o projeto **sem `src/infra/dados/`** — migrações, adaptador
de banco e todos os repositórios. O servidor parou no clone com
`Cannot find module .../src/infra/dados/migrar.js`.

A causa é uma regra do git que quase todo mundo aprende assim: **`dados/` sem
barra no começo casa com qualquer pasta chamada `dados`, em qualquer
profundidade**. A intenção era excluir a pasta de execução da raiz; o efeito foi
excluir também a camada de dados do código.

O que torna isso perigoso não é o erro em si — é que ele **não aparece de onde
se trabalha**. Localmente está tudo lá, os testes passam, o `npm test` fica
verde. Só quem clona descobre, e "quem clona" é o servidor, no meio de uma
entrega.

Agora: `/dados/*` (ancorado na raiz, e o `*` porque o git não entra em pasta
excluída — sem ele a exceção do `.gitkeep` nunca valeria e a pasta sumiria do
clone). Os `.gitignore` dos sites do parque foram auditados pelo mesmo erro.

---

## 0.4.0 — 16/08/2026 · avisar quem não está olhando

Quatro pedidos que pareciam quatro ajustes de interface e eram, no fundo, um só
defeito de arquitetura.

### O chat ficava DESLIGADO enquanto estava fechado

O componente conectava ao ser aberto e desconectava ao ser fechado. Economizava
um WebSocket e custava a função inteira de notificação: com a gaveta fechada não
chegava mensagem nenhuma, então **selo, título e som não tinham como existir** —
não estavam quebrados, estavam impossíveis.

Agora conecta ao carregar a página e permanece conectado; fechar apenas esconde
a tela. Um socket por aba aberta do sistema é o custo normal de um chat. O
atributo `manual` preserva o comportamento antigo para quem quiser controlar.

### O selo no botão flutuante

Já existia no atalho de instalação e nunca aparecia, pela razão acima. Agora
mostra a contagem, some ao ler, e o `aria-label` do botão diz o número — quem
usa leitor de tela ouve "Abrir chat — 3 não lida(s)".

### A contagem no título da aba

`(3) Gestão — BemEstarClinic`. Vale mais que o selo: a pessoa está com outra
aba na frente e a barra de abas é o único lugar que ela olha o tempo todo.

Dois detalhes que só aparecem em sistema de verdade: o título original é lido a
cada mudança (o site troca de tela sem recarregar e reescreve o `document.title`,
então guardar o título de partida congelaria o de uma tela antiga), e um
`MutationObserver` repõe a contagem quando o site reescreve o título — sem ele o
aviso sumia ao navegar e só voltava na mensagem seguinte.

### O som, para quem nunca abriu o chat

O áudio era liberado no primeiro clique **dentro do chat**. O efeito era
perverso: quem nunca abriu a gaveta nunca liberava o som, e é exatamente essa
pessoa que depende dele. Agora a primeira interação em qualquer lugar da página
serve.

### A lista de Pessoas, viva

Era carregada uma vez (`if (!pessoas.length)`) e nunca mais: quem abrisse a aba
ficava com aquele retrato até dar F5 — funcionário admitido depois não aparecia,
demitido continuava lá. Agora atualiza por três caminhos, de propósito
sobrepostos: ao entrar na aba, pelo evento `elenco` do socket quando o
hospedeiro sincroniza, e por relógio de 30 s enquanto a aba estiver aberta e
visível (rede de segurança para o evento perdido numa reconexão).

E a sincronização de elenco passou a **desativar quem saiu** do cadastro do
hospedeiro — antes ela só sabia acrescentar, e a lista ia divergindo do sistema
um pouco a cada mês, sem nunca dar erro. Desativa em vez de apagar, para o
histórico das conversas continuar com autor; quem volta a ser cadastrado volta a
aparecer. A resposta agora traz `desativados` e `mudou`, e é `mudou` que permite
ao hospedeiro reenviar o elenco de 5 em 5 minutos sem encher o log.

### Dois defeitos achados no caminho, os dois em silêncio

**Segunda mensagem de um cliente que não manda `idCliente` → 500.** O índice de
deduplicação é `UNIQUE (conversa, autor, id_cliente)` e a coluna tem
`DEFAULT ''`: sem chave, a segunda mensagem daquela pessoa naquela conversa
batia no índice. Ficou invisível desde o começo porque o nosso componente sempre
manda o ULID dele — apareceu no primeiro cliente que não é ele. Agora o servidor
gera a chave quando o cliente não manda (sem chave do cliente não existe reenvio
a deduplicar; cada POST é uma mensagem nova). Vale para qualquer integração pela
API.

**`ELENCO_SINCRONIZADO` não estava na lista de eventos de auditoria.** O
registro era descartado com um aviso no console desde a 1.2 do conector — ou
seja, a auditoria não sabia responder "quando alguém entrou ou saiu da equipe?",
que é justamente o que ela existe para responder.

- conector `1.3` → `1.4`
- testes: 356 → **368** (integração 83 → 95, com o elenco entrando, saindo e
  voltando, e a mensagem sem `idCliente`)

---

## 0.3.1 — 16/08/2026 · montar o chat fora de `/chat`

A primeira instalação real em outro caminho — o BemEstarClinic precisou de
`/restrito/chat`, porque o cookie da gestão tem `Path=/restrito` e o chat na
raiz não recebia autenticação nenhuma. Instalado ali, ele **carregava, dizia
"Conversas", e a aba "Pessoas" mostrava "Ninguém por aqui ainda."** — que é
exatamente o que um sistema recém-instalado mostraria estando tudo certo.

Eram dois defeitos empilhados, os dois em silêncio:

### O componente pedia o passe no endereço antigo

`passe-url` tinha `/chat/passe` fixo como padrão, sem relação com `base`. Com
`base="/restrito/chat"`, o pedido saía para `/chat/passe`, tomava 404 e sessão
nenhuma era criada. Agora o padrão **acompanha a base** (`base + "/passe"`);
quem serve o passe em outro lugar continua dizendo por `passe-url`.

### O conector não traduzia o `Path` do cookie na volta

A 1.1 passou a traduzir o caminho na ida. Faltava a volta: o chat responde
`Set-Cookie: cid=…; Path=/chat`, porque é onde ele acha que mora, e o navegador
guarda isso ao pé da letra — o cookie nunca mais chega em `/restrito/chat/*`.
O sintoma engana: entrar responde 200, e é a chamada **seguinte** que diz
`sem_sessao`. O conector 1.3 reescreve o `Path` do prefixo remoto para o local
e deixa `Path=/` como está.

Lição de instalação: **traduzir endereço é mão dupla**. Metade da tradução
falha de um jeito que parece sistema vazio, não sistema quebrado.

- conector `1.2` → `1.3`

---

## 0.3.0 — 14/08/2026 · auditoria de segurança

Revisão completa dos caminhos sensíveis, com **sonda** que atacou o sistema
antes e depois de cada correção. Sete falhas confirmadas e corrigidas; todas
viraram teste de regressão.

### Grave — pessoa bloqueada continuava recebendo mensagens em tempo real

Bloquear apagava a sessão do banco, o que cortava o HTTP na requisição
seguinte. Mas o **WebSocket já autenticado não consultava a sessão a cada
evento**: ele continuava aberto e entregando tudo.

O bloqueio parecia funcionar — a pessoa não conseguia escrever nem recarregar —
enquanto o canal que ninguém fechou vazava a conversa inteira.

Corrigido com o evento `usuario.expulso`: bloquear **e sair** agora fecham os
sockets na hora. E o socket passou a herdar o prazo da sessão, então também
morre quando ela expira, sem consulta ao banco no batimento.

### Isolamento — presença atravessava a fronteira entre empresas (§22)

O aviso de mudança de status ia para **todos os conectados**, não só para os do
mesmo contexto. Quem estava na empresa B via a presença de quem estava na
empresa A. Nenhuma consulta ao banco atravessava a fronteira; o vazamento
acontecia no fan-out, onde não havia filtro.

`transporte.ligados(contextoId)` passou a existir, e é ele que o fan-out de
presença usa.

### Confiança indevida no cliente — anexos

Duas falhas na mesma linha:

- **anexo de uma conversa podia ser colado numa mensagem de outra.** O conteúdo
  não vazava (o download confere a conversa do anexo), mas a mensagem exibia um
  anexo que os membros recebiam 404 ao tentar baixar;
- **o tipo da mensagem vinha do campo `ehImagem` enviado pelo cliente.** Um PDF
  podia ser anunciado como imagem.

Agora os anexos são carregados do banco (`paraAnexar`) e conferidos em quatro
condições — existe, é desta pessoa, é desta conversa, ainda não foi usado — e o
tipo sai do `tipo_mime` gravado no envio, que veio da conferência dos **bytes**.

### Falsificação de confirmação de leitura

`seq` não tinha teto. Qualquer membro podia mandar `999999` e fazer o autor ver
"✓✓ lida" em mensagens que ainda nem existiam — inclusive nas futuras, porque a
marca é o menor valor entre os outros membros. Agora é limitado à última
mensagem da conversa.

### `CHAT_PROXIES` estava documentado errado para o arranjo recomendado

A documentação dizia "com nginx local, é 1". No **arranjo A** — o recomendado —
há **dois** saltos: `nginx → site (conector)` e `site → chat`. Com 1, o chat
enxergava o próprio conector e **todo visitante virava 127.0.0.1**: o limitador
passava a contar a empresa inteira como um endereço só (uma pessoa errando a
senha trancaria todo mundo junto) e a auditoria gravava o mesmo hash para todos.

Nada quebrava visivelmente. Corrigido em `.env.exemplo`, `deploy.sh`,
`INSTALAR.md` e `INSTALLATION.md` — e, mais importante, o serviço agora
**detecta e avisa no log** quando o IP resolvido de um visitante sai como
loopback em produção, que é o sintoma inequívoco. O `verificar.sh` também
confere, cruzando com a presença do conector nos sites.

### Endurecimento

- **Cookie de sessão restrito a `/chat`.** Com `Path=/`, no arranjo A ele era
  enviado em toda requisição do site do cliente — cada página, cada imagem — e
  bastaria o site registrar cabeçalhos no log de acesso para o token ficar
  gravado em texto no disco. O cookie de CSRF continua em `Path=/`, porque o
  JavaScript da página precisa lê-lo; ele sozinho não autentica nada.
- **Health check não entrega a versão em produção.** Versão exata é a primeira
  coisa que se procura ao escolher alvo. Em desenvolvimento continua saindo.
- **URL de avatar validada por lista branca de esquema.** Ela chega no passe e
  vira `<img src>` no navegador de todos os colegas; `data:` e esquemas
  exóticos deixam de passar.
- **Guarda no CSRF** para rota pública que escreve: hoje não existe nenhuma
  além de `/entrar` (que retorna antes), mas sem a guarda uma rota nova
  estouraria 500 numa rota de autenticação.

### Documentação corrigida

`CHAT_ARCHITECTURE.md` e `REALTIME.md` afirmavam que o cliente cai para
**long-polling** quando o aperto de mão falha. **Isso não existe** — o que há é
o ponto de extensão. Documentação que promete uma defesa inexistente é pior que
documentação nenhuma, porque impede que alguém a construa.

### Testes

**345** (eram 331). A suíte de segurança foi de 82 para **96**, e cada achado
desta auditoria tem o seu teste.

---

## 0.2.0 — 14/08/2026

Três defeitos encontrados **usando o chat**, não lendo o código.

### Corrigido — o tempo real estava morto no cliente

`acrescentarMensagem` era chamado em dois lugares do cliente e **nunca havia
sido definido**. Toda mensagem que chegava pelo WebSocket estourava
`TypeError` dentro do `onmessage`, que engolia a exceção em silêncio.

O sintoma era exatamente o relatado: **a mensagem só aparecia ao fechar e
reabrir a conversa** — porque aí ela vinha pelo histórico (HTTP), que sempre
funcionou. As suítes de tempo real passavam porque testam a entrega do
**servidor**, e o servidor estava certo.

O método agora existe e faz as três coisas que precisava fazer: não duplicar
(casa por `id` e por `idCliente`, o que também substitui a bolha otimista pela
confirmada), inserir na posição de `seq` em vez de no fim, e não roubar a
rolagem de quem está lendo o histórico.

**Trava para não repetir:** a suíte de unidade agora varre o cliente e falha se
algum `this.metodo()` chamado não estiver declarado — e o mesmo para
`this.el.x`. Não substitui teste de tela, mas pega a classe inteira de erro
silencioso por um custo de milissegundos.

### Corrigido — não dava para fechar a conversa sem fechar o chat

O botão "‹" existia, mas o CSS o escondia acima de 720 px. No computador, sair
de uma conversa exigia fechar o chat inteiro e abrir de novo.

- o botão agora aparece em **todo** tamanho de tela, com rótulo que muda com o
  contexto ("Voltar para a lista" no celular, "Fechar esta conversa" no
  computador);
- **ESC em hierarquia**: com conversa aberta, fecha a conversa; sem conversa,
  fecha o painel;
- o estado "Selecione uma conversa" (§4) passou a ser desenhado de verdade —
  antes a área principal abria em branco, o que parece defeito.

### Acrescentado — imagem aparece como imagem

Anexo de imagem virava um link com um emoji. Mandar uma foto e receber
"🖼 foto.png" de volta é o oposto do que se espera de um chat.

Agora a bolha mostra a imagem, com a rota `GET /chat/arquivos/:id/previa`:

- serve **inline, com o tipo real** — sem ele o `<img>` não renderiza, porque
  `application/octet-stream` com `nosniff` manda o navegador não adivinhar;
- é seguro porque duas coisas já aconteceram no envio: `image/svg+xml` **não
  está na lista branca** (SVG com `<script>` executaria no domínio do chat) e
  os **bytes foram conferidos** como imagem de verdade;
- mesma autorização do download (membro da conversa), conferida no SQL;
- `Cache-Control: private` — nunca num cache compartilhado, que alcançaria
  quem não é membro;
- **não é auditada**: a prévia dispara a cada rolagem, e auditar encheria a
  tabela. O download, que é levar o arquivo embora, continua auditado.

O download segue como estava: `attachment`, `octet-stream`, `nosniff`.

### Corrigido — resíduo de "não lida" na conversa aberta

A confirmação de leitura sai pelo socket (sem resposta) e a lista vem por HTTP;
as duas corriam juntas e a lista chegava primeiro. A barra lateral mostrava "1"
ao lado de uma mensagem que a pessoa estava lendo. Agora a conversa aberta **e
visível** tem a contagem zerada no cliente.

### Corrigido — `localhost` não abria o exemplo

No Windows, `localhost` resolve para `::1` **antes** de `127.0.0.1`, e o
hospedeiro de demonstração só escutava em IPv4. O servidor subia, o log dizia
que estava no ar, e `http://localhost:5199` respondia "não foi possível
conectar".

Agora ele escuta nos **dois loopbacks**, com dois servidores compartilhando o
mesmo handler — e não com `listen(PORTA)` sem endereço, que resolveria o
sintoma escutando em todas as interfaces e deixaria o chat de demonstração
alcançável por qualquer máquina da rede local.

O serviço de produção continua só em `127.0.0.1`, como deve ser.

### Testes

**331** (eram 319): unidade 106, integração 83, tempo real 31, segurança 82,
E2E 29.

---

## 0.1.0 — 14/08/2026

Primeira versão. Módulo completo, testado e documentado; **ainda não subiu em
produção**.

### Arquitetura

- Módulo instalável no padrão do parque: **um arquivo de conector** copiado
  para o site, mais duas linhas no `server.js`. Sem alterar banco, rota ou
  cadastro do hospedeiro.
- Node puro, CommonJS, **sem passo de build**. Uma dependência de execução
  (`ws`); `better-sqlite3` e `pg` opcionais.
- Camadas separadas com `dominio/` sem nenhuma dependência de `infra/`.
- Dois motores de banco: **SQLite** (padrão) e **PostgreSQL**, com API
  assíncrona nos dois — um `await` esquecido quebra igual nos dois.

### Tempo real

- **WebSocket** (`ws`), atrás da interface `Transporte`.
- Autenticação por **bilhete de 30 s, de uso único** — e não por cookie. É o
  que mata o *Cross-Site WebSocket Hijacking* na raiz.
- Ping/pong de 25 s com derrubada em 60 s; presença por sinal de vida, com
  carência de 30 s e suporte a multi-sessão.
- Reconexão com recuo exponencial **e ruído**, e retomada por `seq` que **não
  perde nem duplica**.

### Segurança

- **Sem E2EE**, com o motivo técnico escrito. No lugar: TLS em trânsito,
  **AES-256-GCM em repouso** com a chave fora do banco, e busca por **índice
  cego** (HMAC de tokens) que preserva a busca sem guardar texto.
- XSS **estruturalmente impossível no cliente**: nenhum conteúdo de usuário
  vira HTML.
- Passe HMAC de 60 s, uso único, com `timingSafeEqual`.
- CSRF por dupla submissão amarrada à sessão; `SameSite=Strict` no arranjo
  recomendado.
- Upload validado por extensão, MIME **e bytes iniciais**; arquivos fora da
  pasta pública, com download autorizado dentro do SQL.
- `X-Forwarded-For` lido **do fim para trás** — a falha que este parque já teve
  em quatro servidores.
- **404, nunca 403**, para recurso alheio.
- Auditoria com lista fechada de eventos e **sem nenhum conteúdo**.

### Interface

- Web Component com **Shadow DOM** — isolamento real de CSS nos dois sentidos,
  sem build.
- Três modos (`modal`, `drawer`, `fullpage`) num atributo.
- Tema claro/escuro; personalização por variáveis CSS pelo hospedeiro.
- Responsivo, com navegação de celular e botão voltar.
- WCAG 2.1 AA: foco visível, `aria-live`, `role` de diálogo e log, navegação por
  teclado, ESC para fechar.
- Estado otimista, marcas ✓/✓✓, "digitando" com *throttle*, contador de não
  lidas, notificação do navegador e som gerado (sem arquivo, respeitando o
  bloqueio de autoplay).

### Testes

**319 testes** em cinco suítes, todas em Node puro: unidade (104), integração
(73), tempo real (31), **segurança (82)** e E2E pelo conector (29).

### Correções feitas durante a construção

- **Tradutor de SQL conferia aspas antes de comentários.** Um apóstrofo dentro
  de comentário (`d'água`) abriria uma string falsa e os `?` seguintes não
  virariam `$n` — erro do PostgreSQL apontando para uma consulta sem defeito.
- **`BIGINT` volta como texto no driver `pg`.** Sem conversão, `"1000" > "830"`
  é `false`: a retomada pararia de entregar mensagens assim que o `seq` da
  conversa passasse de 999, **em silêncio**.
- **Sublinhado quebrava identificadores.** `id_cliente` e `window.__x` viravam
  sublinhado no meio da palavra. Descoberto testando no navegador; corrigido
  exigindo borda de palavra nos dois lados, no servidor e no cliente.
- **Cliente servido com `max-age=300`.** Uma correção no cliente demorava cinco
  minutos para chegar, e o sintoma era "consertou para uns e não para outros".
  Trocado por `no-cache` + ETag: revalidação barata, correção imediata.

### Limitações conhecidas

- Um processo apenas. A saída (`LISTEN`/`NOTIFY`) está documentada e isolada em
  `Transporte.publicar()`.
- O índice cego vaza **frequência** de tokens a quem tiver o banco — sem
  entregar conteúdo.
- A busca só casa **palavra inteira**: não há prefixo nem trecho.
- Sem varredura de malware nos anexos.
- As suítes rodam em SQLite; o caminho completo contra um PostgreSQL real ainda
  não foi exercitado.
- Sem teste automatizado de tela (a verificação visual foi feita no navegador).
