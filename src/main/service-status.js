// Tracks the health status of each external data source
// States: 'ok' | 'down' | 'rate_limited' | 'unknown'

const status = {
  steam: 'unknown',
  faceit: 'unknown',
  leetify: 'unknown',
  csstats: 'unknown',
};

const lastChange = {};

function set(service, state) {
  if (status[service] === state) return false;
  status[service] = state;
  lastChange[service] = Date.now();
  return true; // changed
}

function get() {
  return { ...status };
}

function getDown() {
  return Object.entries(status)
    .filter(([_, s]) => s === 'down' || s === 'rate_limited')
    .map(([name, s]) => ({ name, state: s }));
}

module.exports = { set, get, getDown };
