import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { env } from '../../config/env.js';
import {
  ADMIN_COOKIE,
  getAdminSessionByToken,
  getUserSessionByToken,
  USER_COOKIE,
} from '../../infrastructure/sessions.js';
import { logger } from '../../infrastructure/logger.js';
import type { SupportActorType } from './support-schemas.js';

export type SupportRealtimeActor = {
  type: SupportActorType;
  id: string;
};

export type SupportRealtimeEvent<TPayload = unknown> = {
  type: string;
  payload: TPayload;
  sentAt: string;
};

const actorKey = (actor: SupportRealtimeActor) => `${actor.type}:${actor.id}`;
const sessionKey = (actorType: SupportActorType, sessionId: string) => `${actorType}:${sessionId}`;
export const MAX_SUPPORT_SOCKETS_PER_ACTOR = 5;
export const SUPPORT_SOCKET_LIMIT_CLOSE_CODE = 4008;
export const SUPPORT_SESSION_REVOKED_CLOSE_CODE = 4001;

export class SupportRealtimeHub {
  private readonly activeSockets = new Map<string, Set<WebSocket>>();
  private readonly registeredSockets = new Map<string, Set<WebSocket>>();
  private readonly sessionSockets = new Map<string, Set<WebSocket>>();

  registerPending(actor: SupportRealtimeActor, sessionId: string, socket: WebSocket) {
    const key = actorKey(actor);
    const registeredGroup = this.registeredSockets.get(key) ?? new Set<WebSocket>();
    for (const existing of registeredGroup) {
      if (existing.readyState === WebSocket.CLOSING || existing.readyState === WebSocket.CLOSED) registeredGroup.delete(existing);
    }
    if (registeredGroup.size >= MAX_SUPPORT_SOCKETS_PER_ACTOR) {
      const oldest = registeredGroup.values().next().value as WebSocket | undefined;
      if (oldest) {
        registeredGroup.delete(oldest);
        const activeGroup = this.activeSockets.get(key);
        activeGroup?.delete(oldest);
        if (activeGroup?.size === 0) this.activeSockets.delete(key);
        oldest.close(SUPPORT_SOCKET_LIMIT_CLOSE_CODE, 'Support socket limit exceeded');
      }
    }
    registeredGroup.add(socket);
    this.registeredSockets.set(key, registeredGroup);
    const authenticatedSessionKey = sessionKey(actor.type, sessionId);
    const sessionGroup = this.sessionSockets.get(authenticatedSessionKey) ?? new Set<WebSocket>();
    sessionGroup.add(socket);
    this.sessionSockets.set(authenticatedSessionKey, sessionGroup);
    let active = false;
    const unregister = () => {
      registeredGroup.delete(socket);
      if (registeredGroup.size === 0) this.registeredSockets.delete(key);
      const activeGroup = this.activeSockets.get(key);
      activeGroup?.delete(socket);
      if (activeGroup?.size === 0) this.activeSockets.delete(key);
      sessionGroup.delete(socket);
      if (sessionGroup.size === 0) this.sessionSockets.delete(authenticatedSessionKey);
    };
    return {
      activate: () => {
        if (active) return true;
        if (
          socket.readyState !== WebSocket.OPEN
          || !registeredGroup.has(socket)
          || !sessionGroup.has(socket)
        ) return false;
        const activeGroup = this.activeSockets.get(key) ?? new Set<WebSocket>();
        activeGroup.add(socket);
        this.activeSockets.set(key, activeGroup);
        active = true;
        return true;
      },
      unregister,
    };
  }

  send<TPayload>(actor: SupportRealtimeActor, type: string, payload: TPayload): void {
    const event: SupportRealtimeEvent<TPayload> = { type, payload, sentAt: new Date().toISOString() };
    const serialized = JSON.stringify(event);
    for (const socket of this.activeSockets.get(actorKey(actor)) ?? []) {
      if (socket.readyState === WebSocket.OPEN) socket.send(serialized);
    }
  }

  connectedAdminIds(): string[] {
    return [...this.activeSockets.keys()]
      .filter((key) => key.startsWith('ADMIN:'))
      .map((key) => key.slice('ADMIN:'.length));
  }

  closeSession(actorType: SupportActorType, sessionId: string): void {
    for (const socket of this.sessionSockets.get(sessionKey(actorType, sessionId)) ?? []) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(SUPPORT_SESSION_REVOKED_CLOSE_CODE, 'Session revoked');
      }
    }
  }

  closeAll(): void {
    for (const group of this.registeredSockets.values()) {
      for (const socket of group) socket.terminate();
    }
    this.activeSockets.clear();
    this.registeredSockets.clear();
    this.sessionSockets.clear();
  }
}

