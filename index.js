const url = require('url')
const querystring = require('querystring')

const http = require('http')
const https = require('https')

const websocketClient = require('ws')

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
    this.qs = {}
    this.headers = {}
    this.agent = false
    this.reconnectDelayTime = 5000
    this.requestTimeout = 5000
    this.callTimeout = 5000
    this.connection = {
      state: connectionState.disconnected,
      hub: new hub(this),
      lastMessageAt: new Date().getTime()
    }
    this._bound = false
    this._websocket = undefined
    this._hubNames = hubs
    this._invocationId = 0
    this._callTimeout = 0
    this._keepAliveTimeout = 5000
    this._keepAlive = true
    this._beatInterval = 5000
    this._beatTimer = null
    this._reconnectCount = 0
    this._reconnectTimer = null
  }

  _receiveMessage(message) {
    this._markLastMessage()
    if (message.type === 'message' && message.data != '{}') {
      let data = JSON.parse(message.data)
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
  }

  _sendMessage(hub, method, args) {
    let payload = JSON.stringify({
      H: hub,
      M: method,
      A: args,
      I: this._invocationId
    })
    ++this._invocationId
    if (this._websocket && this._websocket.readyState === this._websocket.OPEN) {
      this._websocket.send(payload, (err) => {
        if (err) console.log(err)
      })
    }
  }

  _negotiate() {
    return new Promise((resolve, reject) => {
      let query = querystring.stringify({
        ...this.qs,
        connectionData: JSON.stringify(this._hubNames),
        clientProtocol: 1.5
      })
      let negotiateRequestOptions = url.parse(`${this.url}/negotiate?${query}`, true)
      negotiateRequestOptions.headers = this.headers
      negotiateRequestOptions.timeout = this.requestTimeout || 5000
      if (this.agent) negotiateRequestOptions.agent = this.agent
      let req = this.request.get(negotiateRequestOptions, (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            if (res.statusCode == 200) {
              let negotiateProtocol = JSON.parse(data)
              if (!negotiateProtocol.TryWebSockets) {
                reject({ code: errorCode.unsupportedWebsocket, message: null })
              }
              resolve(negotiateProtocol)
            } else if (res.statusCode == 401 || res.statusCode == 302) {
              reject({ code: errorCode.unauthorized, message: null })
            } else {
              reject({ code: errorCode.negotiateError, message: res.statusCode })
            }
          } catch (e) {
            reject({ code: errorCode.negotiateError, message: e })
          }
        })
        res.on('error', (e) => {
          reject({ code: errorCode.negotiateError, message: e })
        })
      })
      req.on('error', (e) => {
        if (req.aborted) return
        req = null
        reject({ code: errorCode.negotiateError, message: e })
      })
      req.on('timeout', () => {
        req.abort()
        reject({ code: errorCode.negotiateError, message: 'ETIMEDOUT' })
      })
    })
  }

  _connect() {
    let url = this.url.replace(/^http/, "ws")
    let query = querystring.stringify({
      ...this.qs,
      clientProtocol: 1.5,
      transport: "webSockets",
      connectionToken: this.connection.token,
      connectionData: JSON.stringify(this._hubNames),
      tid: 10
    })
    let ws = new websocketClient(`${url}/connect?${query}`, {
      handshakeTimeout: this.requestTimeout,
      headers: this.headers
    })
    ws.onopen = (event) => {
      this._invocationId = 0
      this._callTimeout = 0
      this._start().then(() => {
        this._reconnectCount = 0
        this.emit('connected')
        this.connection.state = connectionState.connected
        this._markLastMessage()
        if (this._keepAlive) this._beat()
      }).catch((error) => {
        this.connection.state = connectionState.disconnected
        this._error(error.code, error.message)
      })
    }
    ws.onerror = (event) => {
      this._error(errorCode.socketError, event.error)
    }
    ws.onmessage = (message) => {
      this._receiveMessage(message)
    }
    ws.onclose = (event) => {
      this._callTimeout = 1000
      this.connection.state = connectionState.disconnected
      this.emit('disconnected', 'failed')
      this._reconnect()
    }
    ws.on('unexpected-response', (request, response) => {
      this.connection.state = connectionState.disconnected
      if (response && response.statusCode === 401) {
        this._error(errorCode.unauthorized)
        this._clearBeatTimer()
        this._close()
        this.emit('disconnected', 'unauthorized')
      } else {
        this._error(errorCode.connectError)
      }
    })
    this._websocket = ws
  }

  _reconnect(restart = false) {
    if (this._reconnectTimer || this.connection.state === connectionState.reconnecting) return
    this._clearBeatTimer()
    this._close()
    this._reconnectTimer = setTimeout(() => {
      ++this._reconnectCount
      this.connection.state = connectionState.reconnecting
      this.emit('reconnecting', this._reconnectCount)
      restart ? this.start() : this._connect()
      this._reconnectTimer = null
    }, this.reconnectDelayTime || 5000)
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  _beat() {
    let timeElapsed = new Date().getTime() - this.connection.lastMessageAt
    if (timeElapsed > this._keepAliveTimeout) {
      this.connection.state = connectionState.disconnected
      this._error(errorCode.connectLost)
    } else {
      this._beatTimer = setTimeout(() => {
        this._beat()
      }, this._beatInterval)
    }
  }

  _clearBeatTimer() {
    if (this._beatTimer) {
      clearTimeout(this._beatTimer)
      this._beatTimer = null
    }
  }

  _markLastMessage() {
    this.connection.lastMessageAt = new Date().getTime()
  }

  _start() {
    return new Promise((resolve, reject) => {
      let query = querystring.stringify({
        ...this.qs,
        clientProtocol: 1.5,
        transport: "webSockets",
        connectionToken: this.connection.token,
        connectionData: JSON.stringify(this._hubNames)
      })
      let startRequestOptions = url.parse(`${this.url}/start?${query}`, true)
      startRequestOptions.headers = this.headers
      startRequestOptions.timeout = this.requestTimeout || 5000
      if (this.agent) startRequestOptions.agent = this.agent
      let req = this.request.get(startRequestOptions, res => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode == 200) {
            resolve(data)
          } else if (res.statusCode == 401 || res.statusCode == 302) {
            reject({ code: errorCode.unauthorized, message: null })
          } else {
            reject({ code: errorCode.startError, message: res.statusCode })
          }
        })
        res.on('error', (e) => {
          reject({ code: errorCode.startError, message: e })
        })
      })
      req.on('error', (e) => {
        if (req.aborted) return
        req = null
        reject({ code: errorCode.startError, message: e })
      })
      req.on('timeout', () => {
        req.abort()
        reject({ code: errorCode.startError, message: 'ETIMEDOUT' })
      })
    })
  }

  _abort() {
    return new Promise((resolve, reject) => {
      let query = querystring.stringify({
        ...this.qs,
        clientProtocol: 1.5,
        transport: "webSockets",
        connectionToken: this.connection.token,
        connectionData: JSON.stringify(this._hubNames)
      })
      let abortRequestOptions = url.parse(`${this.url}/abort?${query}`, true)
      abortRequestOptions.method = 'POST'
      abortRequestOptions.headers = this.headers
      abortRequestOptions.timeout = this.requestTimeout || 5000
      if (this.agent) abortRequestOptions.agent = this.agent
      let req = this.request.request(abortRequestOptions, res => {
        res.on('data', (chunk) => { })
        res.on('end', () => { resolve() })
        res.on('error', (e) => { reject({ code: errorCode.abortError, message: e }) })
      })
      req.on('error', (e) => { reject({ code: errorCode.abortError, message: e }) })
      req.write('')
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

  _close() {
    if (this._websocket) {
      this._websocket.onclose = () => { }
      this._websocket.onmessage = () => { }
      this._websocket.onerror = () => { }
      this._websocket.close()
      this._websocket = undefined
    }
  }

  start() {
    if (!this._bound) {
      if (!this.url) {
        this._error(errorCode.invalidURL)
        return
      }
      if (this.url.startsWith('http:') || this.url.startsWith('https:')) {
        let _url = url.parse(this.url)
        this.request = _url.protocol === 'https:' ? https : http
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
      this._bound = true
    }
    this._negotiate().then((negotiateProtocol) => {
      this.connection = {
        ...this.connection,
        id: negotiateProtocol.ConnectionId,
        token: negotiateProtocol.ConnectionToken
      }
      if (negotiateProtocol.KeepAliveTimeout) {
        this._keepAlive = true
        this._keepAliveTimeout = negotiateProtocol.KeepAliveTimeout * 1000
        this._beatInterval = this._keepAliveTimeout / 4
      } else {
        this._keepAlive = false
      }
      this._connect()
    }).catch((error) => {
      this.connection.state = connectionState.disconnected
      this._error(error.code, error.message)
    })
  }

  end() {
    if (this._websocket) {
      this.emit('disconnected', 'end')
      this._abort().catch((e) => {
        console.log(e.code)
        // this._error(e.code, e.message)
      })
    }
    this._clearReconnectTimer()
    this._clearBeatTimer()
    this._close()
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
      let invocationId = this.client._invocationId
      let timeoutTimer = setTimeout(() => {
        delete this.callbacks[invocationId]
        reject('Timeout')
      }, this.client._callTimeout || this.client.callTimeout || 5000)
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
  socketError: 'Socket error',
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
