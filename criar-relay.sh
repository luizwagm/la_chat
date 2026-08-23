#!/usr/bin/env bash
# ==========================================================================
#  criar-relay.sh — o servidor de relay (coturn) do LA Chat
#
#      sudo ./criar-relay.sh                        → chat.luizaugust.me
#      sudo ./criar-relay.sh relay.meudominio.com
#      sudo ./criar-relay.sh <dominio> [email]
#
#  Roda UMA VEZ POR SERVIDOR. O relay é compartilhado: um coturn atende TODAS
#  as instâncias do chat (bemestar, bordatudo, …). O que é por cliente é ligar
#  o vídeo no `/etc/lachat-<cliente>.env` — ver o fim deste script.
#
#  ==========================================================================
#  POR QUE EXISTE UM VHOST DE NGINX PARA UMA COISA QUE NÃO PASSA PELO NGINX
#
#  O coturn NÃO é servido pelo nginx: ele escuta direto nas portas 3478 e 5349.
#  O vhost existe por um motivo só, e vale saber qual — senão alguém o remove
#  achando que sobrou:
#
#      é ele que permite ao certbot EMITIR e, sobretudo, RENOVAR o
#      certificado que o coturn usa no `turns:`.
#
#  Sem TLS, o relay não atravessa firewall corporativo que só deixa passar 443
#  — que é exatamente a rede onde o TURN mais faz falta.
#
#  ==========================================================================
#  A ARMADILHA QUE APARECE EM 90 DIAS
#
#  O coturn LÊ o certificado ao subir e não o relê nunca mais. O certbot renova
#  sozinho, escreve arquivos novos — e o coturn continua servindo o antigo, já
#  vencido, até alguém reiniciá-lo.
#
#  O sintoma chega três meses depois da instalação, some quando você reinicia
#  para investigar, e volta noventa dias depois. Por isso este script instala um
#  gancho de renovação. Ele não é opcional.
# ==========================================================================
set -uo pipefail

DOMINIO="${1:-chat.luizaugust.me}"
EMAIL="${2:-luizwagm@gmail.com}"

# ==========================================================================
#  ESTES CAMINHOS SÃO VARIÁVEIS para o script poder ser ENSAIADO fora do
#  servidor (`ci/ensaiar-relay.sh` roda o fluxo inteiro num diretório
#  temporário, com dublês de certbot, nginx, systemctl e apt).
#
#  Não é preciosismo. A primeira versão do `deploy.sh` deste projeto foi
#  entregue sem nunca ter rodado do começo ao fim, e o erro apareceu no
#  servidor do cliente. Em produção ficam nos valores de sempre.
# ==========================================================================
ETC="${ETC:-/etc}"
WEBROOT="${WEBROOT:-/var/www/html}"
LE="${LE:-/etc/letsencrypt}"
LOGS="${LOGS:-/var/log}"

CONF_TURN="${CONF_TURN:-$ETC/turnserver.conf}"
SEGREDO_ARQ="${SEGREDO_ARQ:-$ETC/lachat-relay.env}"
PORTA_MIN=49152
PORTA_MAX=65535

verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }
azul()    { printf "\033[1;34m%s\033[0m\n" "$1"; }

[ "$(id -u)" -eq 0 ] || { vermelho "Rode com sudo."; exit 1; }

azul "── LA Chat · servidor de relay ───────────────────────"
echo "     domínio : $DOMINIO"
echo "     escopo  : o servidor inteiro (todas as instâncias do chat)"
echo

# ==========================================================================
#  1. O DNS
#
#  Antes de tudo, porque é o único passo que não depende de nós e o único que
#  demora. Descobrir que o DNS não propagou DEPOIS de instalar o coturn é
#  gastar meia hora para voltar ao começo.
# ==========================================================================
echo "1/8  Conferindo o DNS"

MEUS_IPS=$(
  { ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    curl -4 -s --max-time 8 https://ifconfig.me 2>/dev/null; echo
    curl -6 -s --max-time 8 https://ifconfig.me 2>/dev/null; echo
  } | sort -u | grep -v '^$'
)
[ -n "${IP_SERVIDOR:-}" ] && MEUS_IPS="$MEUS_IPS
$IP_SERVIDOR"

resolve() { dig +short "$2" "$1" 2>/dev/null | grep -E '^[0-9a-fA-F.:]+$' | tail -1; }
daqui()   { [ -n "$1" ] && echo "$MEUS_IPS" | grep -qxF "$1"; }

