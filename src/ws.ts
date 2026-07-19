import WebSocket from 'ws';
import type { WsFactory, WsLike } from '../../src/transport/local/LocalLanTransport';

/**
 * A Node WebSocket factory (using the `ws` package) matching the `WsLike` surface the
 * transport expects. On a browser/RN the transport uses the global WebSocket; on a
 * Homebridge host we inject this so the controller's `relay_protocol` subprotocol and
 * frame handling are solid.
 */
export const NodeWsFactory: WsFactory = (url, protocol) => {
  const socket = new WebSocket(url, protocol);
  const w: WsLike = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data: string) => socket.send(data),
    close: () => socket.close(),
  };
  socket.on('open', () => w.onopen?.());
  socket.on('message', (data: WebSocket.RawData) => w.onmessage?.({ data: data.toString() }));
  socket.on('error', (err: Error) => w.onerror?.(err));
  socket.on('close', () => w.onclose?.());
  return w;
};
