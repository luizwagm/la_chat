# Reunião por link — a sala anônima

O anfitrião cria um link, define quanto tempo a reunião dura e manda para quem
quiser. Quem recebe digita um nome e **pede para entrar**; quem conduz aprova ou
nega. Sem conta, sem senha, sem cadastro — mas também sem porta automática.

```
https://site-do-cliente.com/call/aBc9XyZ1qKm
```

Onze caracteres. É o único endereço deste sistema que responde a quem não tem
credencial nenhuma — e este documento existe principalmente por causa disso.

---

## O que muda no modelo de segurança

Até a 0.10.0 uma frase sustentava o chat inteiro: **quem pode entrar é quem é
membro da conversa**. A autorização nunca era nova; reusava `exigirMembro`, que
vive dentro do SQL e tem suíte em cima.

A sala por link quebra isso **de propósito**. Ela cria três coisas que o chat
não tinha:

1. participante **não autenticado**;
2. uma URL que quase vira credencial — quem tem o link chega à porta;
3. identidade **declarada pela própria pessoa** ("digite seu nome").

Cada um é um risco. O que os contém:

**O convidado não ganha sessão de chat.** Ele recebe uma sessão própria, com
cookie próprio (`cvd`), que autoriza **uma sala** e nada mais. Nenhuma rota de
conversa, mensagem, busca, pessoa, perfil ou administração a aceita.

**O portão é lista branca, e o padrão é recusar.** Em `http/rotas.js`,
`convidadoPode()` enumera o que ele alcança: entrar/sair de uma chamada,
microfone e câmera, credenciais de ICE, o bilhete do socket, e as rotas da
própria sala. Uma rota nova nasce **proibida** para convidado; liberá-la é um
ato deliberado, revisável de uma olhada.

**Para a empresa, o convidado não existe.** A conta dele nasce marcada
(`usuarios.convidado = 1`) e é excluída do diretório, da busca de pessoas e da
criação de grupos. É defesa em profundidade — a proteção real é a de cima.

**O link dá acesso à fila, não à reunião.** Quem abre a porta é quem conduz, e a
decisão é sobre um nome concreto — não sobre "alguém tem o endereço". É o que
transforma o item 2 acima de credencial em fila de espera. Ver **A sala de
espera**, abaixo.

**O código do link não é guardado em claro.** No banco ficam o SHA-256 (para
achar a sala) e uma cópia cifrada (para o anfitrião reler o link). Um dump
vazado não entrega sala nenhuma.

---

## O código

Alfabeto base58, sem os caracteres que se confundem (`0`, `O`, `I`, `l`), onze
posições:

```
58^11 ≈ 2^64 combinações
```

Com o freio de **20 tentativas por minuto por IP** na consulta do link,
varrer é inviável. **Adivinhar não é um caminho. Vazar o link é** — e é por isso
que o link vale por tempo limitado e pode ser revogado.

O sorteio usa amostragem por rejeição: `256 % 58 ≠ 0`, então aproveitar todos os
bytes enviesaria as primeiras letras do alfabeto. Bytes acima de 232 são
descartados.

### As três recusas são a mesma frase

Inexistente, revogada e expirada respondem **exatamente igual**, no mesmo
caminho, gastando o mesmo freio:

> Link inválido ou expirado.

Distinguir confirmaria ao curioso que ele acertou um código — e é assim que
tentativa e erro vira mapa.

---

## Quem pode criar

**Só administrador.**

Todo funcionário pode ligar para um colega: é conversa entre quem já está
dentro. Criar um link é abrir uma porta que responde a quem não tem credencial,
com a banda e o nome da empresa atrás dela. Essa decisão não pertence a cada
pessoa — pertence a quem responde pelo sistema.

É a única rota do chat com esse degrau, justamente porque é a única que fabrica
acesso externo.

**Revogar e remover continuam com quem criou a sala.** Tirar alguém de uma
reunião não pode depender de achar um administrador.

---

## O tempo

| | |
|---|---|
| Duração da reunião | 5 minutos a 8 horas (padrão 60) |
| Validade do link | 24 h por padrão, até 7 dias |
| Aviso | nos últimos 5 minutos |

