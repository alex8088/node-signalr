const url = require('url')
const querystring = require('querystring')

const http = require('http')
const https = require('https')

const websocketClient = require('websocket').client

const util = require('util')
const events = require('events')

/**
 * A signalR client for node.js which support ASP.net but not ASP.net Core. 
 * For ASP.net Core signalR support use the offical client from Microsoft.
 */
class signalrClient {
  /**
   * @param {String} url 
   * @param {string[]} hubs 
   */
  constructor(url, hubs) {
    this.url = url
    this.headers = {}
    this.reconnectDelayTime = 5000
    this.requestTimeout = 5000
    this.keepaliveInterval = 5000
    this.keepalive = true
    this.callTimeout = 5000
    this.connection = {
      state: connectionState.disconnected,
      hub: new hub(this)
    }
    this._hubNames = hubs
    this._websocket = {
      client: null,
      connection: null,
      invocationId: 0
    }
    this._bound = false
    this._reconnectCount = 0
    this._reconnectTimer = null
  }

  _bind() {
    let client = this._websocket.client = new websocketClient({ keepaliveInterval: this.keepaliveInterval, keepalive: this.keepalive })
    client.on('connect', (connection) => {
      this._websocket.connection = connection
      this._websocket.invocationId = 0
      this._reconnectCount = 0
      connection.on('error', (error) => {
        this.connection.state = connectionState.disconnected
        this.emit('disconnected', 'error')
        this._reconnect()
      });
      connection.on('close', () => {
        this.connection.state = connectionState.disconnected
        this._websocket.connection = null
        if (this._end) {
          this.emit('disconnected', 'end')
          this._abort()
        }
      })
      connection.on('message', (message) => {
        if (message.type === 'utf8' && message.utf8Data != '{}' && !this._end) {
          let data = JSON.parse(message.utf8Data)
          if (data.M) {
            data.M.forEach((message) => {
              let hubName = message.H.toLowerCase()
              let handler = this.connection.hub.handlers[hubName]
              if (handler) {
                let methodName = message.M.toLowerCase()
                let method = handler[methodName]
                if (method) {
                  method.apply(this, message.A)
                }
              }
            })
          } else if (data.I) {
            this.connection.hub._handleCallback(+data.I, data.E, data.R)
          }
        }
      })
      this._start().then(() => {
        this.emit('connected')
        this.connection.state = connectionState.connected
      }).catch((error) => {
        this.connection.state = connectionState.disconnected
        connection.close()
        this._error(error.code, error.message)
      })
      this.connection.state = connectionState.connected
    })
    client.on('connectFailed', (error) => {
      this.connection.state = connectionState.disconnected
      this.emit('disconnected', 'failed')
      this._reconnect()
    })
    client.on('httpResponse', (response) => {
      this.connection.state = connectionState.disconnected
      if (response && response.statusCode === 401) {
        this._error(errorCode.unauthorized)
      } else {
        this._error(errorCode.connectError)
      }
    })
  }

  _sendMessage(hub, method, args) {
    let payload = JSON.stringify({
      H: hub,
      M: method,
      A: args,
      I: this._websocket.invocationId
    })
    ++this._websocket.invocationId
    if (this._websocket.connection) {
      if (this._websocket.connection.connected) {
        this._websocket.connection.send(payload, (err) => {
          if (err) console.log(err)
        })
      } else {
        this._error(errorCode.connectLost)
      }
    } else {
      this._error(errorCode.connectError)
    }
  }