type AttachSupportWebSocketOptions = {
  hub: SupportRealtimeHub;
  getUnreadCount(actor: SupportRealtimeActor): Promise<number>;
};

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const raw = part.slice(separator + 1).trim();
    try {
      result[key] = decodeURIComponent(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
}

type AuthenticatedSocket = {
  actor: SupportRealtimeActor;
  sessionId: string;
  revalidate(): Promise<boolean>;
};

async function authenticateUpgrade(request: IncomingMessage, role: string | null): Promise<AuthenticatedSocket | null> {
  const cookies = parseCookies(request.headers.cookie);
  if (role === 'user') {
    const token = cookies[USER_COOKIE];
    const session = await getUserSessionByToken(token);
    return session ? {
      actor: { type: 'USER', id: session.user.id },
      sessionId: session.id,
      revalidate: async () => Boolean(await getUserSessionByToken(token)),
    } : null;
  }
  if (role === 'admin') {
    const token = cookies[ADMIN_COOKIE];
    const session = await getAdminSessionByToken(token, { touch: false });
    return session ? {
      actor: { type: 'ADMIN', id: session.admin.id },
      sessionId: session.id,
      revalidate: async () => Boolean(await getAdminSessionByToken(token, { touch: false })),
    } : null;
  }
  return null;
}

function handleClientMessage(socket: WebSocket, raw: RawData): void {
  const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (bytes.byteLength > 2_048) {
    socket.close(1009, 'Message too large');
    return;
  }
  try {
    const message = JSON.parse(bytes.toString('utf8')) as { type?: unknown };
    if (message.type === 'ping') {
      const event: SupportRealtimeEvent<Record<string, never>> = {
        type: 'pong',
        payload: {},
        sentAt: new Date().toISOString(),
      };
      socket.send(JSON.stringify(event));
      return;
    }
  } catch {
    // A protocol error below gives clients one consistent recovery path.
  }
  socket.send(JSON.stringify({
    type: 'protocol.error',
    payload: { code: 'UNSUPPORTED_MESSAGE', message: 'Only ping is accepted over this socket' },
    sentAt: new Date().toISOString(),
  } satisfies SupportRealtimeEvent));
}

export function attachSupportWebSocketServer(
  server: HttpServer,
  { hub, getUnreadCount }: AttachSupportWebSocketOptions,
) {
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 2_048 });
  const socketAlive = new WeakMap<WebSocket, boolean>();
  const heartbeatTimer = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (socketAlive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      socketAlive.set(socket, false);
      socket.ping();
    }
  }, 30_000);
  heartbeatTimer.unref();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/api/v2/support/ws') {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      const origin = request.headers.origin;
      if (origin && !env.frontendOrigins.includes(origin)) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      const role = url.searchParams.get('role');
      if (role !== 'user' && role !== 'admin') {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }
      const authentication = await authenticateUpgrade(request, role);
      if (!authentication) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      const { actor, sessionId } = authentication;

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        socketAlive.set(webSocket, true);
        webSocket.on('pong', () => socketAlive.set(webSocket, true));
        const registration = hub.registerPending(actor, sessionId, webSocket);
        let validationRunning = false;
        const sessionValidationTimer = setInterval(() => {
          if (validationRunning || webSocket.readyState !== WebSocket.OPEN) return;
          validationRunning = true;
          void authentication.revalidate()
            .then((valid) => {
              if (!valid) hub.closeSession(actor.type, sessionId);
            })
            .catch((error) => {
              logger.warn({ err: error, actorType: actor.type, actorId: actor.id }, 'Support websocket session validation failed');
              if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1011, 'Unable to validate session');
            })
            .finally(() => { validationRunning = false; });
        }, 60_000);
        sessionValidationTimer.unref();
        webSocket.once('close', () => {
          clearInterval(sessionValidationTimer);
          registration.unregister();
        });
        webSocket.on('error', (error) => logger.warn({ err: error, actorType: actor.type, actorId: actor.id }, 'Support websocket error'));
        webSocket.on('message', (raw) => handleClientMessage(webSocket, raw));
        void authentication.revalidate()
          .then(async (valid) => {
            if (!valid) {
              hub.closeSession(actor.type, sessionId);
              return;
            }
            if (!registration.activate()) return;
            const unreadCount = await getUnreadCount(actor);
            if (webSocket.readyState !== WebSocket.OPEN) return;
            webSocket.send(JSON.stringify({
              type: 'connection.ready',
              payload: { actorType: actor.type, actorId: actor.id, unreadCount },
              sentAt: new Date().toISOString(),
            } satisfies SupportRealtimeEvent));
          })
          .catch((error) => {
            logger.error({ err: error, actorType: actor.type, actorId: actor.id }, 'Unable to initialize support websocket');
            if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1011, 'Unable to initialize connection');
          });
      });
    })().catch((error) => {
      logger.warn({ err: error }, 'Support websocket upgrade failed');
      rejectUpgrade(socket, 500, 'Internal Server Error');
    });
  };

  server.on('upgrade', onUpgrade);

  return {
    close: () => new Promise<void>((resolve) => {
      server.off('upgrade', onUpgrade);
      clearInterval(heartbeatTimer);
      hub.closeAll();
      webSocketServer.close(() => resolve());
    }),
  };
}
