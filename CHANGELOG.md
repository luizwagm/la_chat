# CHANGELOG

Formato: `MAIOR.MENOR.CORREÇÃO`. Toda alteração sobe a versão — 2ª casa para
recurso, 3ª para correção. Nenhuma casa para no 9.

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
