import { EventEmitter } from 'node:events';
import bunyan from 'bunyan';
import { Console } from './console.js';
import { Webasto } from './webasto.js';
import { Timer } from './utils.js';
import { Config } from './config.js'
import { log as __log } from './logger.js';

import __sprintf from 'sprintf';
var sprintf = __sprintf.sprintf

var log = __log.child({context: "Program"})

Config.program = {
  interval: {
    runtime: 20,
    retry: {
      count: 3,
      sleep: 5
    }
  }
}
Config.markup("program")

export class Program {
  static Interval = class extends Program {
    constructor(attr) {
      super()
      
      this.executing = false
      this.attr = attr
      this.timer = null
    }
    
    async execute() {
      log.info("Interval: Execute: " + JSON.stringify(this.attr))
      Console.print("Program: Interval: run: " + this.attr.run + ", sleep: " + this.attr.sleep)
      
      this.executing = true
      this.sid = null
      
      const RUNNING = 1
      const SLEEPING = 2
      var state = RUNNING
      var sleept = this.attr.sleep, retry = 0, retries = 3
      
      while (this.executing) {
        switch (state) {
          case RUNNING:
            log.info("Interval: Run: " + this.attr.run + " minutes")

            Webasto.Runner.minutes = (this.attr.run < Config.program.interval.runtime ?
              Config.program.interval.runtime : this.attr.run)
      
            Console.print("Program: Interval: Run: " + this.attr.run + " minutes")
            try {
              this.timer = new Timer(this.attr.run * 1000 * 60)
              this.timer.run(() => {
                var clock = this.timer.clock()
                Console.postfix(sprintf("%02d:%02d", clock.minutes, clock.seconds))
              }).then(() => {
                if (Webasto.Runner.running)
                  Webasto.Runner.shutdown()
                Console.postfix(null)
              })

              await Webasto.Runner.run()
              log.info("Interval: Running")
              Console.print("Program: Interval: Running")

              await Webasto.Runner.keepalive()
              log.info("Interval: Run: Completed")
              Console.print("Program: Interval: Run: Completed")

              retry = 0
              sleept = this.attr.sleep
            } catch (error) {
              log.error("Interval: Runner: Error: " + error)
              Console.print("Program: Interval: Error: " + error)

              try {
                  error = await Webasto.Errors.last()
                  Console.print("Interval: Runner: Error: " + error.msg +
                    " (0x" + error.code.toString(0x10) + ")")
              } catch (error) {
                log.error("Interval: Runner: Error querying error: " + error)
                Console.print("Program: Interval: Error querying error: " + error)
              }
              
              if (this.timer)
                await this.timer.interrupt()
              
              if (retry++ < Config.program.interval.retry.count) {
                log.info("Interval: Retry " + retry + "/" + Config.program.interval.retry.count + " in " + Config.program.interval.retry.sleep + " minutes")
                Console.print("Program: Interval: Retry " + retry + "/" + Config.program.interval.retry.count + " in " + Config.program.interval.retry.sleep + " minutes")
                sleept = Config.program.interval.retry.sleep
              }
              else {
                retry = 0
                sleept = this.attr.sleep
              }
            }

            state = SLEEPING
            break

          case SLEEPING:
            log.info("Interval: Sleep: " + sleept + " minutes")
            Console.print("Program: Interval: Sleep: " + sleept + " minutes")
            
            this.timer = new Timer(sleept * 60 * 1000)
            while (await this.timer.step()) {
              var clock = this.timer.clock()
              Console.postfix(sprintf("%02d:%02d", clock.minutes, clock.seconds))
            }
            Console.postfix(null)
            this.timer = null

            state = RUNNING
            break
        }
      }
      log.info("Interval: Execute: Completed")
      Console.print("Program: Interval: Completed")
    }
    
    async shutdown() {
      if (!this.executing)
        return
      log.info("Interval: Shutdown")
      Console.print("Program: Interval: Shutdown")
      
      this.executing = false
      if (this.timer)
        this.timer.interrupt()
      
      log.info("Interval: Shutdown complete")
      Console.print("Program: Interval: Shutdown complete")
    }
  }
  
  async interrupt() {
    if (!this.executing)
      return
    log.info("Interval: Interrupt")
    Console.print("Program: Interval: Interrupt")
    
    if (this.timer) {
      this.timer.interrupt()
    }
    
    log.info("Interval: Interrupted")
    Console.print("Program: Interval: Interrupt complete")
  }
}
