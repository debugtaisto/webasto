import { SerialPort } from 'serialport'
import { EventEmitter } from 'node:events'
import bunyan from 'bunyan';
import bformat from 'bunyan-format';
import stream from 'stream';
import { Config } from './config.js'
import { log as __log } from './logger.js';

var log = __log.child({context: "Webasto"})

var wbus = null

const sleep = ms => new Promise(r => setTimeout(r, ms));

Config.webasto = {
  wbus: {
    device: "/dev/ttyUSB0",
    address: { from: 0xf, to: 0x4 }
  },
  transaction: {
    timeout: 5000,
    retry: 5
  }
}

Config.markup("webasto")

class WBusParser extends stream.Transform {
	constructor() {
		super();

    this.address = { to: Config.webasto.wbus.address.to, from: Config.webasto.wbus.address.from }
    this.address.incoming = ((this.address.to << 4) & 0xf0) | (this.address.from & 0x0f)
    this.address.outgoing = ((this.address.from << 4) & 0xf0) | (this.address.to & 0x0f)    
    this.header = Buffer.alloc(2)
		this.payload = {
		    data: null,
		    at: 0,
		    to: 0
		}
	}
	
	_transform(chunk, encoding, cb) {
    const ADDRESS = 1
    const LENGTH = 2
    const PAYLOAD = 3
    const CHECKSUM = 4

    if (this.state == undefined)
     this.state = ADDRESS

    for (var i = 0; i < chunk.length; i++) {
      var byte = chunk.readUInt8(i)

      //log.debug("Byte: " + byte.toString(0x10))
      switch (this.state) {
        case ADDRESS:
          if (byte != this.address.incoming && byte != this.address.outgoing) {
            log.error("Parser: Packet: Malformed: address: 0x" + byte.toString(0x10))      
            break // ignore
          }
          log.debug("Parser: Packet: address: 0x" + byte.toString(0x10))
          this.header.writeUint8(byte, 0)
          this.state = LENGTH
          break
        case LENGTH:
          if (byte == 0) {
            log.error("Parser: Packet: Malformed: length: " + byte.toString(10) + ", reset")      
            this.state = ADDRESS // reset
            break
          }
          log.debug("Parser: Packet: length: " + byte.toString(10))
          this.header.writeUint8(byte, 1)
          this.payload.at = 0
          this.payload.to = byte - 1
          this.payload.data = Buffer.alloc(byte)
          this.state = PAYLOAD
          break
        case PAYLOAD:
          log.debug("Parser: Packet: payload[" + this.payload.at + "]: 0x" + byte.toString(0x10))
          this.payload.data.writeUInt8(byte, this.payload.at++)
          if (this.payload.at < this.payload.to)
            break
          this.state = CHECKSUM
          break
        case CHECKSUM:
          this.payload.data[this.payload.to] = byte
          var output = Buffer.concat([this.header, this.payload.data])
          var xor = 0
          for (var i = 0; i < output.length - 1; i++)
            xor ^= output[i];
          log.debug("Parser: Packet: checksum: 0x" + byte.toString(0x10) + ", verified: 0x" +
            xor.toString(0x10) + " [" + (byte == xor ? "OK" : "FAIL") + "]")	 
          if (byte == xor) {
        	  // Ignore TTL - K-line circuit loopback packets        
            if (this.header.readUInt8(0) == this.address.outgoing)
              log.debug("Parser: Packet: Loopback, ignore")
            else
              this.push(output)
          }
          this.state = ADDRESS
          break
      }
    }
    cb();
	}

	_flush(cb) {
		cb();
	}
}


