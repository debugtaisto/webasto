import fs from 'fs'
import { log as __log } from './logger.js';

var log = __log.child({context: "Config"})

export class Config {
    static scopes = []
    static export(file) {
      log.info("Config: Export: '" + file + "'")
      var root = {}
      for (var scope of Config.scopes)
        root[scope] = Config[scope]
  
      var str = JSON.stringify(root)
      fs.writeFileSync(file, str)
    }
    static build(node, input) {
      if (!input)
        return
      for (var name in node) {
        if (node[name] instanceof Object)
          Config.build(node[name], input[name])
        else
          node[name] = input[name]
        //log.debug("Item: " + JSON.stringify(node[name]))
      }
    }
    static import(file) {
      if (!fs.existsSync(file))
        return
      log.info("Config: Import: '" + file + "'")
      var str = fs.readFileSync(file)
      var root = JSON.parse(str)
      for (var scope of Config.scopes) {
        //log.debug("Config: Import: Scope: " + scope)
        if (!Config[scope]) {
          log.error("No such scope '" + scope + "'")
          continue
        }
        Config.build(Config[scope], root[scope])
      }
    }
    static markup(scope) {
      Config.scopes.push(scope)
    }
  }
    
  Config.import("webasto.conf")
  process.on('exit', Config.export.bind(null, "webasto.conf"));
  