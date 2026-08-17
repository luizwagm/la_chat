#!/usr/bin/env bash
# ==========================================================================
#  deploy.sh — instala UMA INSTÂNCIA do LA Chat, para um projeto
#
#      sudo ./deploy.sh bemestar 6185 https://bemestarclinic.com
#      sudo ./deploy.sh bordatudo 6193 https://bordatudo.com.br
#
#      sudo ./deploy.sh --atualizar-todas      só código + restart de todas
#
#  ==========================================================================
#  UMA INSTÂNCIA POR PROJETO — e um código só
#
#  O chat sabe separar clientes por `contexto`, e há teste de segurança para
#  isso. Mas esse isolamento é LÓGICO: um campo conferido em cada consulta.
#  O que trafega aqui é conversa de equipe de clínica, que fala de paciente —
#  para esse conteúdo, "estão no mesmo arquivo, separadas por software" é uma
#  frase que ninguém quer dizer ao cliente.
#
#  Então: processo, banco e CHAVE próprios por projeto. O vazamento entre
#  clientes deixa de depender de o código estar certo.
#
#  O QUE NÃO SE MULTIPLICA É O CÓDIGO. Ele fica em /var/www/projetos/LA-Chat,
#  um só, e as instâncias são unidades `lachat@<nome>` do systemd apontando
#  para ele com ambientes diferentes. É isso que faz `git pull` + restart
#  atualizar todos os clientes de uma vez — se cada instância tivesse a própria
#  cópia do código, voltaríamos ao problema que o módulo existe para evitar.
#
#  A PORTA: a do site + 1000 (BemEstar 5185 → chat 6185). Olhando o número, se
#  sabe de quem é a instância.
# ==========================================================================
set -euo pipefail

DESTINO="${DESTINO:-/var/www/projetos/LA-Chat}"
USUARIO="${USUARIO:-deploy}"
GRUPO="${GRUPO:-deploy}"
DADOS_BASE="${DADOS_BASE:-/var/lib/lachat}"

# ==========================================================================
#  Estes dois existem para o script poder ser ENSAIADO fora do servidor
#  (ci/ensaiar.sh roda o fluxo inteiro num diretório temporário, com dublês de
#  systemctl e nginx). Em produção ficam nos valores de sempre.
#
#  Não é preciosismo: a primeira versão deste arquivo foi entregue sem nunca
#  ter rodado do começo ao fim, e o erro apareceu no servidor do cliente.
# ==========================================================================
ETC="${ETC:-/etc}"
UNIDADES="${UNIDADES:-/etc/systemd/system}"

msg() { printf "\n  \033[1m%s\033[0m\n" "$1"; }
erro() { printf "\n  \033[31m✖ %s\033[0m\n\n" "$1"; exit 1; }

[ "$(id -u)" = "0" ] || erro "rode como root (sudo ./deploy.sh …)"
command -v node >/dev/null || erro "node não encontrado"
NODE_MAIOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAIOR" -ge 20 ] || erro "o LA Chat exige Node >= 20 (achei $NODE_MAIOR)"

# ==========================================================================
#  CÓDIGO — comum a todas as instâncias
# ==========================================================================
instalar_codigo() {
  mkdir -p "$DESTINO"
  if [ "$(realpath .)" != "$(realpath "$DESTINO")" ]; then
    msg "Código → $DESTINO"
    rsync -a --delete \
      --exclude 'dados/' --exclude 'node_modules/' --exclude '.git/' \
      --exclude '.env' --exclude 'testes/saida/' \
      ./ "$DESTINO/"
  fi
  # ====================================================================
  #  QUEM É DONO DO CÓDIGO — e por que NÃO é o root
  #
  #  A tentação é `chown -R root` para o serviço não conseguir reescrever o
  #  próprio código. Só que quem ATUALIZA é o usuário `deploy`, com `git pull`
  #  e `npm ci` — e num diretório do root os dois falham. A primeira
  #  instalação funcionaria e a segunda entrega morreria com "permission
  #  denied" em `.git/`.
  #
  #  A separação certa não é por dono, é pelo SYSTEMD: a unit tem
  #  `ProtectSystem=strict` e só `/var/lib/lachat/%i` em `ReadWritePaths`.
  #  Então o PROCESSO do chat não escreve no código nem sendo `deploy` — e o
  #  `deploy` no shell continua podendo atualizar.
  # ====================================================================
  chown -R "$USUARIO:$GRUPO" "$DESTINO"
  chmod -R g+rX,o-rwx "$DESTINO"

  ( cd "$DESTINO" && sudo -u "$USUARIO" npm ci --omit=dev --no-audit --no-fund )

  # A unit é MOLDE (`@`): um arquivo, N instâncias.
  mkdir -p "$UNIDADES"
  cp "$DESTINO/nginx/lachat@.service" "$UNIDADES/lachat@.service"
  systemctl daemon-reload

  # O `map` do Upgrade vale para o nginx inteiro, não por instância.
  if [ -d "$ETC/nginx/conf.d" ]; then
    cp "$DESTINO/nginx/lachat-upgrade.conf" "$ETC/nginx/conf.d/"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx \
      || printf "  \033[31m✖\033[0m nginx -t falhou — o map NÃO foi ativado\n"
  fi
}

