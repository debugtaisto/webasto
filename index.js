import { EventEmitter } from 'node:events';
import bunyan from 'bunyan';
import { Console } from './console.js';
import { Commands } from './command.js';
import { log as __log } from './logger.js';

var log = __log.child({context: "Index"})

Console.on('line', (str) => {
  Commands.execute(Commands.parse(str))
})

Console.query((line) => {
  var argv = Commands.parse(line)
  var optv = Commands.query(argv)
  return { optv: optv, argv: argv }
})