A=$(resolve "$DOMINIO" A)
AAAA=$(resolve "$DOMINIO" AAAA)
echo "     este servidor : $(echo "$MEUS_IPS" | tr '\n' ' ')"
echo "     $DOMINIO : ${A:-—} ${AAAA:-}"

if daqui "$A" || daqui "$AAAA"; then
  verde "     o domínio resolve para este servidor"
else
  vermelho "     o DNS não aponta para cá."
  vermelho "     Crie um registro A: $DOMINIO -> $(echo "$MEUS_IPS" | grep -m1 '\.')"
  vermelho "     Com certeza do DNS: sudo IP_SERVIDOR=<ip> $0 $DOMINIO"
  exit 1
fi

# ==========================================================================
#  2. O IP PÚBLICO — o erro de instalação número um do coturn
#
#  Sem `external-ip`, o coturn anuncia o endereço da INTERFACE. Numa máquina
#  atrás de NAT (toda nuvem com IP flutuante, todo servidor com firewall que
#  faz 1:1) esse endereço é interno, e o relay que ele oferece não existe do
#  lado de fora.
#
#  O sintoma é cruel: a chamada conecta entre quem está na mesma rede e falha
#  para todo o resto — que é justamente o caso em que o TURN deveria salvar.
# ==========================================================================
echo "2/8  Descobrindo o IP público"

IP_PUB="${IP_PUBLICO:-$(curl -4 -s --max-time 8 https://ifconfig.me 2>/dev/null)}"
if [ -z "$IP_PUB" ]; then
  vermelho "     não consegui descobrir o IP público."
  vermelho "     Informe: sudo IP_PUBLICO=<ip> $0 $DOMINIO"
  exit 1
fi
IP_IFACE=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
echo "     público   : $IP_PUB"
echo "     interface : ${IP_IFACE:-—}"
if [ -n "$IP_IFACE" ] && [ "$IP_PUB" != "$IP_IFACE" ]; then
  amarelo "     máquina atrás de NAT — o external-ip mapeia $IP_PUB/$IP_IFACE"
  EXTERNAL_IP="$IP_PUB/$IP_IFACE"
else
  EXTERNAL_IP="$IP_PUB"
fi
verde "     external-ip=$EXTERNAL_IP"

# ==========================================================================
#  3. O SEGREDO DO RELAY
#
#  GERADO UMA VEZ E NUNCA REGERADO. Ele vive em dois lugares que precisam
#  bater: o `static-auth-secret` do coturn e o `CHAT_TURN_SEGREDO` de cada
#  instância. Trocá-lo aqui sem trocar lá derruba o vídeo de todos os clientes
#  ao mesmo tempo, com um erro que o navegador reporta como "falha de rede".
#
#  ESCOPO: o segredo é DO SERVIDOR, não do cliente. Vazando o env de uma
#  instância, vaza o relay de todas — e nada além disso: as chaves de dados
#  (`CHAT_DADOS_CHAVE`) continuam sendo uma por instância, e conversa e anexo
#  de um cliente permanecem ilegíveis para outro.
# ==========================================================================
echo "3/8  O segredo do relay"

if [ -f "$SEGREDO_ARQ" ] && grep -q '^CHAT_TURN_SEGREDO=' "$SEGREDO_ARQ"; then
  SEGREDO="$(grep -oP '^CHAT_TURN_SEGREDO=\K.*' "$SEGREDO_ARQ")"
  verde "     já existia em $SEGREDO_ARQ — preservado"
else
  SEGREDO="$(openssl rand -base64 32)"
  install -o root -g root -m 600 /dev/null "$SEGREDO_ARQ"
  {
    echo "# Segredo do relay de vídeo — gerado em $(date '+%d/%m/%Y %H:%M')"
    echo "# O MESMO valor vai no static-auth-secret do coturn e no"
    echo "# CHAT_TURN_SEGREDO de cada instância que usar vídeo."
    echo "CHAT_TURN_SEGREDO=$SEGREDO"
    echo "CHAT_TURN=turn:$DOMINIO:3478,turns:$DOMINIO:5349"
    echo "CHAT_STUN=stun:$DOMINIO:3478"
  } >> "$SEGREDO_ARQ"
  verde "     gerado e guardado em $SEGREDO_ARQ (modo 600)"