**O prazo é do relógio do servidor.** Um relógio de navegador atrasado,
adiantado ou alterado de propósito não estende reunião nenhuma: o cliente
mostra a contagem, o servidor decide o fim.

E vale **igual para os dois lados**. Houve uma versão em que o convidado era
julgado pelo relógio e o anfitrião pelo estado — que só vira `encerrada` quando
a faxina roda, até 20 segundos depois. Nessa janela existiam duas verdades sobre
a mesma sala, dependendo de quem perguntava.

**Reabrir não adia o fim.** O anfitrião pode sair e voltar quantas vezes quiser;
a hora de acabar é marcada na primeira abertura e não se mexe. É o que faz
"dura 30 minutos" ser uma afirmação sobre o tempo, e não sobre o número de
aberturas.

Encerrada, a reunião **não volta por porta nenhuma** — nem reabrindo a sala, nem
entrando direto na chamada, nem pelo link.

---

## O anfitrião precisa estar presente

Enquanto ele não abre a sala, quem tem o link vê *"A reunião ainda não começou"*
e espera.

Não é formalidade. Sem essa regra, duas pessoas de fora com o link conversam
entre si usando **o seu servidor de relay, na sua banda**, sem ninguém da casa
por perto e sem nada no registro além de dois nomes digitados. É o abuso mais
barato que uma sala anônima permite, e o que faz um link vazado virar um serviço
gratuito de terceiros.

Com a regra, o link vazado só serve enquanto alguém da casa está lá — e nesse
momento a pessoa **vê quem entrou**.

---

## A privacidade do endereço IP

Numa conexão WebRTC direta os participantes veem o IP uns dos outros. Entre
colegas isso é irrelevante — mesma rede, mesmo prédio, mesmo cadastro. **Com um
estranho, deixa de ser**: o IP é a única coisa que ele leva embora sem pedir.

Por isso toda chamada nascida de um link usa `iceTransportPolicy: relay`, com ou
sem a chave global `CHAT_VIDEO_SO_RELAY`. A decisão é tomada na **abertura** da
sala, não quando o primeiro convidado chega: se só um lado estivesse em relay, o
outro continuaria anunciando os próprios candidatos e o endereço vazaria assim
mesmo.

> **Sem TURN configurado, o relay NÃO é pedido.** Pedir `relay` sem servidor de
> relay não deixa a chamada mais privada: deixa a chamada **impossível**, porque
> o navegador descarta todo candidato que não seja de relay e não sobra nenhum.

E se a conexão falhar mesmo assim, a malha **desce para conexão direta**, com
aviso na tela do que isso custa. Uma reunião que não acontece não protege o IP
de ninguém: as pessoas desligam e usam outro aplicativo, onde o IP também
aparece.

Para desligar o comportamento enquanto o relay é consertado:
`CHAT_VIDEO_SALA_RELAY=0` — e o serviço avisa isso na subida, para não virar
permanente por esquecimento.

---

## A sala de espera

Quem chega pelo link digita o nome e cai numa **fila**. Quem conduz recebe uma
batida na porta — um bipe só, não o toque que insiste — e um painel no alto da
reunião com o nome, há quanto tempo a pessoa espera, e **Aceitar** / **Negar**.

Antes disso, a porta era aberta por **quem tem o endereço**. Um link encaminhado
a mais gente do que se pretendia, colado num grupo, ou simplesmente a pessoa
errada na hora errada: em todos esses casos o anfitrião descobria a visita
**vendo um rosto novo na tela**, no meio de uma consulta. Ele tinha o botão de
remover — e remover depois não desfaz o que a pessoa já ouviu.

Três estados, em `sala_convidados.estado`:

| estado      | significa                                        |
|-------------|--------------------------------------------------|
| `esperando` | pediu, ninguém decidiu ainda                      |
| `dentro`    | aprovado — está na reunião ou pode voltar a ela   |
| `negado`    | recusado                                          |

### O que sustenta a porta

* **Quem espera não é membro de nada.** Só na aprovação ele entra na conversa e
  na chamada. É a associação — não o cookie — que `chamadas.entrar` exige, então
  não há caminho por fora da fila.
