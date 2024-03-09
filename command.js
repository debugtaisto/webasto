import { EventEmitter } from 'node:events';
import bunyan from 'bunyan';
import { Console } from './console.js';
import { Webasto } from './webasto.js';
import { Program } from './program.js';
import { Config } from './config.js'
import __sprintf from 'sprintf';
import { log as __log } from './logger.js';

var sprintf = __sprintf.sprintf

var log = __log.child({context: "Command"})

class Command {
  constructor(name = null, help = "") {
    this.name = name
    this.help = help
    this.commands = []
  }
  
  push(cmd) {
    this.commands.push(cmd)
  }
  
  execute() {
    for (var cmd of this.commands) {
      if (arguments[0] === cmd.name) {
        var argv = [...arguments]
        argv.shift()

        cmd.execute(...argv)
        return
      }
    }    
  }
  
  query(argv) {
    //log.debug("Querying: " + argv[0])
    var result = []
    for (var cmd of this.commands) {
      if (argv.length == 0 || cmd.name.startsWith(argv[0])) {
        //log.debug("Pushing: " + cmd.name)
        result.push(cmd.name)
      }
      if (argv[0] === cmd.name) {
        //log.debug("Directed: " + cmd.name)
        argv.shift()
        return cmd.query(argv)
      }
    }  
    return result
  }
}

export class Commands {
  static Init = class extends Command {
    constructor() {
      super("init")
    }
    
    execute(dev = Config.webasto.wbus.device) {
      Console.print("Init: Opening " + dev)
      
      Webasto.Events.on("init", () => {
        Console.print("Init: Completed")
      })
      Webasto.Events.on("error", (error) => {
        Console.print("Init: Error: " + error)
      })
      Webasto.init(dev)
    }
  }
  
  static Raw = class extends Command {
    static Write = class extends Command {
      constructor() {
        super("write")
      }
      
      execute() {
        var reqstr = ""
        var request = []
        for (var str of arguments) {
          var val = parseInt(str, 0x10)
          reqstr += "0x" + val.toString(0x10) + " "
          request.push(val)          
        }
        
        Console.print("Raw: Request: " + reqstr.trim())
                
        Webasto.Raw.raw(request).then((result) => {
          var str = ""
          for (var value of result) {
            str += "0x" + value.toString(0x10) + " "
          }
          Console.print("Raw: Response: " + str)
        }).catch((error) => {
          Console.print("Raw: Error: " + error)
        })
      }
    }
    
    static Transact = class extends Command {
      constructor() {
        super("transact")
      }
      
      execute() {
        var argv = [...arguments]

        if (argv.length < 1) {
          Console.print("Raw: Request expected")
          return
        }
        
        var reqstr = ""
        var request = []
        while (argv.length > 0 && argv[0] != ":") {
          var val = parseInt(argv[0], 0x10)
          reqstr += "0x" + val.toString(0x10) + " "
          request.push(val)          
          argv.shift()
        }
        argv.shift()

        if (argv.length < 1) {
          Console.print("Raw: Response expected")
          return
        }
        
        var resstr = ""
        var response = []
        for (var str of argv) {
          var val = parseInt(str, 0x10)
          resstr += "0x" + val.toString(0x10) + " "
          response.push(val)          
        }
        
        Console.print("Raw: Request: " + reqstr.trim() + ", Response: " + resstr.trim())
          
        Webasto.Raw.raw(request, response).then((result) => {
          var str = ""
          for (var value of result) {
            str += "0x" + value.toString(0x10) + " "
          }
          Console.print("Raw: Response: " + str)
        }).catch((error) => {
          Console.print("Raw: Error: " + error)
        })
      }
    }
    
    constructor() {
      super("raw")
      
      this.push(new Commands.Raw.Write())
      this.push(new Commands.Raw.Transact())
    }
  }
  
  static Query = class extends Command {
    static List = class extends Command {
      constructor() {
        super("list")
      }
      
      execute() {
        for (var v of Webasto.Query.variablev) {
          Console.print(sprintf("Query: List: %20s: %s", v.id, v.text))
        }
      }
    }
    
    static Variable = class extends Command {
      constructor() {
        super("variable")
      }
      
      execute(id) {
        if (!id) {
          Console.print("Query: Variable: Expected id")
          return
        }

        //Console.print("Query: Variable: " + id)
        Webasto.Query.query(id).then((result) => {
          if (result.boolv) {
            Console.print("Query: Variable: " + Webasto.Query.text(id))
            var results = result.boolv()
            for (var r of results) {
              var text = r.text.substring(0, 40)
              Console.print(sprintf("Query: Variable:   %40s: %s", text, (r.val ? "True" : "False")))
            }
          }
          else {
            Console.print("Query: Variable: " + Webasto.Query.text(id) + ": " + result.text())
          }
        }).catch((error) => {
          Console.print("Query: Variable: Error: " + error)
        })
      }
    }
  
    constructor() {
      super("query")
      
      this.push(new Commands.Query.List())
      this.push(new Commands.Query.Variable())      
    }
  }
  