class WBus extends EventEmitter {
  constructor(dev = Config.webasto.wbus.device) {
    super()

    this.running = false

    log.info("Webasto: Opening " + dev)
    this.port = new SerialPort({
      path: dev,
      baudRate: 2400,
      stopBits: 1,
      parity: 'even'
    });

    this.port.on('error', (error) => {
      log.error("Error opening serial port: " + error)
      this.emit('error', error)
    })
    this.port.on("open", () => {
      this.emit("open")
    })

    this.buffer = []
    this.parser = this.port.pipe(new WBusParser())
    this.parser.on('data', (buffer) => {
      var packet = {
        address: { from: (buffer[0] >> 4) & 0xf, to: buffer[0] & 0xf },
        data: buffer.slice(2, buffer.length - 1)
      }
      log.debug("Read: " + JSON.stringify(packet, (key, value) => {
        if( typeof value === 'number'){
          return '0x' + value.toString(16)
        }
        return value
      }))
      this.buffer.push(packet)
      this.emit('data')	      
    })
  }
    
  async init() {
    log.info("Initialize")
    this.port.set({brk:true})
    await sleep(500)
    this.port.set({brk:false})
    await sleep(500)
  }
    
  async read(timeout = null) {
    if (this.buffer.length < 1) {
      var read = new Promise((resolve, reject) => {
        if (timeout)
          setTimeout(() => resolve(null), timeout)
        var data = () => {
          resolve(this.buffer.shift())
          this.removeListener('data', data)
        }
        this.on('data', data)
      })
      return await read
    }
    return this.buffer.shift()
  }
  
  async write(packet) {
    log.debug("Write: " + JSON.stringify(packet, (key, value) => {
    if( typeof value === 'number'){
        return '0x' + value.toString(16)
      }
      return value
    }))

    var buffer = Buffer.alloc(packet.data.length + 3)
    buffer[0] = (packet.address.from << 4) | packet.address.to;
    buffer[1] = packet.data.length + 1;
    
    for (var i = 0; i < packet.data.length; i++)
      buffer[i + 2] = packet.data[i]
    
    var xor = 0
    for (var i = 0; i < buffer.length - 1; i++)
        xor ^= buffer[i]
    buffer[packet.data.length + 2] = xor
    
    var write = new Promise((resolve, reject) => {
      this.port.write(buffer, (error) => {
        if (error) {
          log.error("Writing: " + error.message)
          reject()
        }
        else {
          resolve()
        }
      })  
    })
    await write
  }
}

class Transaction {
  static Queue = class {
    constructor() {
      this.queue = []
      this.pending = null
    }
    
    static push(transaction, resolve, reject) {
      log.debug("Transaction: Push: " + transaction)
      Transaction.Queue.self.queue.push({transaction: transaction, resolve: resolve, reject: reject})      
      Transaction.Queue.self.execute()
    }
    
    async execute() {
      if (this.pending || this.queue.length == 0)
        return
        
      this.pending = this.queue.shift()
      try {
        log.debug("Transaction: Pending: " + this.pending.transaction)
        var result = await this.pending.transaction.execute()
        log.debug("Transaction: Completed: " + this.pending.transaction)
        this.pending.resolve(result)
      } catch (error) {
        log.error("Transaction: Error: " + this.pending.transaction + ": " + error)
        this.pending.reject(error)
      } finally {
        this.pending = null
        this.execute()
      }
    }
    
    static __ref = null
    static get self() {
      if (!Transaction.Queue.__ref)
        Transaction.Queue.__ref = new Transaction.Queue()
      return Transaction.Queue.__ref
    }
  }

  constructor(packet, response) {
    this.packet = packet
    if (!this.packet.address)
      this.packet.address = Config.webasto.wbus.address
    this.response = response
  }
  
  async queue() {
    var promise = new Promise((resolve, reject) => {
      Transaction.Queue.push(this, resolve, reject)
    })
    return await promise
  }
  