* **O teto é conferido na aprovação**, e não no pedido: entre pedir e ser aceito a
  sala pode ter enchido, e conferir só na entrada furaria o teto pela porta de
  quem decide. Quem espera também **não ocupa vaga** — senão três pessoas na fila
  lotariam uma sala vazia, e nenhuma delas poderia ser aprovada.
* **A decisão não se desfaz.** O `UPDATE` exige `estado = 'esperando'`: dois
  cliques, ou um "aceitar" depois de um "negar", não reabrem o que foi decidido.
* **A fila tem teto** — o dobro das vagas, no mínimo 10. O freio por IP não pega
  um link encaminhado a um grupo grande: são pessoas de verdade, cada uma do seu
  endereço. Sem teto, o painel vira uma lista impossível de ler na hora em que
  ele precisa decidir rápido.
* **Só quem conduz decide.** Outro funcionário não vê a fila nem aprova.

### A decisão chega por pergunta, não por aviso

A página de quem espera **pergunta** `GET /call/<codigo>/eu` de dois em dois
segundos. O socket entregaria mais rápido, mas ele é entrega ao vivo: se a
conexão oscilar no segundo em que o anfitrião clicar, a resposta se perde — e
esperar para sempre é justamente o que essa tela não pode fazer. Além disso, quem
está na fila ainda **não montou o chat**, e portanto não tem socket nenhum.

Quem conduz, esse sim, é avisado pelo socket (`sala.pedido`): ele já está numa
chamada, com socket aberto. O painel dele também consulta `GET
/salas/<id>/pedidos` ao montar a reunião — quem recarregou, ou conduz num
aparelho e abriu no outro, precisa ver quem já estava esperando.

> **O cookie de quem foi negado sobrevive**, e isso é deliberado. Matá-lo faria a
> pergunta seguinte voltar `401` — que é a mesma resposta de sessão expirada e de
> servidor reiniciado. A tela não distinguiria "você foi recusado" de "caiu a
> rede", e a pessoa esperaria para sempre por uma resposta que já veio. Mantido o
> cookie, `retomar` responde `403` com a razão. O cookie sozinho não abre porta
> nenhuma: quem foi negado nunca virou membro.

E a câmera fica **ligada** durante a espera, de propósito: a pessoa já se vê
enquadrada, e não descobre um problema de vídeo depois de aprovada, na frente de
todo mundo.

---

## O que o anfitrião controla

Na aba **Reuniões**:

* criar link, com assunto e duração;
* **copiar o link** — também de dentro da reunião, pelo botão 🔗 no topo;
* **abrir** e **reabrir** a sala;
* **aprovar** ou **negar** quem está na fila, pelo nome;
* ver **quem entrou**, com o nome digitado;
* **remover** um convidado — e o cookie dele morre na hora, não na próxima
  recarga; o socket cai junto;
* **revogar** o link — derruba quem estiver dentro.

Uma sala encerrada ou revogada não oferece ação nenhuma, nem copiar: link
encerrado copiado é link encerrado **enviado**.

---

## Recarregar não é entrar de novo

No celular a recarga acontece o tempo todo: girar a tela, trocar de aplicativo,
o navegador descartar a aba em segundo plano.

O cookie do convidado vale **4 horas** justamente para isto. `GET
/call/<codigo>/eu` retoma a identidade que já existe, sem pedir o nome outra vez
— e devolve `estado`, que diz em qual das duas telas a pessoa cai: a fila ou a
reunião. Recarregar no meio da espera **não perde o lugar**.

Antes disso, cada recarga criava um convidado **novo**, com id novo, gastando
mais uma vaga do teto — uma sala de cinco lugares se esgotava com **uma pessoa e
quatro recargas**, e o anfitrião via cinco desconhecidos com o mesmo nome.

Sem cookie não se retoma nada: o link sozinho não basta. E quem foi removido não
volta recarregando.

---

## A página do convidado

Servida pelo próprio chat, em `<prefixo>/call/<codigo>`. É o **único HTML** deste
serviço.

**Nada é interpolado.** O código da sala não entra no HTML; o JavaScript o lê do
endereço. XSS ali é impossível por construção, e não por escapamento correto —
um dia alguém acrescentaria um campo e esqueceria o escape; sem interpolação
nenhuma, esse dia não chega.