fi

# ==========================================================================
#  4. O VHOST — só o suficiente para o certbot
#
#  Ele NÃO serve o chat e NÃO repassa para lugar nenhum. Tudo que não for o
#  desafio da ACME responde 404. Superfície de ataque de um endereço que só
#  precisa provar posse do domínio deve ser exatamente isso: nenhuma.
# ==========================================================================
echo "4/8  O vhost do certificado"

mkdir -p "$WEBROOT"
ARQ="$ETC/nginx/sites-available/$DOMINIO"
mkdir -p "$ETC/nginx/sites-available" "$ETC/nginx/sites-enabled"
[ -f "$ARQ" ] && { cp "$ARQ" "$ARQ.bak-$(date +%F-%H%M%S)"; amarelo "     já existia — guardei uma cópia .bak"; }

cat > "$ARQ" <<NGINX
# Gerado por criar-relay.sh — LA Chat
#
# ESTE VHOST NÃO SERVE O CHAT. Ele existe para o certbot emitir e renovar o
# certificado que o COTURN usa no turns:. O relay escuta direto nas portas
# 3478 e 5349 e não passa por aqui.
#
# Confira com \`nginx -T\`, não com \`nginx -t\`: o -t aprova bloco que o nginx
# nem carregou (link quebrado, arquivo fora do include).

server {
    listen 80;
    listen [::]:80;
    server_name $DOMINIO;

    # O desafio da ACME, e nada mais.
    location ^~ /.well-known/acme-challenge/ {
        root $WEBROOT;
        access_log off;
    }

    access_log $LOGS/nginx/$DOMINIO.access.log;
    error_log  $LOGS/nginx/$DOMINIO.error.log;

    location / { return 404; }
}
NGINX

ln -sf "$ARQ" "$ETC/nginx/sites-enabled/$DOMINIO"
if ! nginx -t 2>&1 | sed 's/^/     /'; then
  vermelho "     configuração inválida — nada foi recarregado"
  exit 1
fi
systemctl reload nginx
verde "     vhost ativo em HTTP (só a ACME)"

# ==========================================================================
#  5. O CERTIFICADO
#
#  `--webroot`, e não `--nginx`: o plugin do nginx reescreveria este vhost
#  acrescentando um bloco 443 que não queremos — o endereço não serve página
#  nenhuma. Com webroot, o nginx fica como está e a renovação continua
#  passando pelo mesmo caminho.
# ==========================================================================
echo "5/8  Emitindo o certificado"

if [ -d "$LE/live/$DOMINIO" ]; then
  verde "     já existe — reaproveitado"
else
  if certbot certonly --webroot -w "$WEBROOT" -d "$DOMINIO" \
       --agree-tos --no-eff-email -m "$EMAIL" --non-interactive; then
    verde "     certificado emitido"
  else
    vermelho "     o certbot falhou — veja /var/log/letsencrypt/letsencrypt.log"
    exit 1
  fi
fi

CERT="$LE/live/$DOMINIO/fullchain.pem"
CHAVE="$LE/live/$DOMINIO/privkey.pem"

# ==========================================================================
#  6. O COTURN
# ==========================================================================
echo "6/8  Instalando e configurando o coturn"

if ! command -v turnserver >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y coturn >/dev/null 2>&1 \
    && verde "     coturn instalado" \
    || { vermelho "     falhou instalar o coturn"; exit 1; }
else
  verde "     coturn já instalado"
fi

# O pacote do Debian instala o serviço DESLIGADO, por um interruptor num
# arquivo separado. Sem isto, `systemctl start` sobe e o processo sai.
if [ -f "$ETC/default/coturn" ]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' "$ETC/default/coturn"
  grep -q '^TURNSERVER_ENABLED=1' "$ETC/default/coturn" || echo "TURNSERVER_ENABLED=1" >> "$ETC/default/coturn"
fi

[ -f "$CONF_TURN" ] && cp "$CONF_TURN" "$CONF_TURN.bak-$(date +%F-%H%M%S)"

cat > "$CONF_TURN" <<TURN
# ==========================================================================
#  Gerado por criar-relay.sh (LA Chat) em $(date '+%d/%m/%Y %H:%M')
#
#  Este relay atende TODAS as instâncias do chat neste servidor.
# ==========================================================================