  async execute() {
    log.debug("Transaction: " + this)
    
    if (!wbus)
      throw "Not initialized"

    if (this.response) {
      var retry = Config.webasto.transaction.retry, packet = null
      while (!packet && retry-- > 0) {
        await wbus.write(this.packet)
        var read = await wbus.read(Config.webasto.transaction.timeout)
        //log.debug("Transaction: read: " + JSON.stringify(read) + ", " + JSON.stringify(this.packet))
        if (read) {
          if (read.address.from == this.packet.address.to && 
              read.address.to == this.packet.address.from) {
            if (read.data[0] == 0x7f) {
              log.error("Transaction: Not acknowledged")
              throw "Not acknowledged"
            }
            if (!this.response.includes(read.data[0])) {
              log.error("Transaction: Response not recognized: 0x" + read.data[0].toString(0x10))
              throw "Response not recognized"
            }
            packet = read
          }
        }
      }
      return packet
    }
    else {
      await wbus.write(this.packet)
      return null
    }
  }
  
  toString() {
    return JSON.stringify(this.packet, (key, value) => {
      if( typeof value === 'number'){
        return '0x' + value.toString(16)
      }
      return value
    })
  }
}

class Runner {
  static ParkingHeater = {
    run: { 
      request: 0x21, 
      response: 0xa1
    }, 
    keepalive: { 
      request: 0x21, 
      response: 0xc1
    }
  }
  
  static SupplementHeater = {
    run: { 
      request: 0x23, 
      response: 0xa3
    }, 
    keepalive: { 
      request: 0x23, 
      response: 0xc4
    }
  }

  static Boost = {
     run: { 
      request: 0x25, 
      response: 0xa5
    }, 
    keepalive: { 
      request: 0x25, 
      response: 0xc5
    }
  }
  
  static running = false
  static minutes = false
  static profile = Runner.SupplementHeater
  
  constructor() {
    throw "Static"
  }
  
  static async run() {
    if (Runner.running)
      throw "Already running"
  
    log.info("Runner: Running: " + Runner.minutes + " minutes")
    
    var startup = new Transaction({
        //address: { from: 0xf, to: 0x4 },
        data: [ Runner.profile.run.request, Runner.minutes & 0xff ]
      }, [ Runner.profile.run.response ])
    
    var packet = await startup.queue()
    if (!packet) {
      log.error("Run failed to execute")
      throw "Run failed to execute"
    }
    
    if (packet.data[0] == Runner.profile.run.response) {
      Runner.running = true
      log.info("Runner: Running")
    }
  }
  
  static async keepalive() {
    log.info("Runner: Keepalive")
    
    var keepalive = new Transaction({
        //address: { from: 0xf, to: 0x4 },
        data: [ 0x44, Runner.profile.keepalive.request, 0x00 ]
      }, [ Runner.profile.keepalive.response ])
    
    while (Runner.running) {
      var packet = await keepalive.queue()
      if (!packet) {
        log.error("Keepalive failed to execute")
        throw "Keepalive failed to execute"
      }
      
      Runner.running = (packet.data[1] == 0x0)
      log.info("Runner: Running: " + Runner.running)
      if (!Runner.running) {
        if (packet.data[1] != 0x01) {
          log.error("Runner: Completed with: 0x" + packet.data[1].toString(0x10))
          throw "Completed with: 0x" + packet.data[1].toString(0x10)
        }
        log.info("Runner: Completed")
      }
      await sleep(12000)
    }
  }
  
  static async shutdown() {
    log.info("Runner: Shutdown")
    if (!Runner.running)
      throw "Not running"
        
    var shutdown = new Transaction({
        //address: { from: 0xf, to: 0x4 },
        data: [ 0x10 ]
      }, [ 0x90 ])
    
    var packet = await shutdown.queue()
    if (!packet) {
      log.error("Runner: Shutdown failed to execute")
      throw "Shutdown failed to execute"
    }
    log.info("Runner: Shutdown complete")
  }
}