  _negotiate() {
    return new Promise((resolve, reject) => {
      let query = querystring.stringify({
        connectionData: JSON.stringify(this._hubNames),
        clientProtocol: 1.5
      })
      let negotiateRequestOptions = url.parse(`${this.url}/negotiate?${query}`, true)
      negotiateRequestOptions.headers = this.headers
      if (negotiateRequestOptions.protocol === 'wss:') negotiateRequestOptions.protocol = 'https:'
      let timeoutTimer, req
      timeoutTimer = setTimeout(() => {
        req.abort()
        reject({ code: errorCode.negotiateError, message: 'ETIMEDOUT' })
      }, this.requestTimeout || 5000)
      req = this.request.get(negotiateRequestOptions, (res) => {
        clearTimeout(timeoutTimer)
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            if (res.statusCode == 200) {
              let negotiateProtocol = JSON.parse(data)
              if (!negotiateProtocol.TryWebSockets) {
                return reject({ code: errorCode.unsupportedWebsocket, message: null })
              }
              return resolve(negotiateProtocol)
            } else if (res.statusCode == 401 || res.statusCode == 302) {
              return reject({ code: errorCode.unauthorized, message: null })
            } else {
              return reject({ code: errorCode.negotiateError, message: res.statusCode })
            }
          } catch (e) {
            return reject({ code: errorCode.negotiateError, message: e })
          }
        })
        res.on('error', (e) => {
          return reject({ code: errorCode.negotiateError, message: e })
        })
      }).on('error', (e) => {
        clearTimeout(timeoutTimer)
        return reject({ code: errorCode.negotiateError, message: e })
      })
    })
  }

  _connect() {
    let query = querystring.stringify( {
      clientProtocol: 1.5,
      transport: "webSockets",
      connectionToken: this.connection.token,
      connectionData: JSON.stringify(this._hubNames),
      tid: 10
    })
    this._websocket.client.connect(`${this.url}/connect?${query}`, null, null, this.headers)
  }

  _reconnect(restart = false) {
    if (this._reconnectTimer || this.connection.state === connectionState.reconnecting) return
    this._reconnectTimer = setTimeout(() => {
      if (!this._end) {
        ++this._reconnectCount
        this.connection.state = connectionState.reconnecting
        this.emit('reconnecting', this._reconnectCount)
        restart ? this.start() : this._connect()
        this._reconnectTimer = null
      }
    }, this.reconnectDelayTime || 5000)
  }

  _start() {
    return new Promise((resolve, reject) => {
      let query = querystring.stringify({
        clientProtocol: 1.5,
        transport: "webSockets",
        connectionToken: this.connection.token,
        connectionData: JSON.stringify(this._hubNames)
      })
      let startRequestOptions = url.parse(`${this.url}/start?${query}`, true)
      startRequestOptions.headers = this.headers
      if (startRequestOptions.protocol === 'wss:') startRequestOptions.protocol = 'https:'
      let timeoutTimer, req
      timeoutTimer = setTimeout(() => {
        req.abort()
        reject({ code: errorCode.negotiateError, message: 'ETIMEDOUT' })
      }, this.requestTimeout || 5000)
      req = this.request.get(startRequestOptions, res => {
        clearTimeout(timeoutTimer)
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode == 200) {
            return resolve(data)
          } else if (res.statusCode == 401 || res.statusCode == 302) {
            return reject({ code: errorCode.unauthorized, message: null })
          } else {
            return reject({ code: errorCode.startError, message: res.statusCode })
          }
        })
        res.on('error', (e) => { 
          return reject({ code: errorCode.startError, message: e })
        })
      }).on('error', (e) => {
        clearTimeout(timeoutTimer)
        return reject({ code: errorCode.startError, message: e })
      })
    })
  }

  _abort() {
    return new Promise((resolve, reject) => {
      let query = querystring.stringify({
        clientProtocol: 1.5,
        transport: "serverSentEvents",
        connectionToken: this.connection.token,
        connectionData: JSON.stringify(this._hubNames)
      })
      let abortRequestOptions = url.parse(`${this.url}/abort?${query}`, true)
      abortRequestOptions = {
        hostname: abortRequestOptions.hostname,
        port: abortRequestOptions.port,
        method: 'POST',
        path: abortRequestOptions.path,
        headers: this.headers,
        protocol: abortRequestOptions.protocol === 'wss:' ? 'https:' : 'http:'
      }
      let req = this.request.request(abortRequestOptions, res => {
        res.on('data', (chunk) => { })
        res.on('end', () => { return resolve() })
        res.on('error', (e) => { return reject({ code: errorCode.abortError, message: e }) })
      }).on('error', (e) => {
        return reject({ code: errorCode.abortError, message: e })
      })
      req.end()
    })
  }

  _error(code, ex = null) {
    this.emit('error', code, ex)
    if (code === errorCode.negotiateError || code === errorCode.connectError) {
      this._reconnect(true)
    }
    if (code === errorCode.startError || code === errorCode.connectLost) {
      this._reconnect()
    }
  }

  start() {
    if (!this._bound) {
      if (!this.url) {
        this._error(errorCode.invalidURL)
        return
      }
      if (this.url.startsWith('http') || this.url.startsWith('wss')) {
        this.request = this.url.startsWith('http') ? http : https
      } else {
        this._error(errorCode.invalidProtocol)
        return
      }
      if (this._hubNames && this._hubNames.length > 0) {
        let hubNames = []
        this._hubNames.forEach(name => {
          hubNames.push({ name: name.toLowerCase() })
        })
        this._hubNames = hubNames
      } else {
        this._error(errorCode.noHub)
        return
      }
      this._bind()
      this._bound = true
    }
    this._end = false
    this._negotiate().then((negotiateProtocol) => {
      this.connection = {
        ...this.connection,
        id: negotiateProtocol.ConnectionId,
        token: negotiateProtocol.ConnectionToken
      }
      this._connect()
    }).catch((error) => {
      this.connection.state = connectionState.disconnected
      this._error(error.code, error.message)
    })
  }

  end() {
    this._end = true
    if (this._websocket.connection) this._websocket.connection.close()
  }
}

