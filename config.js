// config.js
'use strict';

/**
 * Todo lo configurable vive aquí (valores fijos).
 * Si luego quieres parametrizar por servidor, se puede,
 * pero esta versión NO usa variables de entorno.
 */
module.exports = {
  // ARI / Asterisk
  ari: {
    url: 'http://localhost:8088',
    user: 'ari_user',
    pass: 'ari_password',
    app:  'agenteIA'
  },

  // API HTTP
  api: {
    host: '0.0.0.0',
    port: 3000
  },

  // Delay del HOLD (ms)
  holdDelayMs: 3000,

  // Endpoints por agente
  agentEndpoints: {
    // '150' : 'SIP/150',
    '80000': 'SIP/AgentesVirtuales/+573009138918',
    '90000': 'SIP/AgentesVirtuales/+573172120010',
    '60000': 'SIP/AgentesVirtuales/+573475889789'
    // ...agrega más si necesitas
  },

  // Logging
  log: {
    level: 'info',                                   // info | debug | warn | error
    file:  '/opt/agente-ia/logs/agente-ia.log'       // ruta coherente con install.sh
  }
};