class Errors extends EventEmitter {
  static codev = [
    {code:0x01, msg:"Defective control unit"},
    {code:0x02, msg:"No start"},
    {code:0x03, msg:"Flame failure"},
    {code:0x04, msg:"Supply voltage too high"},
    {code:0x05, msg:"Flame was detected prior to combustion"},
    {code:0x06, msg:"Heating unit overheated"},
    {code:0x07, msg:"Heating unit interlocked"},
    {code:0x08, msg:"Metering pumpu short circuit"},
    {code:0x09, msg:"Combustion air fan short circuit"},
    {code:0x0a, msg:"Glow plug/flame monitor short circuit"},
    {code:0x0b, msg:"Circulation pump short circuit"},
    {code:0x0c, msg:"No comunication to air condition"},
    {code:0x0d, msg:"Green LED short circuit"},
    {code:0x0e, msg:"Yellow LED short circuit"},
    {code:0x0f, msg:"No configuraton signal"},
    {code:0x10, msg:"Solenoid valve short circuit"},
    {code:0x11, msg:"ECU wrong coded"},
    {code:0x12, msg:"W-Bus comunication failure"},
    {code:0x13, msg:"Vehicle fan relay short circuit"},
    {code:0x14, msg:"Temperature sensor short circuit"},
    {code:0x15, msg:"Combustion air fan blocked"},
    {code:0x16, msg:"Battery main switch short circuit"},
    {code:0x17, msg:"Invalid air flow reduction"},
    {code:0x18, msg:"Comunication failure on customer specific bus"},
    {code:0x19, msg:"Glow plug/electronic ignition short circuit"},
    {code:0x1a, msg:"Flame sensor short circuit"},
    {code:0x1b, msg:"Overheat short circuit"},
    {code:0x1c, msg:"Fault 28"},
    {code:0x1d, msg:"Solenoid valve shed test short circuit"},
    {code:0x1e, msg:"Fuel sensor short circuit"},
    {code:0x1f, msg:"Nozzle stock heating short circuit"},
    {code:0x20, msg:"Operation indicator short circuit"},
    {code:0x21, msg:"Flame indicator short circuit"},
    {code:0x22, msg:"Reference resistance wrong"},
    {code:0x23, msg:"Crash interlock activated"},
    {code:0x24, msg:"Car is almost out of fuel"},
    {code:0x25, msg:"Fuel pre heating short circuit"},
    {code:0x26, msg:"PCB temperatur sensor short circuit"},
    {code:0x27, msg:"Ground contact to the ECU broken"},
    {code:0x28, msg:"Board net energy manager low power voltage"},
    {code:0x29, msg:"Fuel priming still not done"},
    {code:0x2a, msg:"Error in the radio telegram"},
    {code:0x2b, msg:"Telestart still not programmed"},
    {code:0x2c, msg:"The pressure sensor has short circuit"},
    {code:0x2d, msg:"Fault 45"},
    {code:0x31, msg:"Fault 49"},
    {code:0x32, msg:"No start from control idle period"},
    {code:0x33, msg:"Flame monitor signal invalid"},
    {code:0x34, msg:"Default values entered"},
    {code:0x35, msg:"EOL programming has not been carried out"},
    {code:0x36, msg:"Thermal fuse short circuit"},
    {code:0x37, msg:"Fault 55"},
    {code:0x4f, msg:"Fault 79"},
    {code:0x50, msg:"User interface idle-Mode (no-communication)"},
    {code:0x51, msg:"User interface has communication fault"},
    {code:0x52, msg:"User interface send no defined operating mode"},
    {code:0x53, msg:"Heater fan status message negative"},
    {code:0x54, msg:"Heater fan status bus has short circuit to UB"},
    {code:0x55, msg:"Temperature water sensor failure"},
    {code:0x56, msg:"Temperature water sensor short circuit to UB"},
    {code:0x57, msg:"Overheating water temperature sensor"},
    {code:0x58, msg:"Overstepping water temperature sensor gradient"},
    {code:0x59, msg:"Overheating blow temperature sensor"},
    {code:0x5a, msg:"Overstepping low temperature sensor gradient"},
    {code:0x5b, msg:"Overheating printed circuit board temperature sensor"},
    {code:0x5c, msg:"Overstepping printed circuit board temp sensor gradient"},
    {code:0x5d, msg:"Cabin temperature sensor failure"},
    {code:0x5e, msg:"Flame detector gradient failure"},
    {code:0x5f, msg:"Emergency cooling"},
    {code:0x60, msg:"Customer specific fault 1"},
    {code:0x7f, msg:"Customer specific fault 32"},
    {code:0x80, msg:"Fault 128"},
    {code:0x81, msg:"EOL checksum error"},
    {code:0x82, msg:"No start during test-run"},
    {code:0x83, msg:"Flame failure"},
    {code:0x84, msg:"Operating voltage too low"},
    {code:0x85, msg:"Flame was detected after combustion"},
    {code:0x86, msg:"Fault 134"},
    {code:0x87, msg:"Heater lock-out permanent"},
    {code:0x88, msg:"Fuel pump failure"},
    {code:0x89, msg:"Combustion air fan interruption"},
    {code:0x8a, msg:"Glow plug / flame monitor interruption"},
    {code:0x8b, msg:"Circulation pump interruption"},
    {code:0x8c, msg:"Fault 140"},
    {code:0x8d, msg:"Green LED interruption"},
    {code:0x8e, msg:"Yellow LED interruption"},
    {code:0x8f, msg:"Fault 143"},
    {code:0x90, msg:"Solenoid valve interruption"},
    {code:0x91, msg:"Control unit locked or coded as neutral"},
    {code:0x92, msg:"Command refresh failure"},
    {code:0x93, msg:"Fault 147"},
    {code:0x94, msg:"Temperature sensor interruption"},
    {code:0x95, msg:"Combustion air fan tight"},
    {code:0x96, msg:"Fault 150"},
    {code:0x97, msg:"Overheat sensor position wrong"},
    {code:0x98, msg:"Fault 152 (Power supply interruption)"},
    {code:0x99, msg:"Glow plug / electronic ignition unit interruption"},
    {code:0x9a, msg:"Flame sensor interruption"},
    {code:0x9b, msg:"Setpoint transmitter invalid"},
    {code:0x9c, msg:"Intelligent undervoltage detection"},
    {code:0x9d, msg:"Solenoid valve shed test interruption"},
    {code:0x9e, msg:"Fuel sensor interruption"},
    {code:0x9f, msg:"Nozzle stock heating interruption"},
    {code:0xa0, msg:"Operating indicator interruption"},
    {code:0xa1, msg:"Flame indicator interruption"},
    {code:0xa2, msg:"Fault 162"},
    {code:0xa4, msg:"Fault 164"},
    {code:0xa5, msg:"Fuel pre heating interruption"},
    {code:0xa6, msg:"PCB temperature sensor interruption"},
    {code:0xa7, msg:"Fault 167"},
    {code:0xa8, msg:"Communication board net energy manager error"},
    {code:0xa9, msg:"Fault 169"},
    {code:0xaa, msg:"Send on W-Bus not succeed"},
    {code:0xab, msg:"Overheat sensor interruption"},
    {code:0xac, msg:"The pressure sensor failure"},
    {code:0xad, msg:"Fault 173"},
    {code:0xb5, msg:"Fault 181"},
    {code:0xb6, msg:"Thermal fuse interrupted"},
    {code:0xb7, msg:"Fault 183"},
    {code:0xd0, msg:"Fault 208"},
    {code:0xe0, msg:"Customer specific fault 33"},
    {code:0xfe, msg:"Customer specific fault 63"},
    {code:0xff, msg:"Unknown error code"}
]