A CSP daquela página é mais apertada que a do resto: **sem `unsafe-inline` para
script** (por isso o comportamento mora em `sala.js`, servido à parte),
`frame-ancestors 'none'`, `object-src 'none'`, e `X-Robots-Tag: noindex` — um
link de reunião no índice de busca é um link entregue a quem nunca o recebeu.

### A permissão de câmera — uma vez, e só uma

**Não dá para dispensar.** Nenhum cabeçalho, flag ou ajuste de servidor faz um
navegador entregar a câmera sem o consentimento de quem está na frente dela — e o
dia em que der, qualquer página liga a câmera de qualquer um. O que dá para
consertar é **perguntar demais**, e nós perguntávamos duas vezes:

| momento | pedido | efeito |
|---|---|---|
| abre o link | `{ video: true, audio: false }` | pergunta a câmera |
| entra na reunião | `{ audio: {…}, video: {…} }` | pergunta **de novo**, pelo microfone |

O microfone ficava fora do primeiro pedido, então o segundo tinha uma permissão
**nova** a pedir — e o diálogo voltava no pior momento possível, com o anfitrião
já esperando na tela. E entre os dois, a prévia **parava as trilhas**: a luz da
câmera apagava e reacendia bem na hora de entrar.

Agora o pedido é **um só**, no instante em que o link abre, com as mesmas
exigências que a reunião usaria — e o fluxo conquistado ali é **entregue** à
reunião, sem parar nada e sem pedir de novo.

O microfone chega **desligado** (`track.enabled = false`) e só liga na entrada: a
permissão é dada de uma vez, mas nada é captado enquanto a pessoa digita o nome e
espera aprovação.

> Sob **HTTPS** o navegador guarda a autorização por origem. Da segunda reunião em
> diante, no mesmo aparelho, não há diálogo nenhum.

### Zero diálogos, nas máquinas da própria empresa

Existe, e não é gambiarra: o Chrome e o Edge têm uma política feita exatamente
para isto. Ela pré-autoriza **uma origem**, e quem a define é o administrador da
máquina — não a página.

| política | o que faz |
|---|---|
| `VideoCaptureAllowedUrls` | libera a câmera para as origens listadas, sem perguntar |
| `AudioCaptureAllowedUrls` | o mesmo para o microfone |

No Windows, pelo registro (o administrador aplica; `1` é o primeiro item da
lista, e pode haver `2`, `3`…):

```
HKLM\SOFTWARE\Policies\Google\Chrome\VideoCaptureAllowedUrls\1 = https://site-do-cliente.com
HKLM\SOFTWARE\Policies\Google\Chrome\AudioCaptureAllowedUrls\1 = https://site-do-cliente.com
```

Para o Edge, o mesmo caminho trocando `Google\Chrome` por `Microsoft\Edge`. Em
parque com domínio, o normal é aplicar por GPO em vez de registro máquina a
máquina. Conferir depois em `chrome://policy`.

**Só a origem listada é liberada** — é o que separa isto de desligar a proteção.
A flag `--use-fake-ui-for-media-stream`, que às vezes aparece em respostas de
fórum, faz outra coisa: aceita **qualquer** site que peça a câmera, naquele
navegador, para sempre. É ferramenta de teste automatizado; numa máquina de
trabalho é uma porta aberta.

E vale para as máquinas que a empresa administra — **nunca** para o paciente,
que está no aparelho dele. Do lado de fora, o melhor alcançável é o que já está
feito: uma pergunta, uma vez, e o navegador lembrando daí em diante.

### Quem já negou uma vez

É o caso que trava de verdade, e não tem diálogo nenhum para resolver: o
navegador guarda a recusa por origem e **não pergunta mais**. Todo link abre com
a câmera desligada, e a pessoa não tem o que clicar.

A tela diz onde fica o interruptor (o cadeado ao lado do endereço) e **percebe
sozinha quando ele é ligado**: a API de permissões avisa a mudança, e a prévia
abre sem recarregar. Sem isso, a pessoa libera a câmera, volta, e continua vendo
"bloqueada" — porque a página não tem como saber.

### O link curto

`site.com/call/<codigo>` é o que circula. Ele **redireciona** para dentro do
prefixo do chat, onde a página e a API se enxergam.