listening-port=3478
tls-listening-port=5349

# ==========================================================================
#  O IP PÚBLICO — o erro de instalação número um.
#
#  Sem esta linha o coturn anuncia o endereço da INTERFACE. Numa máquina atrás
#  de NAT esse endereço é interno, e o relay que ele oferece não existe do lado
#  de fora: a chamada conecta entre quem está na mesma rede e falha para todo o
#  resto — justamente o caso em que o TURN deveria salvar.
# ==========================================================================
external-ip=$EXTERNAL_IP

realm=$DOMINIO
server-name=$DOMINIO

# ==========================================================================
#  CREDENCIAL TEMPORÁRIA — nunca usuário e senha fixos.
#
#  A credencial VAI PARA O NAVEGADOR: ela aparece no DevTools de qualquer
#  participante, e desde a reunião por link isso inclui ESTRANHOS que só
#  receberam um convite.
#
#  Com \`use-auth-secret\`, o chat deriva credenciais de 2 h do mesmo segredo e
#  o coturn refaz a conta. Vazou, expira sozinha. Fixa, o seu servidor vira
#  relay de graça para o mundo — e a conta de banda é sua.
# ==========================================================================
use-auth-secret
static-auth-secret=$SEGREDO

# TLS, para atravessar firewall corporativo que só deixa passar 443.
cert=$CERT
pkey=$CHAVE
no-tlsv1
no-tlsv1_1

# ==========================================================================
#  NÃO SEJA UM RELAY ABERTO PARA A REDE INTERNA.
#
#  Sem estas linhas, quem obtiver uma credencial usa o TURN para alcançar
#  127.0.0.1 e a rede local deste servidor — inclusive os OUTROS sites do
#  parque, que escutam no loopback. É Server-Side Request Forgery com ajuda do
#  seu próprio relay.
#
#  Isto deixou de ser recomendação quando nasceu a reunião por link: agora
#  TODO PORTADOR DE UM CONVITE recebe credencial de relay.
# ==========================================================================
no-loopback-peers
no-multicast-peers

denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=224.0.0.0-255.255.255.255

# O IPv6 tem as mesmas faixas privadas, e esquecê-las reabre o buraco inteiro
# numa máquina com IPv6 — que é toda máquina em nuvem hoje.
denied-peer-ip=::1
denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

# ==========================================================================
#  O CONSOLE DE ADMINISTRAÇÃO FICA DESLIGADO.
#
#  O coturn abre, por padrão, um console telnet em 127.0.0.1:5766. Num
#  servidor que hospeda vinte sites, "só o loopback" não é isolamento: é
#  exatamente o alcance que uma falha em qualquer um dos vinte concede.
# ==========================================================================
no-cli

# Faixa de relay. Explícita para bater com a regra do firewall.
min-port=$PORTA_MIN
max-port=$PORTA_MAX

# Teto de banda. Uma reunião de 720p usa ~1500 kbps.
user-quota=12
total-quota=200

fingerprint
stale-nonce=600

# Registro em arquivo próprio, sem encher o syslog.
log-file=$LOGS/turnserver.log
simple-log
TURN

chmod 640 "$CONF_TURN"
verde "     $CONF_TURN escrito"

# ==========================================================================
#  7. A CHAVE QUE O COTURN PRECISA LER — e o gancho de renovação
#
#  O coturn roda como `turnserver`, e `/etc/letsencrypt/live/*/privkey.pem` é
#  legível só pelo root. Sem ajustar isto, o serviço sobe e falha no TLS com
#  uma mensagem que não diz "permissão".
#
#  E o gancho: o coturn LÊ o certificado ao subir e não o relê nunca mais. O
#  certbot renova sozinho a cada 90 dias, e sem o gancho o relay continuaria
#  servindo um certificado vencido até alguém reiniciá-lo — três meses depois
#  da instalação, quando ninguém está olhando para cá.
# ==========================================================================
echo "7/8  Permissões e renovação automática"

getent group ssl-cert >/dev/null || groupadd ssl-cert
id turnserver >/dev/null 2>&1 && usermod -aG ssl-cert turnserver

chgrp -R ssl-cert "$LE/live" "$LE/archive" 2>/dev/null || true
chmod -R g+rX "$LE/live" "$LE/archive" 2>/dev/null || true
verde "     o coturn passou a enxergar a chave"