  constructor() {
    throw "Static"
  }
  
  static msg(code) {
    for (var c of Errors.codev) {
      if (c.code == code)
        return c.msg
    }
    return null
  }
  
  static async last() {
    log.info("Errors: Last")
    
    var query = new Transaction({
        //address: { from: 0xf, to: 0x4 },
        data: [ 0x56, 0x04 ]
      }, [ 0xd6 ])
    
    var packet = await query.queue()
    if (!packet) {
      log.error("Query failed to execute")
      throw "Query failed to execute"
    }
    
    if (packet.data[0] == 0xd6 && packet.data[1] == 0x04) {
      var error = {code: packet.data[2], msg: Errors.msg(packet.data[2])}
      log.info("Error code: 0x" + error.code.toString(0x10))
      return error
    }
    return null
  }
  
  static async list() {
    log.info("Errors: List")
    
    var query = new Transaction({
        //address: { from: 0xf, to: 0x4 },
        data: [ 0x56, 0x01 ]
      }, [ 0xd6 ])
    
    var packet = await query.queue()
    if (!packet) {
      log.error("Query failed to execute")
      throw "Query failed to execute"
    }
    
    if (packet.data[0] == 0xd6 && packet.data[1] == 0x01) {
      log.info("Error list: count: " + packet.data[2])
      
      var list = []
      for (var i = 0; i < packet.data[2]; i++) {
        var j = 3 + (i * 2)
        var error = {code: packet.data[j], count: packet.data[j + 1],
          msg: Errors.msg(packet.data[j])}
        log.info("Error " + (i + 1) + ": code: 0x" + error.code.toString(0x10) +
          ", count: " + error.count + ", msg: " + error.msg)
        list.push(error)
      }
      return list
    }
    return null
  }
  
