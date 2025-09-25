/* =============================================================
   agente-ia/app.js – versión para systemd
   - Config externo en config.js
   - Logs a archivo + consola con timestamps
   - Endpoints con logging
   ============================================================= */

'use strict';

const fs      = require('fs');
const path    = require('path');
const Ari     = require('ari-client');
const express = require('express');
const cfg     = require('./config');

/* ----------------- Logger mínimo (sin dependencias) ---------------- */
const logDir = path.dirname(cfg.log.file);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function ts() {
  return new Date().toISOString();
}
function write(line) {
  fs.appendFile(cfg.log.file, line + '\n', () => {});
}
function log(level, msg, meta) {
  const rec = { ts: ts(), level, msg, ...(meta || {}) };
  const line = JSON.stringify(rec);
  // archivo
  write(line);
  // consola (útil para journalctl)
  console.log(line);
}
const logger = {
  info:  (m, x) => (cfg.log.level !== 'debug' ? log('info',  m, x) : log('info', m, x)),
  debug: (m, x) => (cfg.log.level === 'debug' ? log('debug', m, x) : void 0),
  warn:  (m, x) => log('warn',  m, x),
  error: (m, x) => log('error', m, x),
};

/* ----------------- App HTTP ----------------- */
const app = express();

/* --------- Estados de llamada ------------------------------- */
const calls          = {};   // callId → {incoming, outgoing, bridge}
const pendingBridges = {};   // callId → {bridge, incoming, outgoing}

let ariClient;

/* --------- Helpers -------------------------------------- */
const getAgent = ch => {
  if (ch?.dialplan?.exten) return ch.dialplan.exten;
  const m = ch?.name?.match(/^Local\/(\d+)@/); // Local/150@...
  return m ? m[1] : 'unknown';
};

function findCall(agent) {
  return Object.entries(calls).find(([id]) => id.startsWith(agent))?.[1];
}

/* ============================================================ */
Ari.connect(cfg.ari.url, cfg.ari.user, cfg.ari.pass).then(client => {
  ariClient = client;

  /* ---------- STASIS START --------------------------------- */
  client.on('StasisStart', async (event, chanObj) => {
    const chan = chanObj?.id ? chanObj : event.channel;
    if (!chan?.id) {
      logger.warn('StasisStart sin ID', { event });
      return;
    }

    /* --- Caso: canal de reemplazo (REFER) ------------------ */
    if (event.replace_channel?.id) {
      const oldId = event.replace_channel.id;

      const callId = Object.keys(calls).find(
        id => calls[id].incoming === oldId || calls[id].outgoing === oldId
      );

      if (callId) {
        const call = calls[callId];
        const side = (call.incoming === oldId) ? 'incoming' : 'outgoing';
        call[side] = chan.id;

        try {
          const bridge = await client.bridges.get({ bridgeId: call.bridge });
          await bridge.addChannel({ channel: chan.id });
          logger.info('Canal de reemplazo añadido al bridge', { new: chan.id, old: oldId, bridge: call.bridge });
        } catch (e) {
          logger.error('Error añadiendo canal de reemplazo', { error: e.message });
        }
        return;
      }
    }

    const isOutbound = event.args?.[0] === 'outbound';

    /* ============ ENTRANTE ================================= */
    if (!isOutbound) {
      const agent  = getAgent(chan);
      const callId = `${agent}-${chan.id}`;

      logger.info('Llamada entrante', { channel: chan.id, state: chan.state, agent });

      if (chan.state === 'Ring') {
        try { await chan.answer(); logger.debug('Canal respondido', { channel: chan.id }); }
        catch (e) { logger.error('answer falló', { error: e.message }); }
      }

      const endpoint = cfg.agentEndpoints[agent] || `SIP/${agent}`;

      client.bridges.create({ type: 'mixing' }, (err, bridge) => {
        if (err) { logger.error('create bridge', { error: err.message }); return; }

        bridge.addChannel({ channel: chan.id }, err2 => {
          if (err2) { logger.error('add IN', { error: err2.message }); return; }

          pendingBridges[callId] = { bridge, incoming: chan.id, outgoing: null };
          logger.info('Bridge creado; entrante añadido', { bridge: bridge.id, callId });

          client.channels.originate({
            endpoint,
            app    : cfg.ari.app,
            appArgs: 'outbound'
          }, (err3, out) => {
            if (err3) { logger.error('originate', { error: err3.message, endpoint }); return; }
            pendingBridges[callId].outgoing = out.id;
            logger.info('Saliente originado', { out: out.id, endpoint, callId });
          });
        });
      });

    /* ============ SALIENTE ================================= */
    } else {
      const entry = Object.entries(pendingBridges).find(([, v]) => v.outgoing === chan.id);
      if (!entry) {
        logger.warn('Saliente sin bridge pendiente', { channel: chan.id });
        return;
      }
      const [callId, { bridge, incoming }] = entry;

      bridge.addChannel({ channel: chan.id }, err => {
        if (err) { logger.error('add OUT', { error: err.message }); return; }

        calls[callId] = { incoming, outgoing: chan.id, bridge: bridge.id };
        delete pendingBridges[callId];
        logger.info('Bridge listo para la llamada', { bridge: bridge.id, callId });
      });
    }
  });

  /* ---------- STASIS END ---------------------------------- */
  client.on('StasisEnd', async (_event, ch) => {
    if (!ch?.id) return;
    const id = ch.id;
    logger.info('StasisEnd', { channel: id });

    for (const callId in calls) {
      const c = calls[callId];

      if (c.incoming === id || c.outgoing === id) {
        const other = (c.incoming === id) ? c.outgoing : c.incoming;

        if (other) {
          try { await ariClient.channels.hangup({ channelId: other }); }
          catch (e) { /* ignora */ }
        }

        try { await ariClient.bridges.destroy({ bridgeId: c.bridge }).catch(() => {}); }
        finally { delete calls[callId]; }

        logger.info('Bridge destruido por fin de una pata', { bridge: c.bridge, ended: id, callId });
        break;
      }
    }

    for (const pid in pendingBridges) {
      const p = pendingBridges[pid];
      if (p.incoming === id || p.outgoing === id) {
        delete pendingBridges[pid];
        logger.debug('Pendiente limpiado', { pid });
      }
    }
  });

  /* ---------- Lanzar la aplicación ARI --------------------- */
  client.start(cfg.ari.app);
  logger.info('Conectado a ARI y escuchando StasisStart', { app: cfg.ari.app, url: cfg.ari.url });

}).catch(err => {
  logger.error('Error conectando a ARI', { error: err.message });
  process.exit(1);
});