mkdir -p "$LE/renewal-hooks/deploy"
cat > "$LE/renewal-hooks/deploy/10-coturn.sh" <<HOOK
#!/usr/bin/env bash
# ==========================================================================
#  Gerado por criar-relay.sh (LA Chat).
#
#  O coturn lê o certificado ao SUBIR e não o relê nunca mais. Sem este
#  gancho, a renovação automática do certbot escreveria arquivos novos e o
#  relay seguiria servindo o antigo, já vencido.
#
#  O sintoma chegaria 90 dias depois da instalação, sumiria assim que alguém
#  reiniciasse para investigar, e voltaria 90 dias depois.
# ==========================================================================
set -e
chgrp -R ssl-cert $LE/live $LE/archive 2>/dev/null || true
chmod -R g+rX   $LE/live $LE/archive 2>/dev/null || true
systemctl is-active --quiet coturn && systemctl restart coturn
exit 0
HOOK
chmod 755 "$LE/renewal-hooks/deploy/10-coturn.sh"
verde "     gancho de renovação instalado"

# ==========================================================================
#  8. FIREWALL, SUBIDA E CONFERÊNCIA
# ==========================================================================
echo "8/8  Firewall e subida"

if command -v ufw >/dev/null 2>&1; then
  ufw allow 3478/udp  >/dev/null 2>&1
  ufw allow 3478/tcp  >/dev/null 2>&1
  ufw allow 5349/tcp  >/dev/null 2>&1
  ufw allow 5349/udp  >/dev/null 2>&1
  ufw allow "$PORTA_MIN:$PORTA_MAX/udp" >/dev/null 2>&1
  verde "     ufw: 3478, 5349 e $PORTA_MIN-$PORTA_MAX/udp liberadas"
else
  amarelo "     ufw não encontrado — libere 3478/udp+tcp, 5349/tcp+udp e $PORTA_MIN-$PORTA_MAX/udp à mão"
fi

systemctl enable coturn >/dev/null 2>&1
systemctl restart coturn
sleep 2

if systemctl is-active --quiet coturn; then
  verde "     coturn no ar"
else
  vermelho "     o coturn NÃO subiu:"
  journalctl -u coturn -n 25 --no-pager | sed 's/^/       /'
  exit 1
fi

echo
azul "── conferência ───────────────────────────────────────"

ouvindo() {
  ss -lnu 2>/dev/null | grep -q ":$1 " || ss -lnt 2>/dev/null | grep -q ":$1 "
}
ouvindo 3478 && verde "     escutando na 3478" || vermelho "     NADA na 3478"
ouvindo 5349 && verde "     escutando na 5349 (TLS)" || amarelo "     nada na 5349 — confira o certificado"

for regra in no-loopback-peers no-cli use-auth-secret external-ip; do
  grep -q "^$regra" "$CONF_TURN" && verde "     $regra ativo" || vermelho "     $regra AUSENTE"
done
NEGADAS=$(grep -c '^denied-peer-ip' "$CONF_TURN")
[ "$NEGADAS" -ge 8 ] && verde "     $NEGADAS faixas privadas negadas (IPv4 e IPv6)" \
                     || vermelho "     só $NEGADAS faixas negadas — o relay alcança a rede interna"

certbot renew --dry-run >/dev/null 2>&1 \
  && verde "     renovação testada (e ela reinicia o coturn)" \
  || amarelo "     o teste de renovação falhou — rode 'certbot renew --dry-run'"

# ==========================================================================
echo
azul "── falta ligar o vídeo em CADA CLIENTE ───────────────"
echo
echo "  O relay está pronto e é UM SÓ para o servidor inteiro."
echo "  Ligar o vídeo é por instância. Para cada cliente:"
echo
echo "    sudo nano /etc/lachat-<cliente>.env"
echo
echo "      CHAT_VIDEO=1"
echo "      CHAT_TURN=turn:$DOMINIO:3478,turns:$DOMINIO:5349"
echo "      CHAT_TURN_SEGREDO=$SEGREDO"
echo "      CHAT_STUN=stun:$DOMINIO:3478"
echo
echo "    sudo systemctl restart lachat@<cliente>"
echo "    ./verificar.sh <cliente> https://<site-do-cliente>"
echo
amarelo "  Guarde $SEGREDO_ARQ FORA do servidor."
echo
verde "Relay no ar em $DOMINIO."
echo
