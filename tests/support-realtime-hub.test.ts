import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  SUPPORT_SESSION_REVOKED_CLOSE_CODE,
  SupportRealtimeHub,
} from '../src/modules/support/support-realtime.js';

function fakeSocket() {
  const socket = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn((code?: number) => {
      socket.readyState = WebSocket.CLOSING;
      return code;
    }),
    terminate: vi.fn(() => { socket.readyState = WebSocket.CLOSED; }),
  };
  return socket;
}

describe('SupportRealtimeHub pending authentication', () => {
  it('does not broadcast to a socket until its session revalidation promotes it', () => {
    const hub = new SupportRealtimeHub();
    const actor = { type: 'ADMIN' as const, id: 'admin-1' };
    const socket = fakeSocket();
    const registration = hub.registerPending(actor, 'session-1', socket as unknown as WebSocket);

    hub.send(actor, 'support.message.created', { secret: 'pending' });
    expect(socket.send).not.toHaveBeenCalled();
    expect(hub.connectedAdminIds()).toEqual([]);

    expect(registration.activate()).toBe(true);
    hub.send(actor, 'support.message.created', { visible: 'active' });
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(hub.connectedAdminIds()).toEqual(['admin-1']);
  });

  it('closes a revoked pending session and refuses to promote it', () => {
    const hub = new SupportRealtimeHub();
    const actor = { type: 'USER' as const, id: 'user-1' };
    const socket = fakeSocket();
    const registration = hub.registerPending(actor, 'session-1', socket as unknown as WebSocket);

    hub.closeSession(actor.type, 'session-1');

    expect(socket.close).toHaveBeenCalledWith(SUPPORT_SESSION_REVOKED_CLOSE_CODE, 'Session revoked');
    expect(registration.activate()).toBe(false);
    hub.send(actor, 'support.message.created', { secret: 'revoked' });
    expect(socket.send).not.toHaveBeenCalled();
  });
});
