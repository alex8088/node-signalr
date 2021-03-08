interface Client {
    new(url: string, hubs: string[]): this

    url: string
    qs: Qs
    headers: Headers
    reconnectDelayTime: number
    requestTimeout: number
    callTimeout: number
    connection: Connection

    on(event: 'connected', listener: (name: string) => void): this

    on(event: 'reconnecting', listener: (count: number) => void): this

    on(event: 'disconnected', listener: (reason: string) => void): this

    on(event: 'error', listener: (code: string, ex?: any) => void): this

    start()

    end()
}

type Hub = {
    new(client: Client)

    call(hubName: string, methodName: string, ...args: string[])
    on(event: string, hubName: string, listener: (message: string) => void): Hub
    invoke(hubName: string, methodName: string, message: string)

}

declare enum ConnectionState {
    Connected = 1,
    Reconnecting = 2,
    Disconnected = 4,
}

type ErrorMessages = {
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
};

type Connection = {
    state: ConnectionState,
    hub: Hub,
    lastMessageAt: number
}

interface Headers {
    [key: string]: string
}

interface Qs {
    [key: string]: string
}

export declare const client: Client
export declare const error: ErrorMessages
export declare const connectionState: {
    connected: 1,
    reconnecting: 2,
    disconnected: 4
}