  static Errors = class extends Command {
    static Erase = class extends Command {
      constructor() {
        super("erase")
      }
      
      execute() {
        Console.print("Erasing error codes")
        Webasto.Errors.erase().then(() => {
          Console.print("Errors erased")
        }).catch((error) => {
          Console.print("Error erasing errors: " + error)
        })
      }
    }
    
    static Last = class extends Command {
      constructor() {
        super("last") 
      }
      
      execute() {
        Console.print("Querying error code")
        Webasto.Errors.last().then((error) => {
          Console.print("Error: " + error.msg +
             " (0x" + error.code.toString(0x10) + ")")
        }).catch((error) => {
          Console.print("Error querying error: " + error)
        })
      }
    }
    
    static List = class extends Command {
      constructor() {
        super("list")
      }
      
      execute() {
        Console.print("Querying error codes")
        Webasto.Errors.list().then((errorv) => {
          Console.print("Errors: " + errorv.length + " errors")
          for (var i in errorv) {
            var e = errorv[i]
            Console.print("Error " + i + ": " + e.msg +
               " (0x" + e.code.toString(0x10) + "), " + e.count + " times")
          }
        }).catch((error) => {
          Console.print("Error querying error: " + error)
        })
      }
    }
    
    constructor() {
      super("errors")
      
      this.push(new Commands.Errors.Erase())
      this.push(new Commands.Errors.Last())
      this.push(new Commands.Errors.List())
    }
  }
  
  static Runner = class extends Command {
    static Run = class extends Command {
      constructor() {
        super("run")
      }
      
      execute(minutes) {
        if (minutes)
          Webasto.Runner.minutes = parseInt(minutes)
        Console.print("Runner: Running for " + Webasto.Runner.minutes + " minutes")
        
        Webasto.Runner.run().then(() => {
          Console.print("Runner: Running")
          Webasto.Runner.keepalive().then(() => {
            Console.print("Runner: Running completed")
          }).catch((error) => {
            Console.print("Runner: Keepalive: Error: " + error)
            
            Webasto.Errors.last().then((error) => {
              Console.print("Runner: Error: " + error.msg +
                 " (0x" + error.code.toString(0x10) + ")")
            }).catch((error) => {
              Console.print("Runner: Error querying error: " + error)
            })
          })
        }).catch((error) => {
          Console.print("Runner: Running: Error: " + error)
        })
      }
    }
    
    static Shutdown = class extends Command {
      constructor() {
        super("shutdown")
      }
      
      execute() {
        Console.print("Runner: Shutdown")
        Webasto.Runner.shutdown().then(() => {
          Console.print("Runner: Shutdown completed")
        }).catch((error) => { 
          Console.print("Runner: Shutdown: Error: " + error)
        })
      }
    }
    
    constructor() {
      super("runner")
      
      this.push(new Commands.Runner.Run())
      this.push(new Commands.Runner.Shutdown())
    }
  }
  
  static Program = class extends Command {
    static Interval = class extends Command {
      static Run = class extends Command {
        constructor(program) {
          super("run")
          
          this.program = program
        }
        
        execute(run, sleep) {
          if (run)
            this.program.attr.run = parseInt(run)
          if (sleep)
            this.program.attr.sleep = parseInt(sleep)
            
          log.info("Command: Program: Interval: Run")
         
          this.program.execute().then(() => {
            log.info("Command: Program: Interval: Completed")
          }).catch((error) => { 
            log.info("Command: Program: Interval: Error: " + error)
          })
        }
      }
      
      static Shutdown = class extends Command {
        constructor(program) {
          super("shutdown")
          
          this.program = program
        }
        
        execute() {
          log.info("Command: Program: Interval: Shutdown")
          this.program.shutdown().then(() => {
            log.info("Command: Program: Interval: Shutdown completed")
          }).catch((error) => { 
            log.info("Command: Program: Interval: Error: " + error)
          })
        }        
      }
      
      static Interrupt = class extends Command {
        constructor(program) {
          super("interrupt")
          
          this.program = program
        }
        
        execute() {
          log.info("Command: Program: Interval: Interrupt")
          this.program.interrupt().then(() => {
            log.info("Command: Program: Interval: Interrupted")
          }).catch((error) => { 
            log.info("Command: Program: Interval: Error: " + error)
          })
        }        
      }     
      
      constructor() {
        super("interval")
        
        this.program = new Program.Interval({run: 20, sleep: 20})
        
        this.push(new Commands.Program.Interval.Run(this.program))
        this.push(new Commands.Program.Interval.Shutdown(this.program))
        this.push(new Commands.Program.Interval.Interrupt(this.program))
      }
    }
    
    constructor() {
      super("program")
      
      this.push(new Commands.Program.Interval())
    }
  }
    
  static Quit = class extends Command {
    constructor() {
      super("quit")
    }
    
    execute() {
      log.info("Quit")
      process.exit(0)
    }
  }
  
  static Root = class extends Command {
    constructor() {
      super()
      
      this.push(new Commands.Init())
      this.push(new Commands.Raw())
      this.push(new Commands.Query())
      this.push(new Commands.Errors())
      this.push(new Commands.Runner())
      this.push(new Commands.Program())
      this.push(new Commands.Quit())
    }
  }
   
  static __ref = null
  constructor() {
    if (Commands.__ref)
      throw "Signleton"
    Commands.__ref = this
    this.root = new Commands.Root()
  }
  
  static get ref() {
    if (!Commands.__ref)
      return new Commands()
    return Commands.__ref
  }
  
  static parse(str) {
    return str.split(/\s+/)
  }
    
  static query(argv) {
    return Commands.ref.root.query(argv)
  }
  
  static execute(argv) {
    return Commands.ref.root.execute(...argv)
  }
}

