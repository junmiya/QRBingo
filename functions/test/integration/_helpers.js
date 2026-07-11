'use strict';

function uid() {
  return 'uid-' + Math.random().toString(36).slice(2, 10);
}

module.exports = { uid };
