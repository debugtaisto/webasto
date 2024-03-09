import { EventEmitter } from 'node:events'; //= require('node:events');
import bunyan from 'bunyan';
import bformat from 'bunyan-format';

class EmitStream extends EventEmitter {
  constructor() {
    super()
  }
  
  write(data) {
    var record = JSON.parse(data)
    this.emit('write', record)
  }
}

var emitter = new EmitStream()
export var log = bunyan.createLogger({
  name: 'webasto',
  streams: [
    /*{
      stream: bformat({ outputMode: 'short' }),
      level: 'debug'
    },*/
    {
      stream: emitter,
      level: 'debug'
    },
    {
      level: 'debug',
      path: './webasto.log'
    }    
  ]
});
log.emitter = emitter