  static async erase() {
    log.info("Errors: Erase")
    
    var erase = new Transaction({
        //address: { from: 0xf, to: 0x4 },
        data: [ 0x56, 0x03 ]
      }, [ 0xd6 ])
    
    var packet = await erase.queue()
    if (!packet) {
      log.error("Erase failed to execute")
      throw "Erase failed to execute"
    }
    
    if (packet.data[0] == 0xd6 && packet.data[1] == 0x03) {
      log.info("Errors erased")
    }
  }
}

class Raw {
  constructor() {
    throw "Static"
  }
  
  static async raw(data, response) {
    log.info("Raw")
    
    var raw = new Transaction({
      //address: { from: 0xf, to: 0x4 },
      data: data
    }, response)
    
    var packet = await raw.queue()
    if (response) {
      if (!packet) {
        log.error("Raw: Expected response")
        throw "Expected response"
      }
      return packet.data
    }
    return null
  }
}

class Variable {
  static Text = class extends Variable {
    constructor() {
      super()
    }
    
    convert(data) {
      this.str = String.fromCharCode(...data)
      return this
    }
  }

  static Regex = class extends Variable {
    constructor(regex) {
      super()
      this.regex = regex
    }
    
    convert(data) {
      this.str = String.fromCharCode(...data)
      this.str = this.str.match(this.regex)
      return this
    }
  }

  static Version = class extends Variable {
    constructor(index) {
      super()
      this.index = index
    }
    
    convert(data) {
      if (data.length > this.index)
        this.str = ((data[this.index] >> 4) & 0xf) + "." + (data[this.index] & 0xf)    
      return this
    }
  }
  
  convert(data) {
    this.data = data
    this.str = ""
    for (var byte of data) {
      this.str += "0x" + byte.toString(0x10) + " "
    }
    this.str = this.str.trim()
    return this
  }
  
  text() {
    return this.str
  }
}

