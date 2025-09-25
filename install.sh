#!/usr/bin/env bash
set -e

APP_DIR="/opt/agente-ia"
SERVICE_NAME="agente-ia"

# Directorio ORIGEN: donde está este script
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

echo "[INFO] Origen: $SRC_DIR"
echo "[INFO] Destino: $APP_DIR"

# 1) Node.js LTS (20) en Rocky/EL mediante dnf module
if [ -z "$NODE_BIN" ] || [ -z "$NPM_BIN" ]; then
  echo "[INFO] Node.js no encontrado, instalando Node.js LTS (20) vía dnf module..."
  sudo dnf -y module reset nodejs || true
  sudo dnf -y module enable nodejs:20
  sudo dnf -y module install nodejs:20
fi

echo "[INFO] Versiones instaladas:"
node -v
npm -v

# 2) Usuario de servicio sin login
if ! id -u agenteia >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /sbin/nologin agenteia
fi

# 3) Crear carpeta destino
sudo mkdir -p "$APP_DIR/logs"

# 4) Copiar código si el origen NO es el destino
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  echo "[INFO] Copiando archivos del proyecto..."
  if command -v rsync >/dev/null 2>&1; then
    sudo rsync -a --delete \
      --exclude '.git' \
      --exclude 'node_modules' \
      --exclude 'logs' \
      "$SRC_DIR"/ "$APP_DIR"/
  else
    sudo cp -r "$SRC_DIR"/* "$APP_DIR"/
  fi
else
  echo "[INFO] Origen y destino son iguales. No se copian archivos."
fi

# 5) Copiar package-lock.json si existe en origen y falta en destino
if [ -f "$SRC_DIR/package-lock.json" ] && [ ! -f "$APP_DIR/package-lock.json" ]; then
  sudo cp "$SRC_DIR/package-lock.json" "$APP_DIR/"
fi

# 6) Propietario: usuario de servicio
sudo chown -R agenteia:agenteia "$APP_DIR"

# 7) Instalar dependencias (usa npm ci si hay lockfile)
cd "$APP_DIR"
if [ -f "package-lock.json" ]; then
  echo "[INFO] Instalando dependencias con npm ci (usa package-lock.json)"
  sudo -u agenteia npm ci
else
  echo "[INFO] Instalando dependencias con npm install"
  sudo -u agenteia npm install
fi

# 8) Crear unit de systemd
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

# 9) Habilitar y arrancar
sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}

echo "================================================="
echo " Servicio ${SERVICE_NAME} instalado y corriendo."
echo " Ver estado:    systemctl status ${SERVICE_NAME} --no-pager -l"
echo " Ver logs:      journalctl -u ${SERVICE_NAME} -f"
echo "================================================="
