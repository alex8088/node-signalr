# node-signalr

A signalR client for node.js which support ASP.net but not ASP.net Core. For ASP.net Core signalR support use the offical client from Microsoft.

## Installation

```bash
$ npm install node-signalr
```

## Usage

### Create a instance of signalR client

```js
const signalr = require('node-signalr')

let client = new signalr.client('http://localhost:8080/signalr', ['testHub'])
```

### Configure client

```js
// custom headers
client.headers['Token'] ='Tds2dsJk'

// set timeout for sending message 
client.callTimeout = 10000 // 10's, default 5000

// set delay time for reconecting
client.reconnectDelayTime = 2000 // 2's, default 5000

// set timeout for connect 
client.requestTimeout = 2000 // 2's, default 5000
```

### Binding client events

```js
client.on('connected', () => {
  console.log('SignalR client connected.')
})
client.on('reconnecting', (count) => {
  console.log(`SignalR client reconnecting(${count}).`)
})
client.on('disconnected', (code) => {
  console.log(`SignalR client disconnected(${code}).`)
})
client.on('error', (code, ex) => {
  console.log(`SignalR client connect error: ${code}.`)
})
```

### Binding hub method

- Bind callback for receive message
  
```js
client.connection.hub.on('testHub', 'getMessage', (message) => {
  console.log('receive:', message)
})
```

- Call the hub method and get return values asynchronously 

```js
client.connection.hub.call('testHub', 'send', message).then((result) => {
  console.log('success:', result)
}).catch((error) => {
  console.log('error:', error)
})
```

- Invoke the hub method without return values 

```js
client.connection.hub.invoke('testHub', 'send', message)
```

### Start client

```js
client.start()
```

### End client

```js
client.end()
```

## Powered By

- [WebSocket-Node](https://github.com/theturtle32/WebSocket-Node)

## License

[MIT](./LICENSE)