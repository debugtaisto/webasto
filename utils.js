import { log as __log } from './logger.js';

var log = __log.child({context: "Utils"})

export class Timer {
  constructor(time = 10000, attr = {step: 1000}) {
    this.attr = attr
    this.reset(time)
    this.done = null
  }
  
  async run(tick = null) {
    log.info("Timer: Run: " + this.time + " ms, step: " + this.attr.step)
    var running = true
    while (running) {
      running = await this.step()
      if (tick) tick()
    }
    log.info("Timer: Run: " + this.time + " ms elapsed")
    if (this.done)
      this.done()
    this.done = null
  }
  
  async step() {
    var s = (ms) => new Promise((r) => {
      setTimeout(r, ms)
    })
    await s(this.attr.step)
    
    this.elapsed += this.attr.step
    return (this.elapsed < this.time)
  }
  
  async interrupt() {
    log.info("Timer: Interrupt at " + this.elapsed + " ms")
    var interrupt = new Promise((resolve) => {
      this.done = resolve
    })
    this.elapsed = this.time
    await interrupt
    log.info("Timer: Interrupted")
  }
  
  reset(time) {
    this.time = time
    this.elapsed = 0
  }

  clock() {
    var minutes = Math.floor(this.elapsed / 1000 / 60)
    var seconds = Math.round(this.elapsed / 1000) - (minutes * 60)
    return {minutes: minutes, seconds: seconds}
  }
}
