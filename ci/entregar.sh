#!/usr/bin/env bash
# ==========================================================================
#  entregar.sh — o ÚNICO comando que a chave do GitHub consegue executar
#
#  Instalar no servidor:
#      mkdir -p ~/bin && cp ci/entregar.sh ~/bin/entregar-lachat
#      chmod 755 ~/bin/entregar-lachat
#
#  E no ~/.ssh/authorized_keys, a chave da entrega entra assim:
#      restrict,command="/home/deploy/bin/entregar-lachat" ssh-ed25519 AAAA... entrega-lachat
#
#  POR QUE O `command=` É A PEÇA MAIS IMPORTANTE DESTE ARQUIVO
#
#  Uma chave SSH comum dá SHELL. Guardada como segredo no GitHub, ela vira uma
#  porta para o servidor inteiro na mão de quem tiver acesso ao repositório —
#  incluindo qualquer Action de terceiro que alguém adicione ao workflow.
#
#  Com `command=`, o servidor IGNORA o que o cliente pedir e roda só isto. O
#  `restrict` desliga túnel, encaminhamento de agente e terminal.
#
#  E aqui isso pesa MAIS que num site: o banco do chat guarda as conversas da
#  equipe da clínica, cifradas com uma chave que vive no mesmo servidor.
#
#  Testar antes de confiar (deve mostrar a entrega, nunca um shell):
#      ssh -i chave deploy@servidor "cat /etc/shadow"
# ==========================================================================
set -uo pipefail

PROJETO="${PROJETO:-/var/www/projetos/LA-Chat}"
SERVICO="lachat"
TRAVA="/tmp/entregar-lachat.lock"

cd "$PROJETO" || { echo "entregar: $PROJETO não existe"; exit 1; }

logger -t entrega-lachat "pedido de entrega de ${SSH_CLIENT%% *}"

# ------------------------------------------------------------------ trava
# Dois pushes seguidos disparam duas entregas ao mesmo tempo, e as duas mexem
# no mesmo banco e no mesmo serviço.
exec 9>"$TRAVA"
if ! flock -w 600 9; then
  echo "entregar: outra entrega está rodando há mais de 10 minutos — desisti"
  exit 1
fi

echo "=== entrega do LA Chat iniciada em $(date '+%d/%m/%Y %H:%M:%S') ==="

# ==========================================================================
#  1. CÓDIGO
#
#  `dados/` NÃO está no repositório (banco, anexos e contadores vivem só aqui),
#  e é por isso que um `git pull` é seguro: ele não tem como encostar neles.
#  O `--ff-only` recusa merge automático — se a árvore do servidor divergiu,
#  eu quero saber, não quero um merge inventado no meio de uma entrega.
# ==========================================================================
ANTES="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"

git fetch --quiet origin main || { echo "entregar: falhou o fetch"; exit 1; }
if ! git merge --ff-only origin/main; then
  echo "entregar: a árvore do servidor divergiu da main — resolva à mão."
  exit 1
fi

DEPOIS="$(git rev-parse --short HEAD)"
echo "código: $ANTES → $DEPOIS"

# ==========================================================================
#  2. DEPENDÊNCIAS E BANCO
# ==========================================================================
npm ci --omit=dev --no-audit --no-fund || { echo "entregar: npm ci falhou"; exit 1; }

# As migrations do chat são idempotentes e rodam com o serviço de pé; o
# arquivo de ambiente traz a chave que decifra o que já existe.
set -a; . /etc/lachat.env; set +a
node src/infra/dados/migrar.js || { echo "entregar: migração falhou"; exit 1; }

# ==========================================================================
#  3. SUBIR
# ==========================================================================
sudo /usr/bin/systemctl restart "$SERVICO.service"
sleep 2

if ! sudo /usr/bin/systemctl is-active --quiet "$SERVICO.service"; then
  echo "entregar: o serviço NÃO subiu — journalctl -u $SERVICO -n 50"
  exit 1
fi

# Prova de vida pela porta, e não só pelo systemd: "active" só diz que o
# processo existe, não que ele responde.
PORTA="$(grep -oP '^PORT=\K\d+' /etc/lachat.env || echo 5197)"
CODIGO="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA/chat/saude" || echo 000)"
echo "saúde: HTTP $CODIGO"
[ "$CODIGO" = "200" ] || { echo "entregar: o chat não respondeu na porta $PORTA"; exit 1; }

# ==========================================================================
#  4. O CONECTOR NOS SITES — CONFERIR, e NÃO instalar
#
#  Aqui mora a decisão mais importante deste arquivo, e ela é contraintuitiva.
#
#  Seria tentador rodar `instalar-em.js --todos` agora: o conector de todos os
#  sites ficaria atualizado num passo. E QUEBRARIA O DEPLOY DELES.
#
#  Cada site é um repositório git, e o `lachat.js` está COMMITADO nele — tem de
#  estar, senão um clone novo não sobe (o `require("./lachat")` acontece no
#  boot). Sobrescrever o arquivo aqui deixaria a árvore do site suja, e o
#  `git pull` da entrega seguinte pararia com "local changes would be
#  overwritten".
#
#  Então a atualização do conector viaja pelo caminho certo: o workflow do
#  LA-Chat commita o arquivo novo NO REPOSITÓRIO de cada site, o portão de
#  testes daquele site roda, e a entrega dele leva o conector junto.
#
#  O que sobra para cá é o AVISO: dizer quem ficou para trás.
# ==========================================================================
if [ -f instalar-em.js ]; then
  echo "--- conector nos sites ---"
  node instalar-em.js --todos --conferir || true   # sai 1 quando há atraso
fi

echo "=== entrega concluída em $(date '+%d/%m/%Y %H:%M:%S') ==="
