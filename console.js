import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import escapes from 'ansi-escapes';
import chalk from 'chalk';
import bunyan from 'bunyan';
import { log as __log } from './logger.js';

var log = __log.child({context: "Console"})

export class Console {
  static Prompt = class extends EventEmitter {
    constructor(attr) {
      super()
      
      this.attr = attr
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "",
        completer: (line) => {
          if (!this.query)
            return null
          var query = this.query(line)
          var last = ""
          if (query.argv.length > 0)
            last = query.argv.pop()
          if (query.optv.length > 1)
            return [query.optv, last]
          if (query.optv.length > 0)
            return [[query.optv[0] + " "], last]
          return [[], last]
        }
      });
      
      this.rl.on('line', (line) => {
        this.emit('line', line.trim())
        this.prompt(true)
      })
      
      this.rl.on('close', () => {
        console.log("Closing.")
        process.exit(0);
      });
      
      this.query = null
     
      this.prompt()
    }
    
    prompt() {
      var prompt = ""
      if (this.attr.prefix)
        prompt += "(" + this.attr.prefix + ")"
      prompt += chalk.bold("[") + chalk.white(this.attr.name) + chalk.bold("]")
      if (this.attr.postfix)
        prompt += "(" + this.attr.postfix + ")"
      prompt += "# "
      this.rl.setPrompt(prompt)
      this.rl.prompt(true)
    }

    print(str) {
      this.rl.output.write(escapes.eraseLine)
      this.rl.output.write(escapes.cursorLeft)
      this.rl.output.write(str + "\n")  
      this.prompt()
    }
  }
  
  constructor() {
    this.prompt = new Console.Prompt({name: "webasto"})
  }
  
  static print(str, fw) {
    Console.self.prompt.print(str, fw)
  }
  
  static on(event, cb) {
    Console.self.prompt.on(event, cb)
  }
  
  static query(query) {
    Console.self.prompt.query = query
  }

  static prefix(str) {
    Console.self.prompt.attr.prefix = str
    Console.self.prompt.prompt()
  }

  static postfix(str) {
    Console.self.prompt.attr.postfix = str
    Console.self.prompt.prompt()
  }
  
  static __self = null
  static get self() {
    if (!Console.__self)
      Console.__self = new Console()
    return Console.__self
  } 
}
