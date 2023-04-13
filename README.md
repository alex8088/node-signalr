# node-signalr

A signalR client for node.js which support ASP.net but not ASP.net Core. For ASP.net Core signalR support use the offical client from Microsoft.

## Install

```bash
$ npm i node-signalr
```

## Usage

### Create a SignalR Client Instance

```ts
import signalr from 'node-signalr'

const client = new signalr.Client('http://localhost:8080/signalr', ['testHub'])
```

### Configuring Client

```js
// custom headers
client.headers['Token'] = 'Tds2dsJk'

// set timeout for sending message
client.callTimeout = 10000 // 10's, default 5000

// set delay time for reconecting
client.reconnectDelayTime = 2000 // 2's, default 5000

// set timeout for connect
client.requestTimeout = 2000 // 2's, default 5000
```

### Binding Client Events

```ts
client.on('connected', () => {
  console.log('SignalR client connected.')
})
client.on('reconnecting', (retryCount) => {
  console.log(`SignalR client reconnecting(${retryCount}).`)
})
client.on('disconnected', (reason) => {
  console.log(`SignalR client disconnected(${reason}).`)
})
client.on('error', (error) => {
  console.log(`SignalR client connect error: ${error.code}.`)
})
```

### Binding Hub Method

- Bind callback for receive message

```js
client.connection.hub.on('testHub', 'getMessage', (message) => {
  console.log('receive:', message)
})
```

- Call the hub method and get return values asynchronously

```ts
const message = { user: '', message: '' }

client.connection.hub
  .call('testHub', 'send', message)
  .then((result) => {
    console.log('success:', result)
  })
  .catch((error) => {
    console.log('error:', error)
  })
```

- Invoke the hub method without return values

```ts
const message = { user: '', message: '' }

client.connection.hub.invoke('testHub', 'send', message)
```

### Start Client

```ts
client.start()
```

### End Client

```ts
client.end()
```

## Powered By

- [ws](https://github.com/websockets/ws)

## License

[MIT](./LICENSE)