Servir a página no endereço curto a deixaria procurando `/bilhete` e
`/chamadas/…` na raiz do site do cliente, onde não há nada — a reunião abriria e
não conectaria. O conector do hospedeiro atende esse caminho e faz o mesmo
redirecionamento.

---

## Instalação

A reunião por link exige **vídeo ligado** e, na prática, **TURN funcionando**:

```bash
CHAT_VIDEO=1
CHAT_TURN=turn:chat.seudominio.com:3478,turn:chat.seudominio.com:3478?transport=tcp,turns:chat.seudominio.com:5349
CHAT_TURN_SEGREDO=<o mesmo static-auth-secret do coturn>
CHAT_STUN=stun:chat.seudominio.com:3478
CHAT_BASE=https://site-do-cliente.com
```

`CHAT_BASE` não é enfeite: **é com ele que o convite é montado**. Errado, o
anfitrião manda ao cliente um link que só abre de dentro do servidor.

Os três transportes importam. Rede móvel e wifi corporativo bloqueiam UDP com
frequência; `turns:` na 5349 trafega como HTTPS e atravessa quase tudo — e
**exige o nome**, porque o certificado é emitido para ele: por IP o navegador
recusa por incompatibilidade.

O relay se instala com `./criar-relay.sh chat.seudominio.com`, uma vez por
servidor. Ver `docs/VIDEO.md` para o endurecimento do coturn — as linhas
`no-loopback-peers` e `denied-peer-ip` **não são opcionais** quando estranhos
recebem credencial de relay.

### Outras chaves

| Chave | Padrão | O que faz |
|---|---|---|
| `CHAT_SALA_FREIO_ENTRAR` | 10 | entradas por minuto, por IP |
| `CHAT_VIDEO_SALA_RELAY` | 1 | relay obrigatório na reunião por link |
| `CHAT_VIDEO_TETO` | 6 | pessoas na malha |

---

## Quando não conecta

A tela diz. Passados 20 segundos com alguém travado, ela conta o que foi
tentado — e a conclusão vem do padrão dos erros, não do último:

* **todos expiraram** → a rede daquele aparelho não alcança o relay. VPN,
  proxy, economia de dados ou duas redes ativas ao mesmo tempo são as causas
  comuns;
* **401/403** → a credencial foi recusada: `CHAT_TURN_SEGREDO` não bate com o
  `static-auth-secret` do coturn.

Para diagnóstico completo, no console do navegador:

```js
document.querySelector("la-chat").video.errosIce
```

E, do lado do servidor, `./verificar.sh <instância>` **exercita** o relay: faz a
mesma conta HMAC que o chat e pede uma alocação de verdade. Ele também diz o que
não alcança — tudo é medido de dentro, e um relay que aceita credencial
localmente pode não receber pacote nenhum da internet.

---

## O que a suíte cobre

`testes/salas.cjs` — mais de 170 casos, e **metade deles não testa
funcionalidade**: testa que o convidado bate na parede em todo lugar que não
seja a reunião dele.

> Se um teste daquela seção passar a falhar, a leitura correta não é "ajustar o
> teste" — é que alguém abriu uma porta.

Alguns provam coisas que já deram errado: o código não fica em claro no banco; a
recusa é idêntica para inexistente e revogada; quatro recargas continuam sendo
uma pessoa na sala; o prazo não estica ao reabrir; e o CSRF do convidado é o
**dele**, não o do funcionário — este último custou uma tarde de investigação de
rede num relay que estava perfeito.

Da sala de espera: que quem espera não entra na chamada por fora; que o teto é
conferido na aprovação e não no pedido; que aprovar duas vezes não gasta duas
vagas; e que quem foi negado **sabe disso ao perguntar**, com a razão, em vez de
receber um erro genérico indistinguível de rede caindo.

E uma trava em `testes/unidade.cjs` amarra os **nomes dos avisos**: tudo que o
transporte publica como `sala.*` tem de ser tratado no cliente. Um nome escrito
diferente dos dois lados de um limite não quebra nada, não registra nada e não
estoura em lugar nenhum — o aviso simplesmente não acontece. Na primeira
execução, ela acusou um evento que saía para um socket inexistente.
