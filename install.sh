#!/usr/bin/env bash
set -e

APP_DIR="/opt/agente-ia"
SERVICE_NAME="agente-ia"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

# Instalar Node.js si no está
if [ -z "$NODE_BIN" ] || [ -z "$NPM_BIN" ]; then
  echo "[INFO] Node.js no encontrado, instalando Node.js LTS (20) vía dnf module..."
  sudo dnf -y module reset nodejs || true
  sudo dnf -y module enable nodejs:20
  sudo dnf -y module install nodejs:20
fi

echo "[INFO] Versión de Node instalada:"
node -v
npm -v

# Crear usuario dedicado sin login
if ! id -u agenteia >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /sbin/nologin agenteia
fi

# Copiar proyecto (si vienes de git clone ya estará)
sudo mkdir -p "$APP_DIR/logs"
sudo cp -r ./app.js ./config.js ./package.json "$APP_DIR/"
# Si tienes package-lock.json, también lo copiamos
if [ -f "./package-lock.json" ]; then
  sudo cp ./package-lock.json "$APP_DIR/"
fi
sudo chown -R agenteia:agenteia "$APP_DIR"

# Instalar dependencias
cd "$APP_DIR"
if [ -f "package-lock.json" ]; then
  echo "[INFO] Instalando dependencias con npm ci (usa package-lock.json)"
  sudo -u agenteia npm ci
else
  echo "[INFO] Instalando dependencias con npm install"
  sudo -u agenteia npm install
fi

# Crear unit de systemd
sudo tee /etc/systemd/system/${SERVICE_NAME}.service >/dev/null <<EOF
[Unit]
Description=Agente IA (Asterisk ARI) – API
After=network.target asterisk.service
Wants=asterisk.service

[Service]
Type=simple
User=agenteia
Group=agenteia
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node app.js
Restart=always
RestartSec=3
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Recargar systemd y arrancar servicio
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl start  ${SERVICE_NAME}

echo "================================================="
echo " Servicio ${SERVICE_NAME} instalado y corriendo."
echo " Logs: journalctl -u ${SERVICE_NAME} -f"
echo "================================================="