# ==========================================================================
#  --atualizar-todas — o caminho do dia a dia
#
#  Descobre as instâncias pelos ARQUIVOS DE AMBIENTE (`/etc/lachat-*.env`), e
#  não por uma lista aqui dentro: lista em script desatualiza, e a instância
#  esquecida seria a que fica sem a correção — em silêncio.
# ==========================================================================
if [ "${1:-}" = "--atualizar-todas" ]; then
  instalar_codigo
  achou=0
  for amb in "$ETC"/lachat-*.env; do
    [ -e "$amb" ] || continue
    inst="$(basename "$amb" .env)"; inst="${inst#lachat-}"
    achou=1
    msg "Instância $inst"
    ( set -a; . "$amb"; set +a
      cd "$DESTINO" && sudo -u "$USUARIO" -E node src/infra/dados/migrar.js )
    systemctl restart "lachat@$inst"
    sleep 1
    systemctl is-active --quiet "lachat@$inst" \
      && echo "   ativa" \
      || { journalctl -u "lachat@$inst" -n 20 --no-pager; erro "lachat@$inst não subiu"; }
  done
  [ "$achou" = "1" ] || erro "nenhuma instância encontrada ($ETC/lachat-*.env vazio)"
  msg "Todas as instâncias atualizadas."
  exit 0
fi

# ==========================================================================
#  INSTALAR UMA INSTÂNCIA
# ==========================================================================
INSTANCIA="${1:-}"
PORTA="${2:-}"
ORIGENS="${3:-}"

[ -n "$INSTANCIA" ] || erro "uso: sudo ./deploy.sh <instancia> <porta> <origens>
       exemplo: sudo ./deploy.sh bemestar 6185 https://bemestarclinic.com"
[ -n "$PORTA" ] || erro "informe a porta (a do site + 1000)"
[ -n "$ORIGENS" ] || erro "informe as origens — vazio, o chat recusa todo mundo"

case "$INSTANCIA" in
  *[!a-z0-9-]*) erro "o nome da instância aceita só letras minúsculas, números e hífen";;
esac

AMBIENTE="$ETC/lachat-$INSTANCIA.env"
DADOS="$DADOS_BASE/$INSTANCIA"

instalar_codigo

# ==========================================================================
msg "Dados da instância → $DADOS"
# ==========================================================================
# FORA da árvore do código: assim o `git pull` da atualização não tem como
# encostar no banco nem nos anexos.
mkdir -p "$DADOS/arquivos"
chown -R "$USUARIO:$GRUPO" "$DADOS"
chmod 750 "$DADOS"

# ==========================================================================
msg "Segredos → $AMBIENTE"
# ==========================================================================
# Gerados AQUI se o arquivo não existir, e NUNCA sobrescritos se existir.
# Regenerar `CHAT_DADOS_CHAVE` numa instância que já tem mensagens tornaria o
# histórico ilegível — é o pior estrago que este script poderia causar.
if [ -f "$AMBIENTE" ]; then
  echo "   já existe — preservado (nada é regerado)"
  chmod 640 "$AMBIENTE"; chown "root:$GRUPO" "$AMBIENTE"
else
  install -o root -g "$GRUPO" -m 640 /dev/null "$AMBIENTE"
  {
    echo "# Instância '$INSTANCIA' do LA Chat — gerado em $(date '+%d/%m/%Y %H:%M')"
    echo "PORT=$PORTA"
    echo "HOST=127.0.0.1"
    echo "CHAT_BANCO=sqlite"
    echo "CHAT_SQLITE=$DADOS/chat.db"
    echo "CHAT_ARQUIVOS=$DADOS/arquivos"
    echo "CHAT_CONTEXTO=$INSTANCIA"
    echo ""
    echo "# SALTOS até o chat. nginx -> site (conector) -> chat = 2."
    echo "# Errado, o limitador trata a empresa inteira como um endereço só."
    echo "CHAT_PROXIES=2"
    echo ""
    echo "# Só o site desta instância. Vazio = recusa todo mundo."
    echo "CHAT_ORIGENS=$ORIGENS"
    echo ""
    echo "# CHAVES PRÓPRIAS DESTA INSTÂNCIA. Perder CHAT_DADOS_CHAVE torna o"
    echo "# histórico de conversas ilegível — o backup não salva."
    echo "CHAT_SEGREDO_PASSE=$(openssl rand -base64 32)"
    echo "CHAT_SEGREDO_BUSCA=$(openssl rand -base64 32)"
    echo "CHAT_DADOS_CHAVE=$(openssl rand -base64 32)"
  } >> "$AMBIENTE"
fi

# ==========================================================================
msg "Banco"
# ==========================================================================
( set -a; . "$AMBIENTE"; set +a
  cd "$DESTINO" && sudo -u "$USUARIO" -E node src/infra/dados/migrar.js )

# ==========================================================================
msg "Subir"
# ==========================================================================
systemctl enable "lachat@$INSTANCIA" >/dev/null
systemctl restart "lachat@$INSTANCIA"
sleep 2

if systemctl is-active --quiet "lachat@$INSTANCIA"; then
  CODIGO="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA/chat/saude" || echo 000)"
  echo "   ativa — saúde HTTP $CODIGO"
else
  journalctl -u "lachat@$INSTANCIA" -n 30 --no-pager
  erro "a instância não subiu"
fi

SEGREDO="$(grep -oP '^CHAT_SEGREDO_PASSE=\K.*' "$AMBIENTE")"

echo ""
echo "  ─────────────────────────────────────────────"
echo "  Instância '$INSTANCIA' no ar na porta $PORTA"
echo ""
echo "  No SITE deste cliente, falta:"
echo "    1. no /etc/<site>.env:"
echo "         CHAT_URL=http://127.0.0.1:$PORTA"
echo "         CHAT_SEGREDO_PASSE=$SEGREDO"
echo "    2. o bloco 'location /restrito/chat/ws' no nginx do site"
echo "    3. o conector: node instalar-em.js ../<Projeto>"
echo "       + as duas linhas no server.js (conector/INSTALAR.md)"
echo ""
echo "  Guarde uma cópia de $AMBIENTE FORA do servidor."
echo ""