/* ============================================================
   REST API: hold / unhold / listado
   ============================================================ */

app.post('/hold', (req, res) => {
  const agent = req.query.agent;
  const call  = findCall(agent);
  if (!call) {
    logger.warn('HOLD: no se encontró llamada para agente', { agent });
    return res.status(404).send({ error: `No se encontró llamada para ${agent}` });
  }

  logger.info('HOLD solicitado', { agent, call });

  setTimeout(() => {
    const bridgeId = call.bridge;
    Ari.connect(cfg.ari.url, cfg.ari.user, cfg.ari.pass).then(c => {
      c.bridges.get({ bridgeId }, (e, b) => {
        if (e) { logger.error('HOLD bridges.get', { error: e.message, bridgeId }); return res.status(500).send({ error: e.message }); }
        b.removeChannel({ channel: call.incoming }, () =>
          c.channels.startMoh({ channelId: call.incoming }, err =>
            err ? (logger.error('HOLD startMoh', { error: err.message }), res.status(500).send({ error: err.message }))
                : (logger.info('HOLD activado', { agent, channel: call.incoming }), res.send({ ok: true }))
          )
        );
      });
    }).catch(e => {
      logger.error('HOLD Ari.connect', { error: e.message });
      res.status(500).send({ error: e.message });
    });
  }, cfg.holdDelayMs);
});

app.post('/unhold', (req, res) => {
  const agent = req.query.agent;
  const call  = findCall(agent);
  if (!call) {
    logger.warn('UNHOLD: no se encontró llamada para agente', { agent });
    return res.status(404).send({ error: `No se encontró llamada para ${agent}` });
  }

  logger.info('UNHOLD solicitado', { agent, call });

  Ari.connect(cfg.ari.url, cfg.ari.user, cfg.ari.pass).then(c => {
    c.channels.stopMoh({ channelId: call.incoming }, () => {
      c.bridges.get({ bridgeId: call.bridge }, (e, b) => {
        if (e) { logger.error('UNHOLD bridges.get', { error: e.message }); return res.status(500).send({ error: e.message }); }
        b.addChannel({ channel: call.incoming }, () => {
          logger.info('UNHOLD completado', { agent, channel: call.incoming });
          res.send({ ok: true });
        });
      });
    });
  }).catch(e => {
    logger.error('UNHOLD Ari.connect', { error: e.message });
    res.status(500).send({ error: e.message });
  });
});

app.get('/calls', (_req, res) => {
  logger.debug('GET /calls');
  res.json(calls);
});

app.listen(cfg.api.port, cfg.api.host, () => {
  logger.info('API HTTP escuchando', { host: cfg.api.host, port: cfg.api.port });
});