class hub {
  /**
   * @param {signalrClient} client
   */
  constructor(client) {
    this.client = client
    this.handlers = {}
    this.callbacks = {}
  }

  _handleCallback(invocationId, error, result) {
    let cb = this.callbacks[invocationId]
    if (cb) cb(error, result)
  }

  /**
   * Binding events receive messages 
   */
  on(hubName, methodName, cb) {
    let handler = this.handlers[hubName.toLowerCase()]
    if (!handler) {
      handler = this.handlers[hubName.toLowerCase()] = {}
    }
    handler[methodName.toLowerCase()] = cb
  }

  _processInvocationArgs(args) {
    let messages = []
    if (args.length > 2) {
      for (let i = 2; i < args.length; i++) {
        let arg = args[i]
        messages[i - 2] = (typeof arg === "function" || typeof arg === "undefined") ? null : arg
      }
    }
    return messages
  }

  /**
   * Call the hub method and get return values asynchronously
   */
  call(hubName, methodName) {
    return new Promise((resolve, reject) => {
      let messages = this._processInvocationArgs(arguments)
      let invocationId = this.client._websocket.invocationId
      let timeoutTimer = setTimeout(() => {
        delete this.callbacks[invocationId]
        return reject('Timeout')
      }, this.client.callTimeout || 5000)
      this.callbacks[invocationId] = (err, result) => {
        clearTimeout(timeoutTimer)
        delete this.callbacks[invocationId]
        return err ? reject(err) : resolve(result)
      }
      this.client._sendMessage(hubName, methodName, messages)
    })
  }

  /**
   * Invoke the hub method without return values
   */
  invoke(hubName, methodName) {
    let messages = this._processInvocationArgs(arguments)
    this.client._sendMessage(hubName, methodName, messages)
  }
}

const errorCode = {
  invalidURL: 'Invalid URL',
  invalidProtocol: 'Invalid protocol',
  noHub: 'No hub',
  unsupportedWebsocket: 'Websockets is not supported',
  unauthorized: 'Unauthorized',
  connectLost: 'Connect lost',
  negotiateError: 'Negotiate error',
  startError: 'Start error',
  connectError: 'Connect error',
  abortError: 'Abort error'
}

const connectionState = {
  connected: 1,
  reconnecting: 2,
  disconnected: 4
}

util.inherits(signalrClient, events.EventEmitter)

exports.client = signalrClient
exports.error = errorCode
exports.connectionState = connectionState