class Query {
  static WBusCode = class extends Variable {
    static bytev = [
      [
        {mask: 0x01, text: "Unknown"},
        {mask: 0x08, text: "On/off control"},
        {mask: 0x10, text: "Parking heater"},
        {mask: 0x20, text: "Supplement heater"},
        {mask: 0x40, text: "Ventilation"},
        {mask: 0x80, text: "Boost"}
      ],
      [
        {mask: 0x02, text: "External circulation pump control"},
        {mask: 0x04, text: "Combustion air fan"},
        {mask: 0x08, text: "Glow plug"},
        {mask: 0x10, text: "Fuel pump"},
        {mask: 0x20, text: "Circulation pump"},
        {mask: 0x40, text: "Vechile fan relay"},
        {mask: 0x80, text: "Yellow LED"}
      ],
      [
        {mask: 0x01, text: "Green LED"},
        {mask: 0x02, text: "Spark transmitter"},
        {mask: 0x04, text: "Solenoid valve"},
        {mask: 0x08, text: "AUX drive indicator"},
        {mask: 0x10, text: "Generator signal D+"},
        {mask: 0x20, text: "Combustion fan level in RPM"}
      ],
      [
        {mask: 0x02, text: "CO2 calibration"},
        {mask: 0x08, text: "Operation indicator"}
      ],
      [
        {mask: 0x10, text: "Heat power in watts"},
        {mask: 0x40, text: "Flame indicator"},
        {mask: 0x80, text: "Nozzle stock heating"}
      ],
      [
        {mask: 0x20, text: "Ingnition flag"},
        {mask: 0x40, text: "Temperature threshold available"},
        {mask: 0x80, text: "Fuel prewarming resistance and power readable"}
      ],
      [
        {mask: 0x02, text: "Set flame detector resistance, set combustion fan revolutions, set output temperature"}
      ]
    ]
    
    constructor() {
      super()
    }
    
    convert(data) {
      this.results = []
      for (var index in Query.WBusCode.bytev) {
        if (data.length <= index)
          break
          
        var byte = Query.WBusCode.bytev[index]
        for (var bit of byte) {
          this.results.push({val: (data[index] & bit.mask) > 0, text: bit.text})
        }
      }
      return this
    }
    
    boolv() {
      return this.results
    }
  }

  static variablev = [
    {code: 0x01, id: "DEVID", text: "Device ID"},
    {code: 0x02, id: "HWVER", text: "Hardware version"},
    {code: 0x03, id: "DATAID", text: "Data set ID"},
    {code: 0x04, id: "CUDATE", text: "Control unit manufacturing date"},
    {code: 0x05, id: "HDATE", text: "Heater manufacturing date"},
    {code: 0x07, id: "CUSTID", text: "Customer ID"},
    {code: 0x09, id: "SERIALNO", text: "Serial number"},
    {code: 0x0a, id: "WBUSVER", text: "W-BUS version", value: new Variable.Version(2)},
    {code: 0x0b, id: "DEVNAME", text: "Device name", value: new Variable.Regex(/\w+/g)},
    {code: 0x0c, id: "WBUSCODE", text: "W-BUS code", value: new Query.WBusCode()}
  ]
  
  constructor() {
    throw "Static"
  }
  
  static text(id) {
    for (var v of Query.variablev) {
      if (v.id == id)
        return v.text
    }
    return null
  }
  
  static async query(id) {
    var variable = null
    for (var v of Query.variablev) {
      if (id == v.id) {
        variable = v
        break
      }
    }
    
    if (!variable)
      throw "Unknown variable: " + id
      
    var query = new Transaction({
      //address: { from: 0xf, to: 0x4 },
      data: [0x51, variable.code]
    }, [0xd1])
    
    var packet = await query.queue()
    if (!packet) {
      log.error("Query: Failed to execute")
      throw "Failed to execute"
    }
    
    if (variable.value) {
      return variable.value.convert(packet.data)
    }
    return (new Variable()).convert(packet.data)
  }  
}

export class Webasto extends EventEmitter {
  static Runner = Runner
  static Errors = Errors
  static Query = Query
  static Raw = Raw
  
  static Events = new EventEmitter()
  
  constructor() {
    throw "Static"
  }
  
  static async __init() {
    await Webasto.Raw.raw([0x51, 0x0a], [0xd1])
    await Webasto.Raw.raw([0x51, 0x0b], [0xd1])
    await Webasto.Raw.raw([0x51, 0x0c], [0xd1])
    await Webasto.Raw.raw([0x38], [0xb8])
  }
  
  static init(dev) {
    log.info("Initializing Webasto")
    
    wbus = new WBus(dev)
    wbus.on("open", () => {
      wbus.init().then(() => {
        Webasto.__init().then(() => {
          Webasto.Events.emit("init")
        }).catch((error) => {
          Webasto.Events.emit("error", error)
        })
      })
    })
    wbus.on("error", (error) => {
      Webasto.Events.emit("error", error)
    })
  }
}